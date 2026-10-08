/*
FNXC:PathIdentity 2026-10-08-16:08:
KB-082: the executor's session-worktree canonicalizer must return the native long spelling git reports, so a worktree or repo root spelled with a Windows 8.3 short alias is recognized by liveness and invariant checks.
It must never throw for an absent path.
*/
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizePath } from "../executor/session-worktree-paths.js";
import { hasDistinctShortAlias, nativeRealPath, realTempDir, win32ShortAlias } from "./helpers/real-path.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session-worktree-paths canonicalizePath", () => {
  it.runIf(process.platform === "win32")("expands a win32 8.3 short alias to the native long spelling", () => {
    const dir = realTempDir("kb082-session-worktree-");
    created.push(dir);
    const shortAlias = win32ShortAlias(dir);
    if (hasDistinctShortAlias(dir)) expect(shortAlias).not.toBe(dir);
    expect(canonicalizePath(shortAlias)).toBe(nativeRealPath(dir));
    expect(canonicalizePath(join(shortAlias, "absent-child"))).toBe(join(nativeRealPath(dir), "absent-child"));
  });

  it("returns the resolved form of an absent path without throwing", () => {
    const dir = realTempDir("kb082-session-worktree-absent-");
    created.push(dir);
    const absent = join(dir, "missing", "leaf");
    expect(() => canonicalizePath(absent)).not.toThrow();
    expect(canonicalizePath(absent)).toBe(resolve(nativeRealPath(dir), "missing", "leaf"));
  });
});
