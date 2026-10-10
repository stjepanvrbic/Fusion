import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionBoundaryDescriptor } from "../agents/agent-runtime.js";
import {
  extractMissingWorktreePathFromSessionStartFailure,
  isMissingWorktreeSessionStartFailure,
} from "../healing/restart-recovery-coordinator.js";
import { assertSessionBoundaryRoot } from "../pi.js";

/*
FNXC:WorktreeSessionRecovery 2026-10-10-17:21:
Symptom: a planning session whose task worktree was removed after acquisition failed with
"Refusing to start declared task-worktree session: boundary root is missing", a message no
missing-worktree recovery classifier recognised, so every declared-boundary lane (planning,
executor, review gates) spent its generic retry budget instead of re-acquiring the checkout.
Invariant: for every declared boundary kind, a missing session root is refused with the canonical
missing-worktree session-start failure naming that root, so the shared recovery re-acquires it.
*/

const projectRoot = tmpdir();
const missingRoot = join(tmpdir(), "fusion-session-boundary-missing-root-never-created");

async function refusal(cwd: string, descriptor: SessionBoundaryDescriptor): Promise<string> {
  try {
    await assertSessionBoundaryRoot(cwd, descriptor);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the session start to be refused");
}

describe("declared session boundary with a missing root", () => {
  const cases: Array<[string, SessionBoundaryDescriptor]> = [
    ["task-worktree", { kind: "task-worktree", writableRoot: missingRoot, projectRoot }],
    ["workspace-task-dir", {
      kind: "workspace-task-dir",
      writableRoot: missingRoot,
      projectRoot,
      repoRoots: [{ repoRelPath: "app", repoRootDir: projectRoot }],
    }],
    ["read-only-root", { kind: "read-only-root", writableRoot: null, projectRoot }],
  ];

  it.each(cases)("%s refusal is a recoverable missing-worktree session-start failure naming the root", async (_kind, descriptor) => {
    const message = await refusal(missingRoot, descriptor);

    expect(isMissingWorktreeSessionStartFailure(message)).toBe(true);
    expect(extractMissingWorktreePathFromSessionStartFailure(message)).toBe(missingRoot);
  });

  it("refuses a missing project root without classifying it as a lost task worktree", async () => {
    const message = await refusal(projectRoot, {
      kind: "task-worktree",
      writableRoot: projectRoot,
      projectRoot: missingRoot,
    });

    expect(isMissingWorktreeSessionStartFailure(message)).toBe(false);
  });
});
