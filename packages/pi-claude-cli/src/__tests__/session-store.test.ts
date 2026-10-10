import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionExists, resolveCliSessionMode, sessionModeAfterRejection } from "../session-store";

describe("Claude CLI session store", () => {
  let configDir: string;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "fn-claude-config-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  function seed(project: string, fileName: string) {
    mkdirSync(join(configDir, "projects", project), { recursive: true });
    writeFileSync(join(configDir, "projects", project, fileName), "");
  }

  it("finds a transcript in any project directory", () => {
    seed("C--work-one", "other-session.jsonl");
    seed("C--work-two", "sess-1.jsonl");

    expect(claudeSessionExists("sess-1")).toBe(true);
    expect(resolveCliSessionMode("sess-1")).toBe("resume");
  });

  it("treats a session without a transcript as new", () => {
    seed("C--work-one", "sess-1.jsonl.superseded-20261010");
    mkdirSync(join(configDir, "projects", "C--work-one", "sess-2.jsonl"));

    expect(claudeSessionExists("sess-1")).toBe(false);
    expect(claudeSessionExists("sess-2")).toBe(false);
    expect(resolveCliSessionMode("sess-1")).toBe("new");
    expect(resolveCliSessionMode(undefined)).toBe("new");
  });

  it("treats a missing projects directory and an id that cannot name a file as new", () => {
    expect(claudeSessionExists("sess-1")).toBe(false);
    seed("C--work-one", "sess-1.jsonl");
    expect(claudeSessionExists("../C--work-one/sess-1")).toBe(false);
  });

  it("maps each CLI rejection to the other mode and nothing else", () => {
    expect(sessionModeAfterRejection("resume", "Claude CLI result error_during_execution (is_error): No conversation found with session ID: abc")).toBe("new");
    expect(sessionModeAfterRejection("new", "Claude CLI exited with code 1: Error: Session ID abc is already in use.")).toBe("resume");
    expect(sessionModeAfterRejection("new", "No conversation found with session ID: abc")).toBeUndefined();
    expect(sessionModeAfterRejection("resume", "Error: Session ID abc is already in use.")).toBeUndefined();
    expect(sessionModeAfterRejection("resume", "Claude CLI exited with code 1: not authenticated")).toBeUndefined();
  });
});
