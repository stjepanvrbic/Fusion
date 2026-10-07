import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/*
FNXC:ReleaseScript 2026-10-07-19:30:
The release commit may contain only what the release generated: workspace and package manifests, their changelogs, the root changelogs, changesets and the lockfile.
The primary checkout is shared with Fusion agents and the merger, so anything else found dirty at commit time came from another writer and must stop the release, not be swept into it.
*/

/**
 * Parse `git status --porcelain=v1 -z` output into repo-relative paths. Renames yield both destination and source.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function parsePorcelainPaths(output) {
  const entries = output.split("\0");
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") {
      const source = entries[index + 1];
      if (source) paths.push(source);
      index += 1;
    }
  }
  return paths;
}

/**
 * @param {string[]} workspaceDirs Repo-relative workspace package directories.
 * @returns {(path: string) => boolean}
 */
export function releaseGeneratedPathMatcher(workspaceDirs) {
  const packageFiles = new Set();
  for (const dir of workspaceDirs) {
    packageFiles.add(`${dir}/package.json`);
    packageFiles.add(`${dir}/CHANGELOG.md`);
  }
  const rootFiles = new Set(["package.json", "pnpm-lock.yaml", "CHANGELOG.md", "CHANGELOG-archive.md"]);
  return (path) => rootFiles.has(path) || path.startsWith(".changeset/") || packageFiles.has(path);
}

function readBytes(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function sameBytes(a, b) {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

/*
FNXC:ReleaseScript 2026-10-07-19:30:
Pre-mode entry or exit and stale-cycle version rewrites happen before the operator confirms.
Every exit before confirmation (decline, failed plan, dry run, error, interrupt) must put those inputs back byte for byte, but a file someone else changed after the release wrote it is left as they wrote it.
*/

/**
 * Capture the bytes of `paths` before the release mutates them.
 * `seal()` records what the release wrote; `restore()` reverts only files still holding that content.
 *
 * @param {string[]} paths
 */
export function createReleaseInputSnapshot(paths) {
  const originals = new Map(paths.map((path) => [path, readBytes(path)]));
  let written = null;
  let restoredOnce = false;

  return {
    seal() {
      written = new Map(paths.map((path) => [path, readBytes(path)]));
    },
    restore() {
      const result = { restored: [], keptConcurrentEdits: [] };
      if (restoredOnce) return result;
      restoredOnce = true;
      for (const [path, original] of originals) {
        const current = readBytes(path);
        if (sameBytes(current, original)) continue;
        const releaseWrote = written ? written.get(path) : current;
        if (!sameBytes(current, releaseWrote)) {
          result.keptConcurrentEdits.push(path);
          continue;
        }
        if (original === null) unlinkSync(path);
        else writeFileSync(path, original);
        result.restored.push(path);
      }
      return result;
    },
  };
}
