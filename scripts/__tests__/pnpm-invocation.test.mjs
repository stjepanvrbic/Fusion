import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { describeSpawnFailure, quoteCmdArg, resolveCommandInvocation } from "../lib/pnpm-invocation.mjs";

const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";

test("win32: npm_execpath naming pnpm's JS entry runs it through node with argv intact", () => {
  for (const cli of ["C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs", "C:\\corepack\\dist\\pnpm.js", "C:\\x\\pnpm.mjs"]) {
    assert.deepEqual(
      resolveCommandInvocation("pnpm", ["--filter", "@fusion/core", "test:pg-gate"], { platform: "win32", env: { npm_execpath: cli }, execPath: WIN_NODE }),
      { command: WIN_NODE, args: [cli, "--filter", "@fusion/core", "test:pg-gate"], windowsVerbatimArguments: false },
    );
  }
});

test("win32: a standalone pnpm.exe in npm_execpath is spawned directly", () => {
  const cli = "C:\\tools\\pnpm\\pnpm.exe";
  assert.deepEqual(
    resolveCommandInvocation("pnpm", ["test:gate"], { platform: "win32", env: { npm_execpath: cli }, execPath: WIN_NODE }),
    { command: cli, args: ["test:gate"], windowsVerbatimArguments: false },
  );
});

test("win32: without a pnpm npm_execpath it goes through cmd.exe with quoted arguments", () => {
  for (const env of [{}, { npm_execpath: "C:\\npm\\bin\\npm-cli.js" }]) {
    assert.deepEqual(
      resolveCommandInvocation("pnpm", ["--filter", "@fusion/engine", "exec", "vitest", "run", "src/a b.test.ts", 'say "hi"'], { platform: "win32", env, execPath: WIN_NODE }),
      {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", '"pnpm --filter @fusion/engine exec vitest run "src/a b.test.ts" "say ""hi""""'],
        windowsVerbatimArguments: true,
      },
    );
  }
  assert.equal(resolveCommandInvocation("pnpm", [], { platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } }).command, "C:\\Windows\\System32\\cmd.exe");
});

test("non-win32 platforms and non-pnpm commands are unchanged", () => {
  const args = ["--filter", "x", "build"];
  assert.deepEqual(resolveCommandInvocation("pnpm", args, { platform: "linux", env: { npm_execpath: "/x/pnpm.cjs" } }), { command: "pnpm", args, windowsVerbatimArguments: false });
  assert.deepEqual(resolveCommandInvocation("pnpm", args, { platform: "darwin", env: {} }), { command: "pnpm", args, windowsVerbatimArguments: false });
  assert.deepEqual(resolveCommandInvocation("node", args, { platform: "win32", env: { npm_execpath: "C:\\pnpm.cjs" } }), { command: "node", args, windowsVerbatimArguments: false });
});

test("quoteCmdArg leaves plain tokens bare and quotes the rest", () => {
  assert.equal(quoteCmdArg("--workspace-concurrency=2"), "--workspace-concurrency=2");
  assert.equal(quoteCmdArg("C:\\a\\b.ts"), "C:\\a\\b.ts");
  assert.equal(quoteCmdArg(""), '""');
  assert.equal(quoteCmdArg("a&b"), '"a&b"');
});

test("describeSpawnFailure names a launch error that left status null", () => {
  assert.equal(describeSpawnFailure({ status: null, error: new Error("spawn pnpm ENOENT") }), "spawn error: spawn pnpm ENOENT");
  assert.equal(describeSpawnFailure({ status: null, signal: "SIGTERM" }), "signal SIGTERM");
  assert.equal(describeSpawnFailure({ status: 2 }), "exit code 2");
});

/*
FNXC:WindowsPnpmLaunch 2026-10-07-18:03:
Real launch smoke: the resolved invocation must start pnpm on the host platform, whatever its install shape.
*/
test("the resolved invocation launches the installed pnpm on this host", () => {
  const invocation = resolveCommandInvocation("pnpm", ["--version"]);
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  assert.equal(result.error, undefined, describeSpawnFailure(result));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

/*
FNXC:WindowsPnpmLaunch 2026-10-07-19:30:
Any command, not only pnpm, must launch on Windows the way a shell would resolve it: npm, gh and other tools ship as .cmd shims that spawn cannot execute without cmd.exe.
*/
test("win32: a command found as a .cmd/.bat shim on PATH runs through cmd.exe by its full path", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "fusion-launch-"));
  try {
    const first = join(root, "first dir");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, "npm.CMD"), "");
    writeFileSync(join(second, "npm.EXE"), "");
    writeFileSync(join(second, "gh.EXE"), "");
    writeFileSync(join(second, "tool.BAT"), "");
    const env = { Path: `${first};${second}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    assert.deepEqual(resolveCommandInvocation("npm", ["whoami", "--registry=https://registry.npmjs.org/"], { platform: "win32", env }), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `""${join(first, "npm.CMD")}" whoami --registry=https://registry.npmjs.org/"`],
      windowsVerbatimArguments: true,
    });
    assert.deepEqual(resolveCommandInvocation("gh", ["--version"], { platform: "win32", env }), { command: "gh", args: ["--version"], windowsVerbatimArguments: false });
    assert.equal(resolveCommandInvocation("tool", [], { platform: "win32", env }).windowsVerbatimArguments, true);
    assert.deepEqual(resolveCommandInvocation("missing", ["x"], { platform: "win32", env }), { command: "missing", args: ["x"], windowsVerbatimArguments: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the resolved invocation launches the installed npm on this host", () => {
  const invocation = resolveCommandInvocation("npm", ["--version"]);
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  assert.equal(result.error, undefined, describeSpawnFailure(result));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
