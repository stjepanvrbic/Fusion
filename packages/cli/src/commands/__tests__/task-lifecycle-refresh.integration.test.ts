import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    // The fixture's origin is a local bare repository; the production adapters
    // still need a GitHub repository identity to exercise their GitHub boundary.
    getCurrentRepo: vi.fn(() => ({ owner: "fixture-owner", repo: "fixture-repo" })),
    getPushRepo: vi.fn(() => ({ owner: "fixture-owner", repo: "fixture-repo" })),
  };
});

import {
  createGroupPrCallback,
  createPrNodeGithubOps,
  processPullRequestMergeTask,
  refreshAutomatedPrHead,
} from "../task-lifecycle.js";

const fixtures: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/*
FNXC:CliTests 2026-10-08-15:30:
KB-061: every case used to build its own ~25-spawn git fixture (bare remote, two clones, commits, pushes), and on Windows process spawn cost alone pushed cases past vitest's 5 s default.
The base fixture is now built ONCE per file as a template and each case gets a recursive copy, so per-case cost is one copy plus the git work the case itself asserts on.
Copies are isolated: each clone's origin URL is rewritten to the copy's own bare remote, so a case can never touch the template or another case's remote.
Background gc/maintenance is disabled in the template repositories so no git call forks maintenance work.

FNXC:CliTests 2026-10-08-19:20:
KB-091: the one-time template build still spawned about 25 git processes, two clones and two pushes among them, each starting its own upload-pack/receive-pack transport.
On the GitHub Windows runner (one worker) that exceeded the 10 s beforeAll hook budget and lost every case in the file.
The template is now built with local plumbing only: three `git init`, one `git fast-import` per repository from a shared stream with a fixed identity and timestamp (so base, feature and sentinel have the same SHAs in every repository), config written with fs, and one `git reset --hard` per working repository.
No clone or push transport runs, and the hook timeout is unchanged.
The "template matches the clone/push fixture topology" case pins the refs, upstreams, contents, origin URLs and clean trees the old build produced.
The old build never had refs/remotes/origin/HEAD (the bare remote's HEAD named the host default branch, not main) and the product never reads it, so the new build does not write one.
core.autocrlf is pinned false so checkout yields the same LF files the old build wrote, whatever the host default is.
*/
const TEMPLATE_HEAD = "fusion/fn-refresh-fixture";
let templateRoot = "";

/** Forward-slash path git accepts on every platform and that appears verbatim in .git/config. */
function gitUrl(path: string): string {
  return path.split(sep).join("/");
}

type TemplateCommit = "base" | "feature" | "sentinel";

/** The three fixture commits, with the messages, paths and LF contents the clone/push build created. */
const TEMPLATE_COMMITS: Record<TemplateCommit, { mark: number; parent?: TemplateCommit; message: string; path: string; content: string }> = {
  base: { mark: 1, message: "base\n", path: "base.txt", content: "base\n" },
  feature: { mark: 2, parent: "base", message: "feature\n", path: "feature.txt", content: "feature\n" },
  sentinel: { mark: 3, parent: "base", message: "security sentinel\n", path: "sentinel.txt", content: "late integration security fix\n" },
};
/** Fixed identity and timestamp, so every repository gets byte-identical commits and therefore identical SHAs. */
const TEMPLATE_IDENT = "Fusion Test <test@example.com> 1700000000 +0000";

function fastImportData(text: string): string {
  return `data ${Buffer.byteLength(text, "utf8")}\n${text}`;
}

/** A `git fast-import` stream that creates the needed commits and points each ref at its commit. */
function templateStream(refs: Record<string, TemplateCommit>): string {
  const needed = new Set<TemplateCommit>(["base", ...Object.values(refs)]);
  let stream = "";
  for (const name of ["base", "feature", "sentinel"] as const) {
    if (!needed.has(name)) continue;
    const commit = TEMPLATE_COMMITS[name];
    // Every requested ref map includes main, so writing on main (or the feature branch) leaves no extra ref once the resets below run.
    const home = name === "feature" ? `refs/heads/${TEMPLATE_HEAD}` : "refs/heads/main";
    stream += `commit ${home}\nmark :${commit.mark}\n`;
    stream += `author ${TEMPLATE_IDENT}\ncommitter ${TEMPLATE_IDENT}\n${fastImportData(commit.message)}`;
    if (commit.parent) stream += `from :${TEMPLATE_COMMITS[commit.parent].mark}\n`;
    stream += `M 100644 inline ${commit.path}\n${fastImportData(commit.content)}\n`;
  }
  for (const [ref, name] of Object.entries(refs)) stream += `reset ${ref}\nfrom :${TEMPLATE_COMMITS[name].mark}\n\n`;
  return stream;
}

function fastImport(repo: string, refs: Record<string, TemplateCommit>): void {
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: templateStream(refs) });
}

/** Local config the clone/push build produced, written with fs instead of one `git config` spawn per key. */
function appendTemplateConfig(gitDir: string, origin?: string): void {
  let config = "[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n";
  if (origin !== undefined) {
    config += `[remote "origin"]\n\turl = ${gitUrl(origin)}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
    config += "[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n";
    config += "[user]\n\temail = test@example.com\n\tname = Fusion Test\n";
    // longpaths: rebase state under a deep temp root can exceed Git for Windows' MAX_PATH; it is a no-op elsewhere.
    config += "[core]\n\tautocrlf = false\n\tlongpaths = true\n";
  }
  const configPath = join(gitDir, "config");
  writeFileSync(configPath, readFileSync(configPath, "utf8") + config);
}

function buildTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-pr-refresh-template-"));
  const remote = join(root, "remote.git");
  const project = join(root, "project");
  const integration = join(root, "integration");
  git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  git(root, "init", "--quiet", "-b", "main", project);
  git(root, "init", "--quiet", "-b", "main", integration);
  // Remote: main carries the late security sentinel; the automated head was never pushed.
  fastImport(remote, { "refs/heads/main": "sentinel" });
  // Project: main and origin/main sit at base, and the automated head is a local-only branch off base.
  fastImport(project, { "refs/heads/main": "base", "refs/remotes/origin/main": "base", [`refs/heads/${TEMPLATE_HEAD}`]: "feature" });
  // Integration: the clone that pushed the sentinel, so main and origin/main both sit at it.
  fastImport(integration, { "refs/heads/main": "sentinel", "refs/remotes/origin/main": "sentinel" });
  appendTemplateConfig(remote);
  appendTemplateConfig(join(project, ".git"), remote);
  appendTemplateConfig(join(integration, ".git"), remote);
  git(project, "reset", "--quiet", "--hard");
  git(integration, "reset", "--quiet", "--hard");
  return root;
}

beforeAll(() => {
  templateRoot = buildTemplate();
});

afterAll(() => {
  if (templateRoot) rmSync(templateRoot, { recursive: true, force: true });
});

/** Re-point a copied clone's origin at the copy's own bare remote (no git spawn). */
function repointOrigin(cloneDir: string, fromRemote: string, toRemote: string): void {
  const configPath = join(cloneDir, ".git", "config");
  const config = readFileSync(configPath, "utf8");
  const from = `url = ${gitUrl(fromRemote)}`;
  if (!config.includes(from)) throw new Error(`fixture clone ${cloneDir} does not point at the template remote`);
  writeFileSync(configPath, config.split(from).join(`url = ${gitUrl(toRemote)}`));
}

function makeFixture(head = TEMPLATE_HEAD): { root: string; remote: string; integration: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "fusion-pr-refresh-"));
  fixtures.push(root);
  cpSync(templateRoot, root, { recursive: true });
  const remote = join(root, "remote.git");
  const project = join(root, "project");
  const integration = join(root, "integration");
  const templateRemote = join(templateRoot, "remote.git");
  repointOrigin(project, templateRemote, remote);
  repointOrigin(integration, templateRemote, remote);
  if (head !== TEMPLATE_HEAD) git(project, "branch", "-m", TEMPLATE_HEAD, head);

  return { root: project, remote, integration, head };
}

function makeConflictingFixture(head: string) {
  const fixture = makeFixture(head);
  git(fixture.root, "checkout", head);
  writeFileSync(join(fixture.root, "base.txt"), "head conflicts with integration\n");
  git(fixture.root, "add", "base.txt");
  git(fixture.root, "commit", "-m", "conflicting head change");
  git(fixture.root, "checkout", "main");
  writeFileSync(join(fixture.integration, "base.txt"), "integration conflicts with head\n");
  git(fixture.integration, "add", "base.txt");
  git(fixture.integration, "commit", "-m", "conflicting integration change");
  git(fixture.integration, "push", "origin", "main");
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function assertPublishedSentinel(remote: string, head: string, sentinel = "sentinel.txt"): void {
  expect(git(remote, "show", `refs/heads/${head}:${sentinel}`)).toBe("late integration security fix");
}

function makeLifecycleStore(task: Record<string, unknown>) {
  return {
    getTask: async () => task,
    getSettings: async () => ({ baseBranch: "main" }),
    getTaskWorkflowSelection: () => undefined,
    getWorkflowDefinition: async () => undefined,
    getWorkflowSettingValues: () => ({}),
    getWorkflowSettingsProjectId: () => "fixture-project",
    getBranchGroup: async () => null,
    listTasksByBranchGroup: async () => [],
    getActiveMergingTask: async () => null,
    updateTask: async () => undefined,
    updatePrInfo: async (_id: string, prInfo: unknown) => { Object.assign(task, { prInfo }); },
    updateBranchGroup: async () => undefined,
    logEntry: async () => undefined,
    moveTask: async () => task,
    emit: () => undefined,
  };
}

function gitSucceeds(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("refreshAutomatedPrHead local git fixture", () => {
  it("template matches the clone/push fixture topology", () => {
    const { root, remote, integration, head } = makeFixture();
    const base = git(root, "rev-parse", "refs/heads/main");
    const sentinel = git(remote, "rev-parse", "refs/heads/main");

    expect(git(root, "rev-parse", "refs/remotes/origin/main")).toBe(base);
    expect(git(root, "rev-parse", `refs/heads/${head}^`)).toBe(base);
    expect(git(remote, "rev-parse", "refs/heads/main^")).toBe(base);
    expect(git(integration, "rev-parse", "refs/heads/main")).toBe(sentinel);
    expect(git(integration, "rev-parse", "refs/remotes/origin/main")).toBe(sentinel);

    expect(git(root, "show", "refs/heads/main:base.txt")).toBe("base");
    expect(git(root, "show", `refs/heads/${head}:feature.txt`)).toBe("feature");
    expect(git(remote, "show", "refs/heads/main:sentinel.txt")).toBe("late integration security fix");
    expect(git(remote, "show", "refs/heads/main:base.txt")).toBe("base");

    expect(git(root, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    expect(git(integration, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    expect(gitSucceeds(root, "rev-parse", "--abbrev-ref", `${head}@{upstream}`)).toBe(false);
    expect(gitSucceeds(remote, "show-ref", "--verify", "--quiet", `refs/heads/${head}`)).toBe(false);

    for (const repo of [root, integration]) {
      expect(git(repo, "branch", "--show-current")).toBe("main");
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(git(repo, "config", "remote.origin.url")).toBe(gitUrl(remote));
    }
    expect(readFileSync(join(root, "base.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(integration, "sentinel.txt"), "utf8")).toBe("late integration security fix\n");
  });

  it("publishes a stale automated head only after it contains the late integration sentinel", async () => {
    const { root, remote, head } = makeFixture();

    /*
    FNXC:PullRequestFreshness 2026-08-09-03:20:
    An automated PR head created before a later integration security fix must be
    rebased and lease-published before any GitHub create boundary can observe it.
    */
    const refreshed = await refreshAutomatedPrHead({
      projectRoot: root,
      headBranch: head,
      targetBranch: "main",
    });

    expect(refreshed.refreshed).toBe(true);
    expect(git(remote, "show", `refs/heads/${head}:feature.txt`)).toBe("feature");
    expect(git(remote, "show", `refs/heads/${head}:sentinel.txt`)).toBe("late integration security fix");
    expect(git(root, "branch", "--show-current")).toBe("main");
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("/.fusion/worktrees/pr-refresh-");
  });

  it("refuses a head checked out at the primary project root", async () => {
    const { root, head } = makeFixture("fusion/fn-8838-root-refusal");
    git(root, "checkout", head);

    await expect(refreshAutomatedPrHead({ projectRoot: root, headBranch: head, targetBranch: "main" }))
      .rejects.toThrow(/project root/);
    expect(git(root, "branch", "--show-current")).toBe(head);
  });

  it("uses a verified existing task worktree without creating a temporary checkout", async () => {
    const { root, remote, head } = makeFixture("fusion/fn-8838-verified-worktree");
    const taskWorktree = join(root, "task-worktree");
    git(root, "worktree", "add", taskWorktree, head);

    const refreshed = await refreshAutomatedPrHead({
      projectRoot: root,
      headBranch: head,
      targetBranch: "main",
      preferredWorktree: taskWorktree,
    });

    expect(refreshed.refreshed).toBe(true);
    assertPublishedSentinel(remote, head);
    expect(git(taskWorktree, "branch", "--show-current")).toBe(head);
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("/.fusion/worktrees/pr-refresh-");
  });

  /*
  FNXC:CliTests 2026-10-08-15:30:
  KB-061: the remote-only and missing-head scenarios are independent, so each owns its case and fixture; every assertion is preserved.
  */
  it("materializes a remote-only head without GitHub boundaries", async () => {
    const remoteOnly = makeFixture("fusion/fn-8838-remote-only");
    git(remoteOnly.root, "push", "origin", remoteOnly.head);
    git(remoteOnly.root, "branch", "-D", remoteOnly.head);

    await expect(refreshAutomatedPrHead({
      projectRoot: remoteOnly.root,
      headBranch: remoteOnly.head,
      targetBranch: "main",
    })).resolves.toEqual(expect.objectContaining({ refreshed: true }));
    assertPublishedSentinel(remoteOnly.remote, remoteOnly.head);
  });

  it("refuses a missing head without GitHub boundaries", async () => {
    const missing = makeFixture("fusion/fn-8838-missing");
    await expect(refreshAutomatedPrHead({
      projectRoot: missing.root,
      headBranch: "fusion/fn-8838-does-not-exist",
      targetBranch: "main",
    })).rejects.toThrow(/missing local and origin head/);
  });

  it("restores the canonical local head when a force-with-lease publication is rejected", async () => {
    const { root, remote, head } = makeFixture("fusion/fn-8838-lease-rejection");
    // Make this an existing remote head, so the refresh publication must use a lease.
    git(root, "push", "origin", head);
    const originalHead = git(root, "rev-parse", `refs/heads/${head}`);
    const remoteMain = git(remote, "rev-parse", "refs/heads/main");
    const hook = join(root, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ngit --git-dir='${remote}' update-ref 'refs/heads/${head}' '${remoteMain}'\n`);
    chmodSync(hook, 0o755);

    /*
    FNXC:PullRequestFreshness 2026-08-09-04:52:
    A remote writer can win after refresh observes the old OID but before its
    guarded push reaches origin. The rejected lease must restore the shared
    local ref, preventing a later unguarded push from publishing the rebase.
    */
    await expect(refreshAutomatedPrHead({ projectRoot: root, headBranch: head, targetBranch: "main" }))
      .rejects.toThrow(/stale info|lease|failed to push/i);

    expect(git(root, "rev-parse", `refs/heads/${head}`)).toBe(originalHead);
    expect(git(remote, "rev-parse", `refs/heads/${head}`)).toBe(remoteMain);
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("/.fusion/worktrees/pr-refresh-");
  });

  it("refuses to overwrite a head that advanced before refresh observes its push lease", async () => {
    const { root, integration, remote, head } = makeFixture("fusion/fn-8838-pre-observation-race");
    git(root, "push", "origin", head);
    const originalHead = git(root, "rev-parse", `refs/heads/${head}`);
    git(integration, "fetch", "origin", `${head}:${head}`);
    git(integration, "checkout", head);
    writeFileSync(join(integration, "concurrent.txt"), "concurrent head update\n");
    git(integration, "add", "concurrent.txt");
    git(integration, "commit", "-m", "concurrent head update");
    git(integration, "push", "origin", head);
    const concurrentHead = git(remote, "rev-parse", `refs/heads/${head}`);

    /*
    FNXC:PullRequestFreshness 2026-08-09-05:32:
    A head update that reaches origin before refresh reads its lease must survive.
    The refresher may not replace that unincorporated commit with its rebased tip.
    */
    await expect(refreshAutomatedPrHead({ projectRoot: root, headBranch: head, targetBranch: "main" }))
      .rejects.toThrow(/changed before publication/);

    expect(git(root, "rev-parse", `refs/heads/${head}`)).toBe(originalHead);
    expect(git(remote, "rev-parse", `refs/heads/${head}`)).toBe(concurrentHead);
    expect(git(remote, "show", `refs/heads/${head}:concurrent.txt`)).toBe("concurrent head update");
  });

  /*
  FNXC:PullRequestFreshness 2026-08-23-23:20:
  Every production PR-create boundary must refresh the head before its GitHub
  call observes it. The three adapters below were one case that built three
  real-git fixtures (~4s) and flaked against vitest's 5s default; each adapter
  owns its own case so a boundary's coverage is sized like its siblings.
  */
  it("refreshes the shared-group PR-create callback before GitHub sees the head", async () => {
    const groupFixture = makeFixture("fusion/group-refresh-fixture");
    const groupGithub = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => {
        assertPublishedSentinel(groupFixture.remote, groupFixture.head);
        return { number: 1, url: "https://example.test/pr/1", status: "open" as const };
      }),
    };
    await createGroupPrCallback(groupGithub as never)({
      cwd: groupFixture.root,
      group: { id: "BG-fixture", branchName: groupFixture.head } as never,
      members: [{ id: "FN-8838", title: "fixture" }] as never,
      headBranch: groupFixture.head,
      baseBranch: "main",
    });
    expect(groupGithub.createPr).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:CliTests 2026-10-08-15:45:
  KB-061: each create+merge case ran two full product refresh cycles (~3-5 s on Windows) against vitest's 5 s default.
  Each boundary now owns its case. A merge case starts from the state its create boundary leaves behind: the PR exists and the head branch is on origin.
  It is seeded with a plain push of the un-rebased head, which is stricter than the create-time refresh because the merge boundary must still rebase it onto both sentinels.
  Every original assertion is preserved.
  */
  function makeWorkflowGithub(fixture: ReturnType<typeof makeFixture>) {
    return {
      createPr: vi.fn(async () => {
        assertPublishedSentinel(fixture.remote, fixture.head);
        return { number: 2, url: "https://example.test/pr/2", status: "open" as const };
      }),
      getPrStatus: vi.fn(async () => ({ number: 2, url: "https://example.test/pr/2", status: "open" as const })),
      mergePr: vi.fn(async () => ({ number: 2, url: "https://example.test/pr/2", status: "merged" as const })),
      replyToReviewThread: vi.fn(),
      resolveReviewThread: vi.fn(),
      getViewerLogin: vi.fn(),
      getPrReviewThreadsDetailed: vi.fn(),
    };
  }

  function makeWorkflowTask(fixture: ReturnType<typeof makeFixture>) {
    const task = { id: "FN-8838-WORKFLOW", title: "fixture", description: "fixture", worktree: fixture.root };
    const entity = { id: "pr-fixture", sourceId: task.id, repo: "fixture-owner/fixture-repo", headBranch: fixture.head, baseBranch: "main", prNumber: 2, headOid: "old" };
    return { task, entity };
  }

  /** Land a later integration commit on origin/main that the merge boundary must incorporate. */
  function pushMergeSentinel(fixture: ReturnType<typeof makeFixture>, sentinel: string, message: string): void {
    writeFileSync(join(fixture.integration, sentinel), "late integration security fix\n");
    git(fixture.integration, "add", sentinel);
    git(fixture.integration, "commit", "-m", message);
    git(fixture.integration, "push", "origin", "main");
  }

  it("refreshes the workflow PR node create boundary before GitHub sees the head", async () => {
    const workflowFixture = makeFixture("fusion/fn-8838-workflow");
    const workflowGithub = makeWorkflowGithub(workflowFixture);
    const workflowOps = createPrNodeGithubOps(workflowGithub as never);
    const { task, entity } = makeWorkflowTask(workflowFixture);
    await workflowOps.createPr({ task, entity } as never);
    expect(workflowGithub.createPr).toHaveBeenCalledTimes(1);
  });

  it("refreshes the workflow PR node merge boundary before GitHub sees the head", async () => {
    const workflowFixture = makeFixture("fusion/fn-8838-workflow");
    git(workflowFixture.root, "push", "origin", workflowFixture.head);
    const workflowGithub = makeWorkflowGithub(workflowFixture);
    const workflowOps = createPrNodeGithubOps(workflowGithub as never);
    const { task, entity } = makeWorkflowTask(workflowFixture);

    pushMergeSentinel(workflowFixture, "merge-sentinel.txt", "merge sentinel");
    workflowGithub.mergePr.mockImplementation(async () => {
      assertPublishedSentinel(workflowFixture.remote, workflowFixture.head, "merge-sentinel.txt");
      return { number: 2, url: "https://example.test/pr/2", status: "merged" as const };
    });
    const persisted: string[] = [];
    await workflowOps.mergePr({ task, entity, persistRefreshedHead: async (oid) => { persisted.push(oid); } } as never);
    expect(workflowGithub.getPrStatus).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(1);
  });

  function makeLifecycleFixture() {
    const lifecycleFixture = makeFixture("fusion/fn-8838-lifecycle");
    const lifecycleTask: Record<string, unknown> & { id: string } = {
      id: "FN-8838-LIFECYCLE",
      title: "fixture",
      description: "fixture",
      branch: lifecycleFixture.head,
      worktree: lifecycleFixture.root,
      column: "in-review",
    };
    const merge = { ready: false };
    const lifecycleGithub = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => {
        assertPublishedSentinel(lifecycleFixture.remote, lifecycleFixture.head);
        return { number: 3, url: "https://example.test/pr/3", status: "open" as const };
      }),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 3, url: "https://example.test/pr/3", status: "open" as const },
        reviewDecision: null,
        checks: [],
        mergeReady: merge.ready,
        blockingReasons: merge.ready ? [] : ["checks pending"],
      })),
      mergePr: vi.fn(async () => ({ number: 3, url: "https://example.test/pr/3", status: "merged" as const })),
    };
    return { lifecycleFixture, lifecycleTask, lifecycleGithub, merge };
  }

  it("refreshes the PR-merge lifecycle create boundary before GitHub sees the head", async () => {
    const { lifecycleFixture, lifecycleTask, lifecycleGithub } = makeLifecycleFixture();
    const lifecycleResult = await processPullRequestMergeTask(
      makeLifecycleStore(lifecycleTask) as never,
      lifecycleFixture.root,
      lifecycleTask.id,
      lifecycleGithub as never,
      () => undefined,
    );
    expect(lifecycleResult).toBe("waiting");
    expect(lifecycleGithub.createPr).toHaveBeenCalledTimes(1);
  });

  it("refreshes the PR-merge lifecycle merge boundary before GitHub sees the head", async () => {
    const { lifecycleFixture, lifecycleTask, lifecycleGithub, merge } = makeLifecycleFixture();
    // Post-create state: the PR recorded by updatePrInfo and the head published on origin.
    git(lifecycleFixture.root, "push", "origin", lifecycleFixture.head);
    lifecycleTask.prInfo = { number: 3, url: "https://example.test/pr/3", status: "open" };

    pushMergeSentinel(lifecycleFixture, "lifecycle-merge-sentinel.txt", "lifecycle merge sentinel");
    merge.ready = true;
    lifecycleGithub.mergePr.mockImplementation(async () => {
      assertPublishedSentinel(lifecycleFixture.remote, lifecycleFixture.head, "lifecycle-merge-sentinel.txt");
      return { number: 3, url: "https://example.test/pr/3", status: "merged" as const };
    });
    const lifecycleMergeResult = await processPullRequestMergeTask(
      makeLifecycleStore(lifecycleTask) as never,
      lifecycleFixture.root,
      lifecycleTask.id,
      lifecycleGithub as never,
      () => undefined,
    );
    expect(lifecycleMergeResult).toBe("merged");
    expect(lifecycleGithub.mergePr).toHaveBeenCalledTimes(1);
  });

  function makeSharedGroupFixture() {
    const fixture = makeFixture("fusion/groups/fn-8838-refresh");
    const task = {
      id: "FN-8838-GROUP",
      title: "group fixture",
      description: "fixture",
      branch: fixture.head,
      worktree: fixture.root,
      column: "in-review",
      branchContext: { assignmentMode: "shared", groupId: "BG-8838", source: "planning" },
    };
    const group: Record<string, unknown> = {
      id: "BG-8838",
      sourceType: "planning",
      sourceId: "P-8838",
      branchName: fixture.head,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const merge = { ready: false };
    const store = {
      ...makeLifecycleStore(task),
      getBranchGroup: async () => group,
      listTasksByBranchGroup: async () => [task],
    };
    const github = {
      findPrForBranch: vi.fn(async () => null),
      createPr: vi.fn(async () => {
        assertPublishedSentinel(fixture.remote, fixture.head);
        return { number: 4, url: "https://example.test/pr/4", status: "open" as const };
      }),
      getPrMergeStatus: vi.fn(async () => ({
        prInfo: { number: 4, url: "https://example.test/pr/4", status: "open" as const },
        reviewDecision: "APPROVED" as const,
        checks: [],
        mergeReady: merge.ready,
        blockingReasons: merge.ready ? [] : ["checks pending"],
      })),
      mergePr: vi.fn(async () => ({ number: 4, url: "https://example.test/pr/4", status: "merged" as const })),
    };
    return { fixture, task, store, github, merge, group };
  }

  it("refreshes the shared-group creation boundary before GitHub sees the head", async () => {
    const { fixture, task, store, github } = makeSharedGroupFixture();
    await expect(processPullRequestMergeTask(store as never, fixture.root, task.id, github as never, () => undefined)).resolves.toBe("waiting");
    expect(github.createPr).toHaveBeenCalledTimes(1);
  });

  it("refreshes the shared-group merge boundary before GitHub sees the head", async () => {
    const { fixture, task, store, github, merge, group } = makeSharedGroupFixture();
    // Post-create state: the group head is published on origin and the group records its PR (what updateBranchGroup persists after creation).
    git(fixture.root, "push", "origin", fixture.head);
    Object.assign(group, { prNumber: 4, prUrl: "https://example.test/pr/4", prState: "open" });
    pushMergeSentinel(fixture, "group-merge-sentinel.txt", "group merge sentinel");
    merge.ready = true;
    github.mergePr.mockImplementation(async () => {
      assertPublishedSentinel(fixture.remote, fixture.head, "group-merge-sentinel.txt");
      return { number: 4, url: "https://example.test/pr/4", status: "merged" as const };
    });

    await expect(processPullRequestMergeTask(store as never, fixture.root, task.id, github as never, () => undefined)).resolves.toBe("merged");
    expect(github.mergePr).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: expect.any(String) }));
  });

  /*
  FNXC:PullRequestFreshness 2026-08-09-04:26:
  A rebase conflict is a hard stop at all automated create boundaries. GitHub
  must never receive a normal-looking PR whose stale head omits base changes.

  FNXC:PullRequestFreshness 2026-08-23-23:20:
  Split per adapter: the four conflicting real-git fixtures ran as one ~4s case
  and flaked against vitest's 5s default. Every adapter's fail-closed assertion
  is preserved; only the per-case wall clock changed.
  */
  it("fails closed at the shared-group promotion PR-create adapter when rebase conflicts", async () => {
    const promotionFixture = makeConflictingFixture("fusion/groups/fn-8838-conflict-promotion");
    const promotionGithub = { findPrForBranch: vi.fn(async () => null), createPr: vi.fn() };
    await expect(createGroupPrCallback(promotionGithub as never)({
      cwd: promotionFixture.root,
      group: { id: "BG-conflict", sourceType: "planning", sourceId: "P-conflict" } as never,
      members: [],
      headBranch: promotionFixture.head,
      baseBranch: "main",
    })).rejects.toThrow(/rebase/);
    expect(promotionGithub.createPr).not.toHaveBeenCalled();
  });

  it("fails closed at the workflow PR node create adapter when rebase conflicts", async () => {
    const workflowFixture = makeConflictingFixture("fusion/fn-8838-conflict-workflow");
    const workflowGithub = {
      createPr: vi.fn(), getPrStatus: vi.fn(), mergePr: vi.fn(), replyToReviewThread: vi.fn(),
      resolveReviewThread: vi.fn(), getViewerLogin: vi.fn(), getPrReviewThreadsDetailed: vi.fn(),
    };
    await expect(createPrNodeGithubOps(workflowGithub as never).createPr({
      task: { id: "FN-8838-CONFLICT-WORKFLOW", title: "fixture", description: "fixture", worktree: workflowFixture.root },
      entity: { id: "pr-conflict", sourceId: "FN-8838-CONFLICT-WORKFLOW", repo: "fixture-owner/fixture-repo", headBranch: workflowFixture.head, baseBranch: "main" },
    } as never)).rejects.toThrow(/rebase/);
    expect(workflowGithub.createPr).not.toHaveBeenCalled();
  });

  it("fails closed at the workflow PR node merge adapter when rebase conflicts", async () => {
    const workflowMergeFixture = makeConflictingFixture("fusion/fn-8838-conflict-workflow-merge");
    const workflowMergeGithub = {
      createPr: vi.fn(), getPrStatus: vi.fn(), mergePr: vi.fn(), replyToReviewThread: vi.fn(),
      resolveReviewThread: vi.fn(), getViewerLogin: vi.fn(), getPrReviewThreadsDetailed: vi.fn(),
    };
    await expect(createPrNodeGithubOps(workflowMergeGithub as never).mergePr({
      task: { id: "FN-8838-CONFLICT-WORKFLOW-MERGE", worktree: workflowMergeFixture.root },
      entity: { id: "pr-conflict-merge", sourceId: "FN-8838-CONFLICT-WORKFLOW-MERGE", repo: "fixture-owner/fixture-repo", headBranch: workflowMergeFixture.head, baseBranch: "main", prNumber: 5 },
    } as never)).rejects.toThrow(/rebase/);
    expect(workflowMergeGithub.getPrStatus).not.toHaveBeenCalled();
    expect(workflowMergeGithub.mergePr).not.toHaveBeenCalled();
  });

  it("fails closed at the PR-merge lifecycle create adapter when rebase conflicts", async () => {
    const lifecycleFixture = makeConflictingFixture("fusion/fn-8838-conflict-lifecycle");
    const lifecycleGithub = {
      findPrForBranch: vi.fn(async () => null), createPr: vi.fn(), getPrMergeStatus: vi.fn(), mergePr: vi.fn(),
    };
    const lifecycleTask = { id: "FN-8838-CONFLICT-LIFECYCLE", title: "fixture", description: "fixture", branch: lifecycleFixture.head, worktree: lifecycleFixture.root, column: "in-review" };
    await expect(processPullRequestMergeTask(
      makeLifecycleStore(lifecycleTask) as never, lifecycleFixture.root, lifecycleTask.id, lifecycleGithub as never, () => undefined,
    )).rejects.toThrow(/rebase/);
    expect(lifecycleGithub.createPr).not.toHaveBeenCalled();
  });
});
