import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractEffectiveWriteScopeFromPrompt } from "@fusion/core";
import { ScopeAutoWidenPersistError, appendAutoWidenedScopeToPrompt } from "../merge/merger-scope-auto-widen.js";
import {
  QUOTED_DECOY_PATH,
  originalDescriptionRegionText,
  plannedPromptWithQuotedScope,
} from "./_quoted-file-scope-prompt.js";

/*
FNXC:FileScope 2026-10-11-14:50:
Merge-time auto-widen writes PROMPT.md directly. Its entries must land in the plan's File Scope section that the squash invariant reads, never in a list quoted in the Original Description.
*/
describe("appendAutoWidenedScopeToPrompt", () => {
  const taskId = "KB-1";
  let taskDir: string;
  const store = { getTaskDir: () => taskDir };
  const promptPath = () => join(taskDir, "PROMPT.md");

  beforeEach(() => {
    taskDir = mkdtempSync(join(tmpdir(), "fusion-auto-widen-prompt-"));
  });
  afterEach(() => rmSync(taskDir, { recursive: true, force: true }));

  it("appends marked entries to the plan's section and leaves the request byte-identical", async () => {
    const prompt = plannedPromptWithQuotedScope();
    writeFileSync(promptPath(), prompt);

    const added = await appendAutoWidenedScopeToPrompt({ store, taskId, files: ["packages/engine/src/widened.ts"] });

    const written = readFileSync(promptPath(), "utf-8");
    expect(added).toEqual(["packages/engine/src/widened.ts"]);
    expect(written).toContain(`- \`packages/engine/src/widened.ts\` <!-- scopeAutoWiden ${taskId} -->\n## Steps`);
    expect(originalDescriptionRegionText(written)).toBe(originalDescriptionRegionText(prompt));
    expect(extractEffectiveWriteScopeFromPrompt(written)).toEqual(["packages/engine/src/real.ts", "packages/engine/src/widened.ts"]);
  });

  it("adds a file only the quoted request lists, and adds nothing on a repeat", async () => {
    writeFileSync(promptPath(), plannedPromptWithQuotedScope());

    expect(await appendAutoWidenedScopeToPrompt({ store, taskId, files: [QUOTED_DECOY_PATH] })).toEqual([QUOTED_DECOY_PATH]);
    const afterFirst = readFileSync(promptPath(), "utf-8");
    expect(await appendAutoWidenedScopeToPrompt({ store, taskId, files: [QUOTED_DECOY_PATH] })).toEqual([]);
    expect(readFileSync(promptPath(), "utf-8")).toBe(afterFirst);
  });

  it("rejects a prompt whose only File Scope list is quoted in the request", async () => {
    const prompt = plannedPromptWithQuotedScope(null);
    writeFileSync(promptPath(), prompt);

    await expect(
      appendAutoWidenedScopeToPrompt({ store, taskId, files: ["packages/engine/src/widened.ts"] }),
    ).rejects.toBeInstanceOf(ScopeAutoWidenPersistError);
    expect(readFileSync(promptPath(), "utf-8")).toBe(prompt);
  });
});
