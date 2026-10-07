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

  it("routes the npx shim through cmd.exe with only validated tokens on win32", () => {
    expect(buildSkillInstallInvocation({ source: "Owner.Name/repo_1", platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      ok: true,
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npx", "skills", "add", "Owner.Name/repo_1", "-y", "-a", "pi"],
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
