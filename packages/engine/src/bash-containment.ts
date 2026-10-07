import { homedir } from "node:os";

/*
FNXC:BashContainment 2026-07-26-12:40:
Security incident follow-up: an agent's real escalation chain was
`bash("cat ~/.fusion/settings.json")` (agents run as the same OS user, so the
0600 file holding `daemonToken` is readable) → find its own pending approval
request → `curl` the approvals decision API to approve itself. Fixing the
decision route alone is insufficient while bash can read the token.

This module is a PRIVILEGE-ESCALATION FLOOR, not a permission preference:
it holds UNCONDITIONALLY at every permission preset including the default
`unrestricted`. Ordinary bash permission gating stays policy-driven (see
agent-action-gate.ts); this floor only denies the narrow set of commands
that let an agent escalate its OWN privileges:
  1. reads of the Fusion global config / daemon token (~/.fusion, any
     .fusion/settings.json spelling, FUSION_DAEMON_TOKEN / daemonToken refs),
  2. reads of common same-user credential stores (~/.ssh, ~/.aws, ~/.netrc,
     ~/.npmrc, ~/.config/gh, ~/.docker/config.json, ~/.gnupg, ~/.kube),
  3. self-directed calls to the approvals API (/api/approvals, fn_token=).

HONESTY / LIMITATIONS (do not oversell this): matching happens on a
normalized copy of the command STRING (quotes/backslashes stripped, $HOME and
the literal home directory folded to ~, lowercased). That defeats the trivial
bypasses (`cat ~/.fus''ion/settings.json`, `"$HOME"/.fusion`, absolute home
paths) but NOT determined indirection: base64-built paths, variable
concatenation (a=fus; b=ion; cat ~/.$a$b/...), glob spelling (~/.f*sion),
symlinks created first, python/node one-liners, or reading via a spawned
interpreter. String inspection of shell cannot be sound. This floor raises
the cost of the KNOWN escalation chain and creates an audit-visible denial;
real containment requires OS-level isolation (separate user / sandbox),
which is out of scope here. Deny messages are deliberately explicit so a
probing agent's attempts are visible in session logs.

FNXC:BashContainment 2026-10-07-17:57:
Win32 has no kernel sandbox backend, so this floor must hold for native Windows spellings too: backslash and mixed separators, quoted paths, any drive-letter case, %USERPROFILE%, %HOMEDRIVE%%HOMEPATH%, $USERPROFILE, $env:USERPROFILE and MSYS /c/... home paths.
*/

export interface BashContainmentVerdict {
  allowed: boolean;
  /** Stable rule id for logs/tests when denied. */
  rule?: string;
  /** Human-readable denial reason (safe to surface to the agent). */
  reason?: string;
}

interface ContainmentRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

/*
FNXC:BashContainment 2026-07-26-12:40:
Rules match the NORMALIZED command (see normalizeCommand). Home-anchored
patterns use `~/.<dir>` because normalization folds $HOME/${HOME}/absolute
home spellings to `~`. `/users/<name>/` and `/home/<name>/` cover OTHER
users' homes which normalization cannot fold.
*/
const RULES: readonly ContainmentRule[] = [
  {
    id: "fusion-global-dir",
    pattern: /(?:~|\/users\/[^/\s]+|\/home\/[^/\s]+)\/\.fusion\b/,
    reason: "access to the global Fusion directory (daemon token / global settings) is not permitted from agent sessions",
  },
  {
    id: "fusion-settings-file",
    pattern: /\.fusion\/settings\.json/,
    reason: "access to Fusion settings.json is not permitted from agent sessions",
  },
  {
    id: "fusion-daemon-token",
    pattern: /fusion_daemon_token|fusion_dashboard_token|daemontoken/,
    reason: "referencing the Fusion daemon token is not permitted from agent sessions",
  },
  {
    id: "credential-store",
    pattern: /(?:~|\/users\/[^/\s]+|\/home\/[^/\s]+)\/(?:\.ssh|\.aws|\.netrc|\.npmrc|\.gnupg|\.kube|\.config\/gh|\.docker\/config\.json)\b/,
    reason: "access to user credential stores is not permitted from agent sessions",
  },
  {
    id: "approvals-api",
    pattern: /\/api\/approvals|fn_token=/,
    reason: "calling the Fusion approvals API from a shell is not permitted from agent sessions (approvals are decided by the operator)",
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HOME_DIR = homedir();

export interface BashContainmentOptions {
  /** Home directory folded to `~`; defaults to the current user's home. Tests inject a Windows home to prove Windows spellings on any host. */
  homeDir?: string;
}

/*
FNXC:BashContainment 2026-10-07-17:57:
Windows home-variable spellings fold to `~` so `%USERPROFILE%\.fusion`, `$env:USERPROFILE\.ssh` and `%HOMEDRIVE%%HOMEPATH%\.aws` hit the same rules as `~/.fusion`.
Applied to the lowercased command; drive+path pairs fold before the lone path variable so no drive letter is left in front of `~`.
*/
const HOME_VARIABLE_PATTERNS: readonly RegExp[] = [
  /%homedrive%%homepath%/g,
  /\$\{?env:homedrive\}?\$\{?env:homepath\}?/g,
  /\$\{?homedrive\}?\$\{?homepath\}?/g,
  /%userprofile%|%homepath%|%home%/g,
  /\$\{?env:(?:userprofile|homepath|home)\}?/g,
  /\$\{?(?:userprofile|homepath)\}?(?![a-z0-9_])/g,
  /\$\{home\}|\$home(?![a-z0-9_])/g,
];

/** Every forward-slash spelling of `homeDir` (native or drive-letter, plus MSYS `/c/...`), lowercased, longest first. */
function homeSpellings(homeDir: string): string[] {
  const forward = homeDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!forward || forward === "/") return [];
  const spellings = new Set<string>([forward]);
  const drive = /^([a-z]):(\/.*)$/.exec(forward);
  if (drive) spellings.add(`/${drive[1]}${drive[2]}`);
  return [...spellings].sort((a, b) => b.length - a.length);
}

function foldHome(lowercased: string, homeDir: string): string {
  let folded = lowercased;
  for (const pattern of HOME_VARIABLE_PATTERNS) folded = folded.replace(pattern, "~");
  for (const spelling of homeSpellings(homeDir)) {
    folded = folded.replace(new RegExp(`${escapeRegExp(spelling)}(?=/|\\s|$)`, "g"), "~");
  }
  return folded;
}

/**
 * FNXC:BashContainment 2026-07-26-12:40:
 * Normalization defeats quote-splitting and $HOME spellings only. Keep this
 * pure and dependency-free so it is trivially unit-testable.
 *
 * FNXC:BashContainment 2026-10-07-17:57:
 * This is the POSIX-escape spelling: backslashes are shell escapes and are removed (`.fus\ion` becomes `.fusion`).
 * evaluateBashContainment also checks the Windows-separator spelling, because stripping backslashes alone collapsed `C:\Users\x\.fusion` into an unmatchable `c:usersx.fusion`.
 */
export function normalizeBashCommandForContainment(command: string, options: BashContainmentOptions = {}): string {
  const unquoted = command.replace(/["']/g, "").toLowerCase();
  return foldHome(unquoted.replace(/\\/g, ""), options.homeDir ?? HOME_DIR);
}

/**
 * FNXC:BashContainment 2026-10-07-17:57:
 * The Windows-separator spelling: backslashes are path separators (cmd.exe, PowerShell, quoted Git Bash operands) and separator runs collapse to one `/`.
 * The floor denies the same target in every path spelling native to the host OS, so both spellings are checked and either match denies.
 */
function normalizeWindowsSeparatorsForContainment(command: string, homeDir: string): string {
  const unquoted = command.replace(/["']/g, "").toLowerCase();
  return foldHome(unquoted.replace(/[\\/]+/g, "/"), homeDir);
}

/** Evaluate the unconditional containment floor for one bash command string. */
export function evaluateBashContainment(command: string, options: BashContainmentOptions = {}): BashContainmentVerdict {
  if (typeof command !== "string" || command.trim() === "") {
    return { allowed: true };
  }
  const homeDir = options.homeDir ?? HOME_DIR;
  const spellings = [
    normalizeBashCommandForContainment(command, { homeDir }),
    normalizeWindowsSeparatorsForContainment(command, homeDir),
  ];
  for (const rule of RULES) {
    if (spellings.some((spelling) => rule.pattern.test(spelling))) {
      return { allowed: false, rule: rule.id, reason: rule.reason };
    }
  }
  return { allowed: true };
}

/** Stable message shown to the agent on denial. */
export function buildBashContainmentDenialMessage(verdict: BashContainmentVerdict): string {
  return (
    `Command blocked by Fusion privilege-escalation containment (${verdict.rule ?? "containment"}): ` +
    `${verdict.reason ?? "not permitted"}. This boundary applies at every permission preset; ` +
    `do not attempt to work around it — ask the operator instead.`
  );
}
