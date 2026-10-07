/*
FNXC:SkillInstall 2026-10-07-17:57:
Skill installation parameters are data, never shell syntax. The dashboard route, the `fn skills install` CLI command and the `fn_skills_install` extension tool all build their installer invocation here.
The old surfaces passed a weakly validated `owner/repo` source and an unvalidated skill name to `spawn("npx", args, { shell: true })`, so `a/b&calc` or `--skill "x & powershell ..."` ran extra commands under cmd.exe or sh.
Inputs must match a strict slug grammar, and the installer is spawned without `shell: true`. On win32 `npx` is a `.cmd` shim that Node refuses to spawn directly, so it runs through `cmd.exe /d /s /c` with only grammar-validated tokens; the grammar excludes every cmd.exe and POSIX shell metacharacter, so no token can change the command.
*/

/** GitHub-style `owner/repo`: each segment starts alphanumeric (no option injection) and holds only `[A-Za-z0-9_.-]`. */
export const SKILL_INSTALL_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** A single skill directory name: starts alphanumeric and holds only `[A-Za-z0-9_.-]`. */
export const SKILL_INSTALL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type SkillInstallInvocation =
  | { ok: true; command: string; args: string[] }
  | { ok: false; code: "invalid_source" | "invalid_skill"; error: string };

export interface SkillInstallInvocationInput {
  source: string;
  skill?: string;
  platform?: NodeJS.Platform;
  /** cmd.exe path on win32; defaults to `%ComSpec%`. */
  comSpec?: string;
}

export function isValidSkillInstallSource(source: string): boolean {
  return SKILL_INSTALL_SOURCE_PATTERN.test(source);
}

export function isValidSkillInstallName(skill: string): boolean {
  return SKILL_INSTALL_NAME_PATTERN.test(skill);
}

/**
 * Build the shell-free `npx skills add` invocation for one validated install request.
 * Callers spawn `command` with `args` and must not set `shell: true`.
 */
export function buildSkillInstallInvocation(input: SkillInstallInvocationInput): SkillInstallInvocation {
  const source = input.source.trim();
  if (!isValidSkillInstallSource(source)) {
    return { ok: false, code: "invalid_source", error: "Invalid source format. Use owner/repo." };
  }
  const skill = input.skill?.trim();
  if (skill && !isValidSkillInstallName(skill)) {
    return {
      ok: false,
      code: "invalid_skill",
      error: "Invalid skill name. Use letters, digits, '.', '_' or '-', starting with a letter or digit.",
    };
  }

  const npxArgs = ["skills", "add", source];
  if (skill) npxArgs.push("--skill", skill);
  // Non-interactive mode (-y) targeting the pi agent (-a pi).
  npxArgs.push("-y", "-a", "pi");

  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    const comSpec = input.comSpec ?? process.env.ComSpec ?? "cmd.exe";
    return { ok: true, command: comSpec, args: ["/d", "/s", "/c", "npx", ...npxArgs] };
  }
  return { ok: true, command: "npx", args: npxArgs };
}
