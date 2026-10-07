import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MergeDetails, Settings, Task, TaskStore } from "@fusion/core";
import { isMergeAbortedError, type MergeWriteFence } from "./merge-write-fence.js";

const execFileAsync = promisify(execFile);
const PROBE_DEADLINE_MS = 10_000;

export type GitRun = (args: string[], cwd: string, timeout: number, signal?: AbortSignal) => Promise<string>;

export const runGit: GitRun = async (args, cwd, timeout, signal) => (await execFileAsync("git", args, {
  cwd, timeout, signal, maxBuffer: 1024 * 1024, encoding: "utf8",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
})).stdout.trim();

export type ConfirmedMergePushTarget = {
  /** Local integration branch the landed commit is recorded on. */
  branch: string;
  remote: string;
  /** Remote branch name; `settings.pushRemote` may name one after the remote. */
  targetBranch: string;
  /** `<remote>/<targetBranch>`. */
  target: string;
};

/**
 * FNXC:PostMergePublication 2026-10-07-13:00:
 * Single remote/branch resolution for confirmed-merge delivery: push recovery and the post-merge
 * publication precondition must agree on where the landed commit has to be. Only configured remote
 * names are accepted, never URLs, options, or shell expressions.
 */
export function resolveConfirmedMergePushTarget(
  details: Pick<MergeDetails, "mergeTargetBranch">,
  settings: Pick<Settings, "pushRemote">,
): ConfirmedMergePushTarget | undefined {
  const branch = details.mergeTargetBranch;
  if (!branch) return undefined;
  const [remote = "origin", ...targetParts] = (settings.pushRemote?.trim() || "origin").split(/\s+/);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) return undefined;
  const targetBranch = targetParts.join(" ") || branch;
  return { branch, remote, targetBranch, target: `${remote}/${targetBranch}` };
}

/**
 * Whether the remote branch tip is, or contains, `sha`. Transport failures of `ls-remote`/`fetch`
 * propagate; a failed ancestry check means "not contained" (a non-force push then decides).
 */
export async function isCommitOnRemoteBranch(
  git: (args: string[]) => Promise<string>,
  remote: string,
  targetBranch: string,
  sha: string,
): Promise<boolean> {
  const advertised = await git(["ls-remote", "--heads", remote, `refs/heads/${targetBranch}`]);
  const remoteSha = advertised.split(/\s+/)[0];
  if (remoteSha === sha) return true;
  if (!/^[a-f0-9]{40,64}$/i.test(remoteSha)) return false;
  // A newer remote tip may already contain this task; fetch only when its object is missing locally.
  try {
    await git(["cat-file", "-e", `${remoteSha}^{commit}`]);
  } catch {
    await git(["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/heads/${targetBranch}`]);
  }
  try {
    await git(["merge-base", "--is-ancestor", sha, remoteSha]);
    return true;
  } catch {
    return false;
  }
}

/** A commit's change with blob ids and hunk positions removed, so a rebased copy of the same change compares equal. */
async function normalizedChange(git: (args: string[]) => Promise<string>, sha: string): Promise<string> {
  const patch = await git(["diff-tree", "-p", "-r", "--no-color", "--no-ext-diff", "--no-renames", "--format=", sha]);
  return patch.split(/\r?\n/).filter((line) => !line.startsWith("index ") && !line.startsWith("@@")).join("\n");
}

/**
 * FNXC:PostMergePublication 2026-10-07-21:05:
 * A push-divergence rebase republishes every unpublished landing as a rewritten commit, but only the pushing task's
 * record was refreshed, so earlier landings waited forever for SHAs that are on neither the branch nor the remote.
 * Returns the rewrite of `oldSha` on `branch`: the single commit not reachable from `oldSha` that carries this task's
 * Fusion-Task-Id trailer and the identical change. Anything else (still on the branch, gone, no match, ambiguous) is
 * undefined, so attribution is never guessed and never moved to the branch tip.
 */
export async function findRewrittenLandedCommit(
  git: (args: string[]) => Promise<string>,
  taskId: string,
  oldSha: string,
  branch: string,
): Promise<string | undefined> {
  const branchRef = `refs/heads/${branch}`;
  if (await git(["merge-base", "--is-ancestor", oldSha, branchRef]).then(() => true, () => false)) return undefined;
  const oldChange = await normalizedChange(git, oldSha);
  const candidates = (await git([
    "rev-list", "-n", "200", "--fixed-strings", `--grep=Fusion-Task-Id: ${taskId}`, branchRef, `^${oldSha}`,
  ])).split(/\s+/).filter(Boolean);
  const matches: string[] = [];
  for (const candidate of candidates) {
    const trailers = await git(["log", "-1", "--format=%(trailers:key=Fusion-Task-Id,valueonly)", candidate]);
    if (!trailers.split(/\r?\n/).map((value) => value.trim()).includes(taskId)) continue;
    if (await normalizedChange(git, candidate) === oldChange) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Re-points a confirmed landing whose recorded commit was rewritten off its branch, compare-and-swapped on the old SHA.
 * Returns the updated task, or undefined when nothing was rewritten or another writer changed the record first.
 */
export async function reconcileRewrittenLandedCommit(
  store: Pick<TaskStore, "rootDir" | "updateTaskAtomic" | "logEntry">,
  task: Pick<Task, "id" | "mergeDetails">,
  options: { run?: GitRun; fence?: MergeWriteFence } = {},
): Promise<Task | undefined> {
  const details = task.mergeDetails;
  const oldSha = details?.commitSha ?? "";
  const rootDir = store.rootDir;
  if (!details?.mergeConfirmed || !details.mergeTargetBranch || !rootDir || !/^[a-f0-9]{40,64}$/i.test(oldSha)) return undefined;
  const run = options.run ?? runGit;
  const deadline = Date.now() + PROBE_DEADLINE_MS;
  const git = (args: string[]) => {
    options.fence?.assertOwned();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Rewritten landing lookup timed out.");
    const signal = options.fence?.signal;
    return signal ? run(args, rootDir, remaining, signal) : run(args, rootDir, remaining);
  };
  let newSha: string | undefined;
  try {
    newSha = await findRewrittenLandedCommit(git, task.id, oldSha, details.mergeTargetBranch);
  } catch (error) {
    if (isMergeAbortedError(error)) throw error;
    return undefined;
  }
  if (!newSha) return undefined;
  const rewrittenSha = newSha;
  const write = () => store.updateTaskAtomic(task.id, (live) => live.mergeDetails?.mergeConfirmed && live.mergeDetails.commitSha === oldSha
    ? { mergeDetails: { ...live.mergeDetails, commitSha: rewrittenSha } }
    : null);
  const updated = options.fence ? await options.fence.write("finalization", write) : await write();
  if (updated?.mergeDetails?.commitSha !== rewrittenSha) return undefined;
  const log = () => store.logEntry(task.id, `[post-merge] Landed commit ${oldSha.slice(0, 12)} was rewritten to ${rewrittenSha.slice(0, 12)} by a push-divergence rebase on ${details.mergeTargetBranch}; the recorded landing now points at the rewrite.`);
  if (options.fence) await options.fence.write("log", log); else await log();
  return updated;
}

export type LandedCommitPublication =
  | { state: "published"; sha: string; target: ConfirmedMergePushTarget }
  | { state: "unpublished"; sha: string; target: ConfirmedMergePushTarget }
  | { state: "unknown"; sha: string; target?: ConfirmedMergePushTarget };

/**
 * FNXC:PostMergePublication 2026-10-07-13:00:
 * Read-only probe of whether a confirmed landing is on the push remote. "unknown" (no repository,
 * unresolvable target, unreachable remote, git error) is deliberately distinct from "unpublished":
 * only a successful remote read may conclude the commit is absent.
 */
export async function probeLandedCommitPublication(
  store: Pick<TaskStore, "rootDir">,
  task: Pick<Task, "mergeDetails">,
  settings: Pick<Settings, "pushRemote">,
  options: { run?: GitRun; fence?: MergeWriteFence } = {},
): Promise<LandedCommitPublication> {
  const sha = task.mergeDetails?.commitSha ?? "";
  const target = task.mergeDetails ? resolveConfirmedMergePushTarget(task.mergeDetails, settings) : undefined;
  const rootDir = store.rootDir;
  if (!target || !rootDir || !/^[a-f0-9]{40,64}$/i.test(sha)) return { state: "unknown", sha, target };
  const run = options.run ?? runGit;
  const deadline = Date.now() + PROBE_DEADLINE_MS;
  const git = (args: string[]) => {
    options.fence?.assertOwned();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Remote publication probe timed out.");
    const signal = options.fence?.signal;
    return signal ? run(args, rootDir, remaining, signal) : run(args, rootDir, remaining);
  };
  try {
    await git(["check-ref-format", `refs/heads/${target.targetBranch}`]);
    const published = await isCommitOnRemoteBranch(git, target.remote, target.targetBranch, sha);
    return { state: published ? "published" : "unpublished", sha, target };
  } catch (error) {
    if (isMergeAbortedError(error)) throw error;
    return { state: "unknown", sha, target };
  }
}
