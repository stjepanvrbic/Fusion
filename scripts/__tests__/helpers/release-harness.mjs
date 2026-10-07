/*
FNXC:ReleaseScript 2026-10-07-19:30:
Release tests drive the real scripts/release.mjs against a throwaway git repository with a bare origin.
Git is real, so commits, hooks, pushes and tags are the real outcome; pnpm, npm and gh are node stubs that log their argv and act out a scenario.
Stubs are written both as POSIX shebang files and as Windows .cmd files, so the same tests run on Linux CI and the Windows operator host.
*/
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

export const releaseScript = fileURLToPath(new URL("../../release.mjs", import.meta.url));
const syncWorkspaceVersionScript = fileURLToPath(new URL("../../sync-workspace-version.mjs", import.meta.url));

const STUB_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [tool, ...args] = process.argv.slice(2);
const joined = args.join(" ");
fs.appendFileSync(process.env.RELEASE_STUB_LOG, tool + " " + joined + "\n");
const scenario = JSON.parse(fs.readFileSync(process.env.RELEASE_STUB_SCENARIO, "utf8"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const exit = (code) => process.exit(code);

if (tool === "gh") exit(1);
if (tool === "npm") {
  if (args[0] === "whoami") { if (scenario.npmAuth === false) { console.error("E401"); exit(1); } console.log("tester"); exit(0); }
  if (args[0] === "install") {
    fs.mkdirSync("node_modules/runfusion.ai", { recursive: true });
    fs.writeFileSync("node_modules/runfusion.ai/index.js", "process.exit(0);\n");
    fs.mkdirSync("node_modules/typescript/bin", { recursive: true });
    fs.writeFileSync("node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: "5.0.0" }));
    fs.writeFileSync("node_modules/typescript/bin/tsc", "process.exit(0);\n");
    exit(0);
  }
  exit(0);
}
if (tool !== "pnpm") exit(0);

const prePath = path.join(".changeset", "pre.json");
if (joined.startsWith("changeset status --output ")) {
  if (scenario.planFails) { console.error("PLAN_SENTINEL"); exit(1); }
  if (scenario.editPreJsonDuringPlan && fs.existsSync(prePath)) fs.appendFileSync(prePath, "\n");
  writeJson(args[3], { releases: [{ name: "@runfusion/fusion", type: "minor", newVersion: scenario.newVersion }] });
  exit(0);
}
if (joined === "changeset pre enter beta") {
  writeJson(prePath, { mode: "pre", tag: "beta", initialVersions: { "@runfusion/fusion": readJson("packages/cli/package.json").version }, changesets: [] });
  exit(0);
}
if (joined === "changeset pre exit") {
  const pre = readJson(prePath);
  writeJson(prePath, { ...pre, mode: "exit" });
  exit(0);
}
if (joined === "release:version") {
  for (const file of ["packages/cli/package.json", "packages/engine/package.json"]) writeJson(file, { ...readJson(file), version: scenario.newVersion });
  const changelog = "packages/cli/CHANGELOG.md";
  fs.writeFileSync(changelog, "# @runfusion/fusion\n\n## " + scenario.newVersion + "\n\n### Minor Changes\n\n- Add a thing.\n\n" + fs.readFileSync(changelog, "utf8").replace(/^# [^\n]*\n\n/, ""));
  const changesets = fs.readdirSync(".changeset").filter((f) => f.endsWith(".md") && f !== "README.md");
  if (fs.existsSync(prePath) && readJson(prePath).mode === "pre") writeJson(prePath, { ...readJson(prePath), changesets: changesets.map((f) => f.replace(/\.md$/, "")) });
  else for (const f of changesets) fs.unlinkSync(path.join(".changeset", f));
  exit(0);
}
if (joined === "install --no-frozen-lockfile") { fs.appendFileSync("pnpm-lock.yaml", "# relocked\n"); exit(0); }
if (joined === "build:full") {
  if (scenario.duringBuild === "dirty") fs.writeFileSync("packages/engine/src/injected.ts", "export const injected = true;\n");
  if (scenario.duringBuild === "move-head") {
    const git = (...gitArgs) => require("node:child_process").spawnSync("git", gitArgs, { stdio: "ignore" });
    fs.writeFileSync("packages/engine/src/landed.ts", "export const landed = true;\n");
    git("add", "packages/engine/src/landed.ts");
    git("commit", "--no-verify", "-m", "fix: landed by another agent");
  }
  if (scenario.buildFails) exit(23);
  exit(0);
}
if (args[0] === "pack") {
  const name = path.basename(process.cwd()) === "cli-alias" ? "runfusion.ai" : "runfusion-fusion";
  fs.writeFileSync(path.join(args[2], name + "-" + readJson("package.json").version + ".tgz"), "tarball");
  exit(0);
}
if (args[0] === "-r" && args[1] === "publish") { if (scenario.publishFails) exit(1); exit(0); }
exit(0);
`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function writeStub(binDir, stubPath, tool) {
  const posix = join(binDir, tool);
  writeFileSync(posix, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" ${tool} "$@"\n`);
  chmodSync(posix, 0o755);
  writeFileSync(join(binDir, `${tool}.cmd`), `@"${process.execPath}" "${stubPath}" ${tool} %*\r\n`);
}

function childEnv(binDir, extra, pathOverride) {
  const env = { ...process.env };
  delete env.npm_execpath;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = pathOverride ?? binDir + delimiter + (env[pathKey] ?? "");
  return { ...env, ...extra };
}

/**
 * Create a release fixture repository.
 *
 * @param {{ channel?: "beta" | "stable", version?: string, preJson?: object | null, stableTag?: string, subject?: string }} options
 */
export function createReleaseRepo({ channel = "beta", version = "0.78.0-beta.5", preJson = { mode: "pre", tag: "beta", initialVersions: { "@runfusion/fusion": "0.78.0-beta.0" }, changesets: [] }, stableTag = "v0.77.0", subject = "chore: fixture" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fusion-release-test-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const binDir = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(binDir);
  const stubPath = join(binDir, "stub.cjs");
  writeFileSync(stubPath, STUB_SOURCE);
  for (const tool of ["pnpm", "npm", "gh"]) writeStub(binDir, stubPath, tool);

  writeJson(join(repo, "package.json"), { name: "fusion-workspace", private: true, version });
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeJson(join(repo, "packages/cli/package.json"), { name: "@runfusion/fusion", version });
  writeJson(join(repo, "packages/cli-alias/package.json"), { name: "runfusion.ai", version });
  writeJson(join(repo, "packages/engine/package.json"), { name: "@fusion/engine", private: true, version });
  mkdirSync(join(repo, "packages/engine/src"), { recursive: true });
  writeFileSync(join(repo, "packages/engine/src/index.ts"), "export {};\n");
  writeFileSync(join(repo, "packages/cli/CHANGELOG.md"), `# @runfusion/fusion\n\n## ${version}\n\n- Earlier.\n`);
  writeFileSync(join(repo, "CHANGELOG.md"), `# Fusion changelog\n\n## ${version}\n\nEarlier notes.\n`);
  writeJson(join(repo, ".changeset/config.json"), { fixed: [["@runfusion/fusion"]] });
  writeFileSync(join(repo, ".changeset/add-thing.md"), '---\n"@runfusion/fusion": minor\n---\n\nsummary: Add a thing.\ncategory: feature\n');
  if (preJson) writeJson(join(repo, ".changeset/pre.json"), preJson);
  mkdirSync(join(repo, "scripts"));
  copyFileSync(syncWorkspaceVersionScript, join(repo, "scripts/sync-workspace-version.mjs"));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");

  git(repo, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "Release Test"], ["user.email", "release@example.invalid"], ["commit.gpgsign", "false"], ["tag.gpgSign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", ".git/hooks"]]) {
    git(repo, "config", key, value);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", subject);
  git(repo, "tag", stableTag);
  if (channel === "stable") git(repo, "checkout", "-q", "-b", "release");
  spawnSync("git", ["init", "-q", "--bare", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", channel === "stable" ? "release" : "main");

  return {
    root,
    repo,
    origin,
    binDir,
    stubPath,
    git: (...args) => git(repo, ...args),
    originGit: (...args) => git(origin, ...args),
    failCommitHook() {
      const hook = join(repo, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\necho HOOK_REJECTED >&2\nexit 1\n");
      chmodSync(hook, 0o755);
    },
    read: (file) => readFileSync(join(repo, file), "utf8"),
    exists: (file) => existsSync(join(repo, file)),
    write: (file, content) => writeFileSync(join(repo, file), content),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Run release.mjs in the fixture, answering prompts as they appear.
 *
 * @param {ReturnType<typeof createReleaseRepo>} fixture
 * @param {{ channel?: string, args?: string[], scenario?: object, confirm?: string, env?: object, path?: string, script?: string, timeoutMs?: number }} options
 */
export function runRelease(fixture, { channel = "beta", args = [], scenario = {}, confirm = "y", env = {}, path, script = releaseScript, timeoutMs = 60_000 } = {}) {
  const scenarioPath = join(fixture.root, "scenario.json");
  const logPath = join(fixture.root, "commands.log");
  writeFileSync(scenarioPath, JSON.stringify({ newVersion: "0.78.0-beta.6", ...scenario }));
  writeFileSync(logPath, "");
  const childEnvironment = childEnv(fixture.binDir, {
    RELEASE_STUB_SCENARIO: scenarioPath,
    RELEASE_STUB_LOG: logPath,
    FUSION_RELEASE_CLAUDE_BIN: join(fixture.root, "no-claude-here"),
    FUSION_HOMEBREW_TAP_DIR: join(fixture.root, "no-tap-here"),
    NO_COLOR: "1",
    ...env,
  }, path);

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, "--channel", channel, ...args], { cwd: fixture.repo, env: childEnvironment });
    let output = "";
    let answeredVersion = false;
    let answeredConfirm = false;
    const onData = (chunk) => {
      output += chunk;
      if (!answeredVersion && output.includes("Release version [")) {
        answeredVersion = true;
        child.stdin.write("\n");
      }
      if (!answeredConfirm && output.includes("[y/N]")) {
        answeredConfirm = true;
        child.stdin.write(`${confirm}\n`);
      }
    };
    child.stdout.setEncoding("utf8").on("data", onData);
    child.stderr.setEncoding("utf8").on("data", onData);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, output, commands: readFileSync(logPath, "utf8") });
    });
  });
}
