import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createReleaseRepo, runRelease } from "./helpers/release-harness.mjs";

/*
 * `--resume` recovers a committed release whose publish failed: it rebuilds, proves the tree, publishes, pushes and tags without another version bump.
 */

const versions = { beta: "0.78.0-beta.5", stable: "0.78.0" };
const branchOf = (channel) => (channel === "beta" ? "main" : "release");

async function withCommittedRelease(channel, options, fn) {
  const version = versions[channel];
  const fixture = createReleaseRepo({ channel, version, preJson: null, subject: options.subject ?? `chore(release): v${version}` });
  try {
    if (options.tagged) fixture.git("tag", `v${version}`);
    if (options.notes === false) {
      fixture.write("CHANGELOG.md", "# Fusion changelog\n");
      fixture.git("commit", "-q", "-am", "docs: drop notes");
      fixture.git("push", "-q", "origin", branchOf(channel));
    }
    return await fn(fixture, version);
  } finally {
    fixture.cleanup();
  }
}

describe("release --resume", { concurrency: true }, () => {
  for (const channel of ["beta", "stable"]) {
    it(`${channel}: previews the committed version without authentication, build or publish`, () =>
      withCommittedRelease(channel, {}, async (fixture, version) => {
        const result = await runRelease(fixture, { channel, args: ["--resume", "--dry-run"] });

        assert.equal(result.status, 0, result.output);
        assert.match(result.output, /Would resume/);
        assert.equal(result.commands, "");
        assert.equal(fixture.git("tag", "--list", `v${version}`), "");
      }));

    it(`${channel}: rebuilds, publishes and tags the committed release without another version bump`, () =>
      withCommittedRelease(channel, {}, async (fixture, version) => {
        const head = fixture.git("rev-parse", "HEAD");
        const result = await runRelease(fixture, { channel, args: ["--resume"] });

        assert.equal(result.status, 0, result.output);
        assert.match(result.commands, /npm whoami/);
        assert.match(result.commands, /pnpm build:full/);
        assert.match(result.commands, /pnpm -r publish/);
        assert.doesNotMatch(result.commands, /changeset|release:version/);
        assert.equal(fixture.git("rev-parse", "HEAD"), head, "no new commit");
        assert.equal(fixture.originGit("rev-parse", `v${version}^{commit}`), head);
      }));

    it(`${channel}: a tree dirtied before publish stops the resume before publish and tag`, () =>
      withCommittedRelease(channel, {}, async (fixture, version) => {
        const result = await runRelease(fixture, { channel, args: ["--resume"], scenario: { duringBuild: "dirty" } });

        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /packages\/engine\/src\/injected\.ts/);
        assert.doesNotMatch(result.commands, /publish/);
        assert.equal(fixture.originGit("tag", "--list", `v${version}`), "");
      }));
  }

  it("a failed publish leaves the release untagged and names the resume command", () =>
    withCommittedRelease("beta", {}, async (fixture, version) => {
      const result = await runRelease(fixture, { args: ["--resume"], scenario: { publishFails: true } });

      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /--resume/);
      assert.equal(fixture.git("tag", "--list", `v${version}`), "");
      assert.equal(fixture.originGit("tag", "--list", `v${version}`), "");
    }));

  it("refuses a version without its release commit", () =>
    withCommittedRelease("beta", { subject: "fix: unrelated change" }, async (fixture) => {
      const result = await runRelease(fixture, { args: ["--resume", "--dry-run"] });

      assert.equal(result.status, 1);
      assert.match(result.output, /release commit/);
    }));

  it("refuses an already tagged release", () =>
    withCommittedRelease("beta", { tagged: true }, async (fixture) => {
      const result = await runRelease(fixture, { args: ["--resume", "--dry-run"] });

      assert.equal(result.status, 1);
      assert.match(result.output, /already tagged/);
    }));

  it("refuses missing release notes", () =>
    withCommittedRelease("beta", { notes: false }, async (fixture) => {
      const result = await runRelease(fixture, { args: ["--resume", "--dry-run"] });

      assert.equal(result.status, 1);
      assert.match(result.output, /release notes .* missing/);
    }));

  it("declining recovery performs no build or publish", () =>
    withCommittedRelease("beta", {}, async (fixture) => {
      const result = await runRelease(fixture, { args: ["--resume"], confirm: "n" });

      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Aborted by user/);
      assert.doesNotMatch(result.commands, /pnpm /);
    }));
});
