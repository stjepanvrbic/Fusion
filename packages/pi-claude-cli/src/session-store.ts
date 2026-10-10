/**
 * Claude CLI session lookup and session-mode recovery.
 *
 * FNXC:ClaudeCliSession 2026-10-10-20:07:
 * A turn must never fail because the provider guessed wrong about whether the CLI already has a session.
 * The old rule resumed whenever the context held more than one message, but Fusion opens review and step sessions with several messages and a session id the CLI has never seen, so every such turn failed with "No conversation found with session ID".
 * The mode is now decided from the CLI's own transcript store, and a wrong decision is corrected once from the CLI's specific error instead of failing the turn.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `resume` continues a session the CLI has on disk; `new` starts one. */
export type CliSessionMode = "resume" | "new";

/** Session ids become file names; anything else cannot name a transcript. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * Whether the CLI has a transcript for this session id.
 *
 * Claude Code documents transcripts at `projects/<project>/<session>.jsonl` under `~/.claude` (or `CLAUDE_CONFIG_DIR`); see https://code.claude.com/docs/en/claude-directory.
 * The `<project>` naming is not documented and the CLI resumes a session from any working directory, so every project directory is checked.
 */
export function claudeSessionExists(sessionId: string): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  const projectsDir = join(claudeConfigDir(), "projects");
  let projects: string[];
  try {
    projects = readdirSync(projectsDir);
  } catch {
    return false;
  }
  return projects.some((project) =>
    statSync(join(projectsDir, project, `${sessionId}.jsonl`), { throwIfNoEntry: false })?.isFile() === true,
  );
}

/** Session mode for a turn's first attempt. */
export function resolveCliSessionMode(sessionId: string | undefined): CliSessionMode {
  return sessionId && claudeSessionExists(sessionId) ? "resume" : "new";
}

/**
 * The mode to retry in when the CLI rejected the attempted one, or undefined for any other failure.
 * Messages observed from Claude Code 2.1.296: `--resume` of an unknown id reports "No conversation found with session ID: <id>" in an `error_during_execution` result, and `--session-id` of an existing id exits 1 with "Error: Session ID <id> is already in use."
 */
export function sessionModeAfterRejection(attempted: CliSessionMode, failure: string): CliSessionMode | undefined {
  if (attempted === "resume" && /No conversation found with session ID/i.test(failure)) return "new";
  if (attempted === "new" && /Session ID \S+ is already in use/i.test(failure)) return "resume";
  return undefined;
}
