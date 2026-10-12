import { execFileSync } from "node:child_process";

/*
FNXC:WindowsShell 2026-10-07-18:03:
Source scanners must list the same files on every platform. A shell-string `git ls-files '<glob>'` through execSync runs cmd.exe on Windows, which keeps the single quotes, so git matched nothing and each scanner failed closed with "file list is EMPTY".
Pass pathspecs as argv so git, not a shell, interprets the globs. Tracked plus untracked non-ignored files are listed, so a new file counts before it is committed; a path listed by both --cached and --others appears once.
*/

// FNXC:SourceFileListing 2026-10-12-06:14:
// A gate's file list contains every file under each of its roots that ends with one of its extensions, direct children of a root included, and the list is the same on every platform.
// A caller declares a scope, `{ roots, extensions }`, and this module builds the pathspecs, so no caller can write a pathspec that skips a directory level.
// Each pathspec is `:(glob)<root>/**/*<extension>`. Without the `glob` magic git matches a pathspec with fnmatch and no FNM_PATHNAME, so `*` also matches `/`: a root such as `packages/*/src` then matches `packages/a/b/src`, and `<root>/**/*.ts` requires a directory between the root and the file, which omits the root's direct children. With `glob`, `*` stays inside one path segment and `/**/` matches zero or more directories.
// A scope that yields no pathspec is refused, because `git ls-files` without a pathspec lists the whole repository.
// (Line comments, because the globs quoted here contain the block-comment terminator.)

/**
 * @typedef {{ roots: readonly string[], extensions: readonly string[] }} SourceScope
 * `roots` are directory globs in which `*` matches one path segment; `extensions` are file-name suffixes such as `.ts`.
 */

function scopePathspecs(scope) {
  const roots = scope?.roots;
  const extensions = scope?.extensions;
  if (!Array.isArray(roots) || !Array.isArray(extensions) || roots.length === 0 || extensions.length === 0) {
    throw new TypeError("listGitSourceFiles: the scope must be { roots, extensions } with at least one root and one extension");
  }
  return roots.flatMap((root) => extensions.map((extension) => `:(glob)${root}/**/*${extension}`));
}

/**
 * @param {SourceScope} scope
 * @param {{ cwd?: string, exec?: typeof execFileSync }} [options]
 * @returns {string[]} repo-relative, forward-slash paths in git order, deduplicated
 */
export function listGitSourceFiles(scope, { cwd = process.cwd(), exec = execFileSync } = {}) {
  const pathspecs = scopePathspecs(scope);
  const output = exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").map((file) => file.trim()).filter(Boolean))];
}

/** False for a file under a `__tests__` directory and for a `.test` or `.spec` TypeScript file; the gates scan production sources only. */
export function isProductionSourceFile(file) {
  return !file.includes("__tests__") && !/\.(test|spec)\.tsx?$/.test(file);
}

/**
 * @param {SourceScope} scope
 * @param {{ cwd?: string, exec?: typeof execFileSync }} [options]
 * @returns {string[]} the files of {@link listGitSourceFiles} that are production sources
 */
export function listProductionSourceFiles(scope, options) {
  return listGitSourceFiles(scope, options).filter(isProductionSourceFile);
}
