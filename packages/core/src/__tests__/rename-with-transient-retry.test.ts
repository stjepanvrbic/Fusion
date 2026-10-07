/*
FNXC:WindowsAtomicWrites 2026-10-07-21:40:
Temp-file-then-rename publication of task.json, PROMPT.md, config.json and agent bundle files must survive a transient
Windows sharing failure, and must not mask a real failure or wait on POSIX.
*/
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renameWithTransientRetry, WIN32_RENAME_RETRY_POLICY } from "../fs/rename-with-transient-retry.js";

const fsMock = vi.hoisted(() => ({ failures: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      const code = fsMock.failures.shift();
      if (code) throw Object.assign(new Error(`${code}: injected rename failure`), { code });
      return actual.rename(from, to);
    }),
  };
});

const sharingError = (code: string) => Object.assign(new Error(code), { code });
const noSleep = async () => {};

describe("renameWithTransientRetry", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries %s on win32 until the rename succeeds", async (code) => {
    const rename = vi.fn()
      .mockRejectedValueOnce(sharingError(code))
      .mockRejectedValueOnce(sharingError(code))
      .mockResolvedValueOnce(undefined);
    await renameWithTransientRetry("a.tmp", "a", { platform: "win32", rename, sleep: noSleep });
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("gives up after the bounded attempts with the last sharing error", async () => {
    const rename = vi.fn().mockRejectedValue(sharingError("EPERM"));
    await expect(renameWithTransientRetry("a.tmp", "a", { platform: "win32", rename, sleep: noSleep })).rejects.toMatchObject({ code: "EPERM" });
    expect(rename).toHaveBeenCalledTimes(WIN32_RENAME_RETRY_POLICY.maxAttempts);
  });

  it("does not retry a non-transient failure or any failure on POSIX", async () => {
    const enoent = vi.fn().mockRejectedValue(sharingError("ENOENT"));
    await expect(renameWithTransientRetry("a.tmp", "a", { platform: "win32", rename: enoent, sleep: noSleep })).rejects.toMatchObject({ code: "ENOENT" });
    expect(enoent).toHaveBeenCalledTimes(1);

    const posix = vi.fn().mockRejectedValue(sharingError("EPERM"));
    await expect(renameWithTransientRetry("a.tmp", "a", { platform: "linux", rename: posix, sleep: noSleep })).rejects.toMatchObject({ code: "EPERM" });
    expect(posix).toHaveBeenCalledTimes(1);
  });
});

describe("atomic file publishers retry transient Windows rename failures", () => {
  const roots: string[] = [];
  const originalPlatform = process.platform;
  afterEach(async () => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    fsMock.failures.length = 0;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "fusion-rename-retry-"));
    roots.push(directory);
    return directory;
  }

  it("writePromptFileAtomic publishes PROMPT.md after two EPERM failures", async () => {
    const { writePromptFileAtomic } = await import("../task-store/prompt-file.js");
    const directory = await root();
    Object.defineProperty(process, "platform", { value: "win32" });
    fsMock.failures.push("EPERM", "EPERM");

    await writePromptFileAtomic(join(directory, "PROMPT.md"), "# Plan\n");

    expect(await readFile(join(directory, "PROMPT.md"), "utf8")).toBe("# Plan\n");
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writeTaskJsonFileImpl publishes task.json after two EBUSY failures", async () => {
    const { writeTaskJsonFileImpl } = await import("../task-store/task-row-mappers.js");
    const directory = await root();
    Object.defineProperty(process, "platform", { value: "win32" });
    fsMock.failures.push("EBUSY", "EBUSY");
    const store = { clearStartupSlimListMemo: () => {}, suppressWatcher: () => {} };

    await writeTaskJsonFileImpl(store as never, directory, { id: "FN-1", description: "mirror" } as never);

    expect(JSON.parse(await readFile(join(directory, "task.json"), "utf8"))).toMatchObject({ id: "FN-1" });
  });
});
