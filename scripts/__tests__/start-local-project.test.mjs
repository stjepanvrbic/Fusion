import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { hasLocalProjectMigrationInput, pnpmSpawnSpec, resolvePnpmLauncher } from "../lib/start-local-project.mjs";

test("local startup recognizes project identity and legacy migration input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fusion-start-local-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".fusion"));

  assert.equal(hasLocalProjectMigrationInput(root), false);

  await writeFile(join(root, ".fusion", "fusion.db"), "");
  assert.equal(hasLocalProjectMigrationInput(root), true);

  await rm(join(root, ".fusion", "fusion.db"));
  const db = new DatabaseSync(join(root, ".fusion", "fusion.db"));
  db.exec("CREATE TABLE migration_input (id INTEGER PRIMARY KEY)");
  db.close();
  assert.equal(hasLocalProjectMigrationInput(root), true);

  await rm(join(root, ".fusion", "fusion.db"));
  await writeFile(join(root, ".fusion", "fusion.db"), "malformed legacy input");
  assert.equal(hasLocalProjectMigrationInput(root), false);

  await rm(join(root, ".fusion", "fusion.db"));
  await mkdir(join(root, ".fusion", "fusion.db"));
  assert.equal(hasLocalProjectMigrationInput(root), false);

  await rm(join(root, ".fusion", "fusion.db"), { recursive: true });
  await writeFile(join(root, ".fusion", "project.json"), "{}");
  assert.equal(hasLocalProjectMigrationInput(root), true);
});

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
`pnpm local` launches pnpm without a shell for every install method: pnpm's own JS entry, a native pnpm.exe,
and a `.cmd` shim on Windows (through cmd.exe, arguments escaped), including install paths with spaces.
*/
const files = (...paths) => {
  const lower = new Set(paths.map((p) => p.toLowerCase()));
  return (p) => lower.has(p.toLowerCase());
};

test("pnpm launcher prefers pnpm's own JS entry through the current node", () => {
  const launcher = resolvePnpmLauncher({
    platform: "win32",
    env: { npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs" },
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    isFile: files("C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs"),
  });
  assert.deepEqual(pnpmSpawnSpec(launcher, ["install", "--frozen-lockfile"]), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs", "install", "--frozen-lockfile"],
    windowsVerbatimArguments: false,
  });
});

test("pnpm launcher runs a native pnpm.exe directly and ignores npm's execpath", () => {
  const native = resolvePnpmLauncher({ platform: "win32", env: { npm_execpath: "C:\\pnpm\\pnpm.exe" }, isFile: files("C:\\pnpm\\pnpm.exe") });
  assert.deepEqual(pnpmSpawnSpec(native, ["exec"]), { command: "C:\\pnpm\\pnpm.exe", args: ["exec"], windowsVerbatimArguments: false });

  const viaNpm = resolvePnpmLauncher({
    platform: "linux",
    env: { npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" },
    isFile: () => true,
  });
  assert.deepEqual(pnpmSpawnSpec(viaNpm, ["exec"]), { command: "pnpm", args: ["exec"], windowsVerbatimArguments: false });
});

test("pnpm launcher wraps a Windows .cmd shim found on PATH in cmd.exe with escaped arguments", () => {
  const env = { PATH: "C:\\Users\\me\\AppData\\Roaming\\npm", PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const launcher = resolvePnpmLauncher({ platform: "win32", env, isFile: files("C:\\Users\\me\\AppData\\Roaming\\npm\\pnpm.cmd") });
  assert.equal(launcher.kind, "cmd-shim");
  assert.equal(launcher.command, "C:\\Users\\me\\AppData\\Roaming\\npm\\pnpm.cmd");
  const spec = pnpmSpawnSpec(launcher, ["exec", "tsx", "C:\\Temp\\a b\\register.mts"], env);
  assert.equal(spec.command, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(spec.args[3].includes("pnpm.cmd"));
});

test("pnpm launcher never wraps pnpm in cmd.exe off Windows, even with a .cmd file on PATH", () => {
  const env = { PATH: "/usr/local/bin:/opt/pnpm", PATHEXT: ".CMD" };
  const launcher = resolvePnpmLauncher({ platform: "linux", env, isFile: () => true });
  assert.equal(launcher.kind, "native");
  assert.deepEqual(pnpmSpawnSpec(launcher, ["exec", "tsx", "/tmp/a b/register.mts"], env), {
    command: "pnpm",
    args: ["exec", "tsx", "/tmp/a b/register.mts"],
    windowsVerbatimArguments: false,
  });
});

test("pnpm launcher leaves a missing pnpm bare so the spawn reports ENOENT", () => {
  const launcher = resolvePnpmLauncher({ platform: "win32", env: { PATH: "C:\\nothing" }, isFile: () => false });
  assert.deepEqual(pnpmSpawnSpec(launcher, ["install"]), { command: "pnpm", args: ["install"], windowsVerbatimArguments: false });
});

test("pnpm .cmd shim launch delivers arguments unchanged on Windows", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fusion start local "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const echoScript = join(root, "echo.cjs");
  await writeFile(echoScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  await writeFile(join(root, "pnpm.cmd"), `@"${process.execPath}" "${echoScript}" %*\r\n`);
  const env = { ...process.env, PATH: root, PATHEXT: ".CMD", npm_execpath: "" };
  const args = ["exec", "tsx", join(root, "register project.mts"), "--name", "a&b"];

  const spec = pnpmSpawnSpec(resolvePnpmLauncher({ platform: "win32", env }), args, env);
  const result = spawnSync(spec.command, spec.args, { encoding: "utf8", windowsVerbatimArguments: spec.windowsVerbatimArguments });

  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.stdout), args);
});
