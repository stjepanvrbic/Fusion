/*
 * FNXC:CliSkillsGetRoute 2026-10-08-00:26:
 * `fn skills get` runs through the lightweight dist/skills-get-bin.js entry so a built-in guide prints without full CLI bootstrap (FN-9395).
 * Global terminal flags (--version, -v, --help, -h) and invalid global flag forms (a duplicate or valueless --project/-P) keep full CLI parsing, precedence, and validation.
 * This module stays side-effect free so the launcher's routing decision is testable in-process without spawning a cold full-CLI process.
 */

/**
 * @param {readonly string[]} argv CLI arguments after the node executable and script path.
 * @returns {boolean} true when the lightweight skills-get entry should handle the invocation.
 */
export function isSkillsGetInvocation(argv) {
  const cleanedArgs = [];
  let hasProjectFlag = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h") return false;
    if (arg === "--quiet" || arg === "-q" || arg === "--skip-onboarding") continue;
    if (arg === "--project" || arg === "-P") {
      const projectName = argv[index + 1];
      if (hasProjectFlag || !projectName || projectName.startsWith("-")) return false;
      hasProjectFlag = true;
      index += 1;
      continue;
    }
    cleanedArgs.push(arg);
  }
  return cleanedArgs[0] === "skills" && cleanedArgs[1] === "get";
}
