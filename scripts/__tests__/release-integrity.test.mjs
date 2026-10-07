import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReleaseRepo, runRelease } from "./helpers/release-harness.mjs";

/*
FNXC:ReleaseScript 2026-10-07-19:30:
A release tag must identify exactly the source that was published.
A failed release commit, a working tree changed by anything other than the release, or a moved HEAD must stop the release before publish, push or tag.
Declining or failing before confirmation must leave every release input as it was, without overwriting a concurrent edit.
*/

const RELEASE_PATH = /^(package\.json|pnpm-lock\.yaml|CHANGELOG(-archive)?\.md|\.changeset\/.+|packages\/[^/]+\/(package\.json|CHANGELOG\.md))$/;

const channels = {
  beta: { version: "0.78.0-beta.5", newVersion: "0.78.0-beta.6", distTag: "beta", preJson: { mode: "pre", tag: "beta", initialVersions: { "@runfusion/fusion": "0.78.0-beta.0" }, changesets: [] } },
  stable: { version: "0.78.0-beta.5", newVersion: "0.78.0", distTag: "latest", preJson: { mode: "pre", tag: "beta", initialVersions: { "@runfusion/fusion": "0.77.0" }, changesets: [] } },
};
const branchOf = (channel) => (channel === "beta" ? "main" : "release");

async function withRelease(options, fn) {
  const fixture = createReleaseRepo(options);
  try {
    return await fn(fixture);
  } finally {
    fixture.cleanup();
  }
}

function assertNothingShipped(fixture, result, { channel, newVersion, baseHead }) {
  assert.doesNotMatch(result.commands, /publish/, result.output);
  assert.equal(fixture.git("tag", "--list", `v${newVersion}`), "", "no local release tag");
  assert.equal(fixture.originGit("tag", "--list", `v${newVersion}`), "", "no pushed release tag");
  assert.equal(fixture.originGit("rev-parse", branchOf(channel)), baseHead, "origin branch unchanged");
}

describe("new releases", { concurrency: true }, () => {
  for (const [channel, setup] of Object.entries(channels)) {
    it(`${channel}: publishes, pushes and tags the release commit, whose tree is the published source`, () =>
      withRelease({ channel, version: setup.version, preJson: setup.preJson }, async (fixture) => {
        const result = await runRelease(fixture, { channel, scenario: { newVersion: setup.newVersion } });

        assert.equal(result.status, 0, result.output);
        assert.match(result.commands, /pnpm build:full/);
        assert.match(result.commands, new RegExp(`pnpm -r publish --access public --no-git-checks --tag ${setup.distTag}`));
        const tag = `v${setup.newVersion}`;
        assert.equal(fixture.originGit("rev-parse", `${tag}^{commit}`), fixture.originGit("rev-parse", branchOf(channel)));
        assert.equal(JSON.parse(fixture.git("show", `${tag}:packages/cli/package.json`)).version, setup.newVersion);
        const committed = fixture.git("show", "--name-only", "--format=", tag).split("\n").filter(Boolean);
        assert.deepEqual(committed.filter((path) => !RELEASE_PATH.test(path)), []);
        assert.equal(fixture.git("status", "--porcelain"), "");
      }));

    it(`${channel}: a rejected release commit stops before publish, push and tag`, () =>
      withRelease({ channel, version: setup.version, preJson: setup.preJson }, async (fixture) => {
        const baseHead = fixture.git("rev-parse", "HEAD");
        fixture.failCommitHook();
        const result = await runRelease(fixture, { channel, scenario: { newVersion: setup.newVersion } });

        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /HOOK_REJECTED/);
        assert.match(result.output, /commit/i);
        assertNothingShipped(fixture, result, { channel, newVersion: setup.newVersion, baseHead });
        assert.equal(fixture.git("rev-parse", "HEAD"), baseHead);
      }));

    it(`${channel}: a file changed by something else during the release stops it before staging`, () =>
      withRelease({ channel, version: setup.version, preJson: setup.preJson }, async (fixture) => {
        const baseHead = fixture.git("rev-parse", "HEAD");
        const result = await runRelease(fixture, { channel, scenario: { newVersion: setup.newVersion, duringBuild: "dirty" } });

        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /packages\/engine\/src\/injected\.ts/);
        assert.equal(fixture.git("rev-parse", "HEAD"), baseHead, "no release commit");
        assertNothingShipped(fixture, result, { channel, newVersion: setup.newVersion, baseHead });
      }));
  }

  it("a HEAD moved by another writer during the release stops it before committing", () =>
    withRelease({}, async (fixture) => {
      const baseHead = fixture.git("rev-parse", "HEAD");
      const result = await runRelease(fixture, { scenario: { duringBuild: "move-head" } });

      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /HEAD/);
      assert.equal(fixture.git("log", "-1", "--format=%s"), "fix: landed by another agent", "no release commit on top");
      assertNothingShipped(fixture, result, { channel: "beta", newVersion: "0.78.0-beta.6", baseHead });
    }));

  it("invalid npm authentication stops a new release before any mutation", () =>
    withRelease({}, async (fixture) => {
      const result = await runRelease(fixture, { scenario: { npmAuth: false } });

      assert.equal(result.status, 1);
      assert.match(result.output, /npm login/);
      assert.doesNotMatch(result.commands, /pnpm /);
      assert.equal(fixture.git("status", "--porcelain"), "");
    }));

  it("an npm that cannot be launched is reported as a launch failure, not as a login problem", async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "fusion-release-nopath-"));
    try {
      await withRelease({}, async (fixture) => {
        const result = await runRelease(fixture, { path: emptyPath });

        assert.equal(result.status, 1);
        assert.match(result.output, /could not run npm/i);
        assert.match(result.output, /ENOENT|not recognized|spawn/i);
        assert.doesNotMatch(result.output, /npm login/);
      });
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});

describe("leaving release inputs untouched before confirmation", { concurrency: true }, () => {
  const cases = [
    { name: "declining a beta that entered pre-mode", fixture: { preJson: null }, run: { confirm: "n" }, status: 0 },
    { name: "declining a stable that exited pre-mode", fixture: { channel: "stable", preJson: channels.stable.preJson }, run: { channel: "stable", confirm: "n", scenario: { newVersion: "0.78.0" } }, status: 0 },
    { name: "declining a beta whose stale cycle was re-anchored", fixture: { version: "0.76.1-beta.3", preJson: { mode: "pre", tag: "beta", initialVersions: { "@runfusion/fusion": "0.76.0" }, changesets: [] } }, run: { confirm: "n", scenario: { newVersion: "0.77.1-beta.0" } }, status: 0 },
    { name: "a failed release plan", fixture: { preJson: null }, run: { scenario: { planFails: true } }, status: 1, output: /PLAN_SENTINEL/ },
    { name: "a dry run", fixture: { preJson: null }, run: { args: ["--dry-run"] }, status: 0 },
    { name: "a stable dry run", fixture: { channel: "stable", preJson: channels.stable.preJson }, run: { channel: "stable", args: ["--dry-run"], scenario: { newVersion: "0.78.0" } }, status: 0 },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} restores every release input`, () =>
      withRelease(testCase.fixture, async (fixture) => {
        const result = await runRelease(fixture, testCase.run);

        assert.equal(result.status, testCase.status, result.output);
        if (testCase.output) assert.match(result.output, testCase.output);
        assert.doesNotMatch(result.commands, /release:version|publish/);
        assert.equal(fixture.git("status", "--porcelain", "--untracked-files=all"), "", result.output);
      }));
  }

  it("missing changesets after entering pre-mode restore every release input", () =>
    withRelease({ preJson: null }, async (fixture) => {
      fixture.git("rm", "-q", ".changeset/add-thing.md");
      fixture.git("commit", "-q", "-m", "chore: no changesets");
      fixture.git("push", "-q", "origin", "main");
      const result = await runRelease(fixture, {});

      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /No pending changesets/);
      assert.equal(fixture.git("status", "--porcelain", "--untracked-files=all"), "");
    }));

  it("an input edited by someone else meanwhile is left as they wrote it", () =>
    withRelease({ channel: "stable", preJson: channels.stable.preJson }, async (fixture) => {
      const result = await runRelease(fixture, { channel: "stable", confirm: "n", scenario: { newVersion: "0.78.0", editPreJsonDuringPlan: true } });

      assert.equal(result.status, 0, result.output);
      const preJson = fixture.read(".changeset/pre.json");
      assert.equal(JSON.parse(preJson).mode, "exit", "the concurrent edit survives");
      assert.ok(preJson.endsWith("\n\n"));
      assert.match(result.output, /\.changeset\/pre\.json/);
    }));
});
