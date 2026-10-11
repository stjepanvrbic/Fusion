import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listZipEntries, readZipEntry, ZIP_SIZE_LIMIT_MESSAGE } from "./bounded-zip-reader.js";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 32;
const TIMEOUT_MS = 30_000;
type Run = (binary: string, args: string[], options: {
  cwd: string; encoding: "buffer"; timeout: number; maxBuffer: number; signal?: AbortSignal;
}) => Promise<{ stdout: Buffer }>;

/*
FNXC:PostMergeEvidence 2026-10-11-04:34:
A host without a required inspection binary must be distinguishable from unavailable evidence, so the reviewer and operator see which tool to install instead of concluding the evidence is missing.
Only a spawn ENOENT names a missing tool; a file-level ENOENT is ordinary evidence failure.
*/
/** A required inspection program is not installed or not on PATH on this host. */
export class InspectionToolMissingError extends Error {
  constructor(readonly tool: string) {
    super(`Inspection tool \`${tool}\` is not installed or not on PATH on this host.`);
    this.name = "InspectionToolMissingError";
  }
}

/** Convert a spawn ENOENT for `tool` into {@link InspectionToolMissingError}; return any other error unchanged. */
export function asInspectionToolMissingError(error: unknown, tool: string): unknown {
  const failure = error as { code?: unknown; syscall?: unknown } | null;
  return failure?.code === "ENOENT" && typeof failure.syscall === "string" && failure.syscall.startsWith("spawn")
    ? new InspectionToolMissingError(tool)
    : error;
}

/** Reject option/glob ambiguity and traversal as well as names that are not valid UTF-8. */
function isUnsupportedEntryName(name: string | null): boolean {
  return name === null || name.startsWith("/") || name.startsWith("-") || name.includes("\\")
    || name.split("/").includes("..")
    || [...name].some((character) => character.charCodeAt(0) < 32 || "*?[]".includes(character));
}

/** Read a bounded artifact archive in memory; only `gh` is spawned and nothing is written to disk. */
export async function readPostMergeArtifact(
  input: { repository: string; artifactId: number; cwd: string; signal?: AbortSignal },
  run: Run = execFileAsync,
): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.repository)
    || !Number.isSafeInteger(input.artifactId) || input.artifactId < 1) {
    throw new Error("Use a GitHub owner/repository and a positive artifact ID.");
  }
  const deadline = Date.now() + TIMEOUT_MS;
  const checkDeadline = (): number => {
    input.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Artifact inspection timed out.");
    return remaining;
  };
  let archive: Buffer;
  try {
    ({ stdout: archive } = await run("gh", ["api", "--method", "GET", `repos/${input.repository}/actions/artifacts/${input.artifactId}/zip`], {
      cwd: input.cwd, encoding: "buffer", timeout: checkDeadline(), maxBuffer: MAX_BYTES, signal: input.signal,
    }));
  } catch (error) {
    throw asInspectionToolMissingError(error, "gh");
  }
  if (archive.length > MAX_BYTES) throw new Error(ZIP_SIZE_LIMIT_MESSAGE);
  const entries = listZipEntries(archive, { maxEntries: MAX_ENTRIES });
  if (entries.some((entry) => isUnsupportedEntryName(entry.name))) {
    throw new Error("Artifact contains an unsupported entry name.");
  }
  const output: Buffer[] = [];
  let remainingBytes = MAX_BYTES;
  for (const entry of entries) {
    const name = entry.name!;
    if (name.endsWith("/")) continue;
    checkDeadline();
    const heading = Buffer.from(`\n--- ${name} ---\n`);
    remainingBytes -= heading.length;
    if (remainingBytes <= 0) throw new Error(ZIP_SIZE_LIMIT_MESSAGE);
    const content = await readZipEntry(archive, entry, remainingBytes);
    remainingBytes -= content.length;
    output.push(heading, content);
  }
  return Buffer.concat(output).toString("utf8");
}
