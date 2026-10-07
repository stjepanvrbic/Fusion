import { describe, expect, it } from "vitest";
import { buildSkillInstallInvocation } from "../cli/skill-install-command.js";

/*
FNXC:SkillInstall 2026-10-07-17:57:
Installation parameters are data, never shell syntax: every metacharacter spelling is refused in both fields, and valid input yields a shell-free invocation on POSIX and win32.
*/
const HOSTILE = [
  "owner/repo&echo INJECTED",
  "owner/repo|calc",
  "owner/repo;id",
  "owner/repo^&calc",
  "owner/re po",
  "owner/\"repo\"",
  "owner/'repo'",
  "owner/%PATH%",
  "owner/$(id)",
  "owner/`id`",
  "owner/repo>out",
  "owner/!x!",
  "-owner/repo",
  "owner/-repo",
  "owner/repo/extra",
  "invalid",
];

describe("buildSkillInstallInvocation", () => {
  for (const source of HOSTILE) {
    it(`refuses source ${JSON.stringify(source)}`, () => {
      expect(buildSkillInstallInvocation({ source, platform: "linux" })).toMatchObject({ ok: false, code: "invalid_source" });
    });
  }

  const hostileSkills = [
    "demo & echo FUSION_MARKER & rem",
    "x & powershell -c calc",
    "x|calc",
    "x;id",
    "x^&calc",
    "my skill",
    "\"quoted\"",
    "'quoted'",
    "%PATH%",
    "$(id)",
    "`id`",
    "x>out",
    "!x!",
    "a/b",
    "--help",
  ];
  for (const skill of hostileSkills) {
    it(`refuses skill ${JSON.stringify(skill)}`, () => {
      expect(buildSkillInstallInvocation({ source: "owner/repo", skill, platform: "win32" })).toMatchObject({ ok: false, code: "invalid_skill" });
    });
  }

  it("builds a direct npx invocation on POSIX", () => {
    expect(buildSkillInstallInvocation({ source: " firebase/agent-skills ", skill: "firebase-basics", platform: "linux" })).toEqual({
      ok: true,
      command: "npx",
      args: ["skills", "add", "firebase/agent-skills", "--skill", "firebase-basics", "-y", "-a", "pi"],
    });
  });

  /*
  FNXC:ProcessLifecycle 2026-10-07-18:00:
  On win32 no install token reaches cmd.exe: npx.cmd is unwrapped to node + npx-cli.js, and an unwrappable shim yields the bare name so the spawn fails instead of falling back to a shell.
  */
  it("unwraps the npx shim to node on win32 so no token reaches cmd.exe", () => {
    const files = new Map([
      ["c:\\nodejs\\npx.cmd", "SET \"NODE_EXE=%~dp0\\node.exe\"\r\nSET \"NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js\"\r\n\"%NODE_EXE%\" \"%NPX_CLI_JS%\" %*\r\n"],
      ["c:\\nodejs\\node.exe", ""],
      ["c:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js", ""],
    ]);
    const launchDeps = {
      env: { PATH: "C:\\nodejs", PATHEXT: ".EXE;.CMD" },
      isFile: (p: string) => files.has(p.toLowerCase()),
      readFile: (p: string) => files.get(p.toLowerCase()) ?? "",
    };
    expect(buildSkillInstallInvocation({ source: "Owner.Name/repo_1", platform: "win32", launchDeps })).toEqual({
      ok: true,
      command: "C:\\nodejs\\node.exe",
      args: ["C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js", "skills", "add", "Owner.Name/repo_1", "-y", "-a", "pi"],
    });
  });

  it("returns the bare npx name rather than a shell when the win32 shim cannot be unwrapped", () => {
    const launchDeps = {
      env: { PATH: "C:\\nodejs", PATHEXT: ".CMD" },
      isFile: (p: string) => p.toLowerCase() === "c:\\nodejs\\npx.cmd",
      readFile: () => "@echo off\r\ncall something-else %*\r\n",
    };
    expect(buildSkillInstallInvocation({ source: "owner/repo", platform: "win32", launchDeps })).toEqual({
      ok: true,
      command: "npx",
      args: ["skills", "add", "owner/repo", "-y", "-a", "pi"],
    });
  });

  it("treats a blank skill as install-all", () => {
    expect(buildSkillInstallInvocation({ source: "owner/repo", skill: "  ", platform: "linux" })).toEqual({
      ok: true,
      command: "npx",
      args: ["skills", "add", "owner/repo", "-y", "-a", "pi"],
    });
  });
});
