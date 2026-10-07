import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExportFile, writeExportFile } from "../config/settings-export.js";
import type { SettingsExportData } from "../config/settings-export.js";

/*
FNXC:SettingsPersistence 2026-10-07-17:59:
Concurrent exports to one path must each publish a complete file; a shared fixed temp name let one rename consume another writer's temp file and fail it with ENOENT.
*/
describe("writeExportFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-settings-export-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("publishes a complete file for every concurrent writer to the same path", async () => {
    const target = join(dir, "export.json");
    const payloads = Array.from({ length: 8 }, (_, index) => ({
      version: 1,
      exportedAt: `2026-10-07T00:00:0${index}.000Z`,
      global: { ntfyTopic: `topic-${index}` },
    }) as unknown as SettingsExportData);

    await Promise.all(payloads.map((payload) => writeExportFile(target, payload)));

    const written = await readExportFile(target);
    expect(payloads.map((payload) => payload.exportedAt)).toContain(written.exportedAt);
    expect((await readdir(dir)).sort()).toEqual(["export.json"]);
  });
});
