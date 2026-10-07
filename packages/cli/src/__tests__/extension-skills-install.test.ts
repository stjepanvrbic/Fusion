import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSkillInstallInvocation } from "@fusion/core";
import { createMockApi, registerExtension, requireTool } from "./pg-extension-harness.js";

/*
FNXC:SkillInstall 2026-10-07-17:57:
fn_skills_install receives model-chosen text. Shell metacharacters in either field are refused before any process starts, and a valid request spawns the installer without a shell.
*/
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

function exitingChild(code: number) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
  });
  process.nextTick(() => child.emit("close", code));
  process.nextTick(() => child.emit("exit", code));
  return child;
}

describe("fn_skills_install argument boundary", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fn-skills-install-"));
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => exitingChild(0));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const hostile: Array<Record<string, string>> = [
    { source: "owner/repo&echo INJECTED" },
    { source: "a/b;id" },
    { source: "owner/repo|calc" },
    { source: "owner/repo", skill: "x & powershell -c calc" },
    { source: "owner/repo", skill: "demo & echo FUSION_MARKER & rem" },
    { source: "owner/repo", skill: "%PATH%" },
    { source: "owner/repo", skill: "$(id)" },
    { source: "owner/repo", skill: "\"quoted\"" },
  ];
  for (const params of hostile) {
    it(`refuses ${JSON.stringify(params)} without spawning`, async () => {
      const api = createMockApi();
      registerExtension(api);
      const result = await requireTool(api, "fn_skills_install").execute("c", params, undefined, undefined, { cwd });
      expect(result.isError).toBe(true);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  }

  it("spawns the installer without a shell for a valid request", async () => {
    const api = createMockApi();
    registerExtension(api);
    await requireTool(api, "fn_skills_install").execute("c", { source: "firebase/agent-skills", skill: "firebase-basics" }, undefined, undefined, { cwd });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(options.shell).toBeUndefined();
    expect(args.slice(-8)).toEqual(["skills", "add", "firebase/agent-skills", "--skill", "firebase-basics", "-y", "-a", "pi"]);
    const expected = buildSkillInstallInvocation({ source: "firebase/agent-skills", skill: "firebase-basics" });
    expect(expected.ok && command === expected.command).toBe(true);
    expect(command).not.toMatch(/(cmd\.exe|\.cmd|\.bat)$/i);
  });
});
