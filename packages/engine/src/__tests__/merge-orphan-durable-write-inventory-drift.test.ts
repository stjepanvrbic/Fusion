/*
FNXC:MergeReliability 2026-08-09-12:00:
This ratchet proves completeness only over the helper's pinned reachability closure and derived
TaskStore writer surface, with declared boundaries. It runs in engine affected/full-suite lanes,
not the curated blocking engine-core gate; a hand-written writer list or textual scanner would be
a blind spot.

FNXC:MergeReliability 2026-10-08-02:04:
KB-012: it is also a changed-only `pnpm test` guard companion (scripts/test-changed.mjs GUARD_COMPANION_TESTS),
so engine merge, heartbeat and dashboard route edits run it. Manifest entries never persist `lineHint`.

FNXC:MergeReliability 2026-08-11-21:59:
Run `FUSION_UPDATE_MERGE_INVENTORY=1 pnpm --filter @fusion/engine exec vitest run
src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts` to update derivable structure.
It preserves human verdicts only by call-site id; new rows deliberately receive `pending:classify`
and stay red until a reviewer supplies a real lifecycle classification.
*/
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import rawManifest from "./fixtures/merge-orphan-durable-write-inventory.json";
import { assertInventoryRegenerationInputs, buildInventoryManifest, classifyReceiverForTest, deriveDurableWriterSurface, deriveMergeDurableWriteCallSites, deriveMergeReachableModules, deriveReceiverCensus, receiverSuspectsForTest, type InventoryEntry, type InventoryManifest } from "./_merge-durable-write-callsites.js";

const taskId = /^FN-\d+$/;
const manifest = rawManifest as InventoryManifest;
const updateInventory = process.env.FUSION_UPDATE_MERGE_INVENTORY === "1";
const currentManifest = updateInventory ? buildInventoryManifest(manifest) : manifest;
if (updateInventory) writeFileSync(resolve(__dirname, "fixtures/merge-orphan-durable-write-inventory.json"), `${JSON.stringify(currentManifest, null, 2)}\n`);

function assertInventoryEntry(entry: InventoryEntry): void {
  expect(["checkpoint-covered", "checkpoint-gap", "unreachable-after-abort", "out-of-frontier", "indeterminate"]).toContain(entry.axis1);
  expect(["already-fenced", "benign-unfenced", "must-be-fenced", "out-of-frontier", "unresolved"]).toContain(entry.axis2Final);
  expect(entry.observedInSuite).not.toBe("layerB-not-observed"); expect(entry.executionProof).toBeTruthy(); expect(entry.axis1Evidence).toBeTruthy();
  if (entry.observedInSuite.startsWith("unobservable:")) expect(entry.axis2Final).toBe("unresolved");
  if (entry.axis2Final === "already-fenced") { expect(entry.executionProof).not.toBe("positive-observation"); expect(entry.executionProof.startsWith("none:")).toBe(false); }
  const outside = entry.axis1 === "out-of-frontier";
  if (outside) {
    expect([entry.axis2Final, entry.observedInSuite, entry.executionProof, entry.followUpTaskId]).toEqual(["out-of-frontier", "out-of-frontier", "none:out-of-frontier", "none:out-of-frontier"]);
    expect(entry.axis1Evidence).toContain("No call edge");
  }
  else expect(entry.followUpTaskId.startsWith("pending:")).toBe(false);
  if (["must-be-fenced", "unresolved"].includes(entry.axis2Final)) expect(taskId.test(entry.followUpTaskId)).toBe(true);
  if (["already-fenced", "benign-unfenced"].includes(entry.axis2Final)) expect(entry.followUpTaskId).toBe("none:no-follow-up-required");
}

describe("FN-8923 orphan durable-write inventory drift guard", () => {
  it("pins derived writer surface and closure", () => {
    const surface = deriveDurableWriterSurface(); const closure = deriveMergeReachableModules();
    expect(surface.unclassified, "task-store method is not classified as a durable writer or non-writer").toEqual([]);
    expect(surface.classified.filter(({ method }) => ["updatePrReadinessAndAwaitChecksIfBlocked", "releaseAwaitingPrChecksIfCurrentHead"].includes(method))).toEqual([
      { method: "releaseAwaitingPrChecksIfCurrentHead", kind: "writer", reason: "persists a current-head-gated task-status release and lifecycle event" },
      { method: "updatePrReadinessAndAwaitChecksIfBlocked", kind: "writer", reason: "persists readiness and the transactional awaiting-pr-checks task hold" },
    ]);
    expect(surface.source, "writer-surface source drift").toBe(currentManifest.writerSurfaceSource);
    expect(surface.writers, "writer-set drift").toEqual(currentManifest.writerSurface);
    expect(surface.classified, "writer-surface classification drift").toEqual(currentManifest.writerSurfaceClassification);
    expect(closure.modules, "reachable module is not pinned in scannedModules").toEqual(currentManifest.scannedModules);
    expect(closure.boundary, "closure boundary drift").toEqual(currentManifest.closureBoundary.map(({ module, reason }) => ({ module, reason })));
  });
  it("is bijective by call-site id and fingerprint and fails closed on suspects", () => {
    const derived = deriveMergeDurableWriteCallSites();
    expect(derived.suspects, "durable-write scan could not resolve receiver").toEqual([]);
    const entries = currentManifest.entries;
    expect(new Set(entries.map((entry) => entry.callSiteId)).size).toBe(entries.length);
    expect(derived.callSites.map((site) => site.callSiteId), "new durable write is not classified").toEqual(entries.map((entry) => entry.callSiteId));
    for (const site of derived.callSites) expect(entries.find((entry) => entry.callSiteId === site.callSiteId)?.callSiteFingerprint, `durable write ${site.callSiteId} has a different call shape`).toBe(site.callSiteFingerprint);
  });
  it("pins the provable-alias versus unprovable-receiver split", () => {
    expect(classifyReceiverForTest("const s = options.store; s.updateTask()"), "provable alias becomes a call site").toBe("provable");
    expect(classifyReceiverForTest("const { updateTask } = options.store; updateTask()"), "destructured receiver fails closed").toBe("suspect");
    expect(classifyReceiverForTest("options.store[\"updateTask\"]()"), "computed receiver fails closed").toBe("suspect");
  });
  /*
  FNXC:MergeDurableWriteInventory 2026-10-08-05:21:
  KB-047: `this.store` and the other census-confirmed receivers are provable task-store receivers; any receiver in
  neither reviewed table fails closed, and a reviewed table entry that stops matching code is stale.
  */
  it("recognises reviewed task-store receiver shapes and fails closed on unreviewed receivers", () => {
    expect(classifyReceiverForTest("this.store.updateTask()"), "this.store is a reviewed task-store receiver").toBe("provable");
    expect(classifyReceiverForTest("const s = this.store; s.updateTask()"), "alias of a new shape stays provable").toBe("provable");
    expect(classifyReceiverForTest("this.store?.updateTask?.()"), "optional chains normalise to the same shape").toBe("provable");
    expect(classifyReceiverForTest("const { updateTask } = this.store"), "destructured new-shape receiver fails closed").toBe("suspect");
    expect(classifyReceiverForTest("this.store[\"updateTask\"]()"), "computed new-shape receiver fails closed").toBe("suspect");
    expect(classifyReceiverForTest("fooBar.updateTask()"), "unreviewed receiver fails closed").toBe("suspect");
    expect(receiverSuspectsForTest("fooBar.updateTask()").map((suspect) => suspect.reason)).toEqual(["unreviewed task-store receiver shape fooBar"]);
    expect(receiverSuspectsForTest("fooBar.getTask()"), "non-writer methods are outside the census").toEqual([]);
    expect(receiverSuspectsForTest("extensionRunner.emit()", "packages/engine/src/pi.ts"), "reviewed non-store receiver is exempt in its module").toEqual([]);
    expect(receiverSuspectsForTest("extensionRunner.emit()", "packages/engine/src/other.ts").map((suspect) => suspect.reason), "non-store exemptions are module-scoped").toEqual(["unreviewed task-store receiver shape extensionRunner"]);
  });
  it("has no unreviewed receivers or stale reviewed receiver entries on the real tree", () => {
    expect(deriveReceiverCensus()).toEqual({ unreviewed: [], staleNonStoreEntries: [], staleTaskStoreShapes: [] });
  });
  it("inventories notification-service wedge-notification writes made through this.store", () => {
    const file = "packages/engine/src/notification/notification-service.ts";
    const sites = deriveMergeDurableWriteCallSites().callSites.filter((site) => site.file === file);
    const expectedWriters = ["markTaskWedgeNotificationPending", "claimTaskWedgeNotificationEpisode", "clearTaskWedgeNotificationPending", "acknowledgeTaskWedgeNotificationDelivery", "markTerminalFailureAutoRecoveryEscalationDelivered", "markTerminalFailureAutoRecoveryBudgetExhausted"].map((method) => `this.store.${method}`);
    for (const writer of expectedWriters) expect(sites.some((site) => site.writer === writer), `${writer} has a derived call site`).toBe(true);
    for (const site of sites) {
      const entry = currentManifest.entries.find((candidate) => candidate.callSiteId === site.callSiteId);
      expect(entry, `${site.callSiteId} has a manifest verdict`).toBeDefined();
      assertInventoryEntry(entry!);
    }
  });
  it("keeps every legacy store.* call-site id and fingerprint stable", () => {
    const derived = new Map(deriveMergeDurableWriteCallSites().callSites.map((site) => [site.callSiteId, site.callSiteFingerprint]));
    const legacy = currentManifest.entries.filter((entry) => entry.writer.startsWith("store."));
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.filter((entry) => !derived.has(entry.callSiteId)).map((entry) => entry.callSiteId), "legacy store.* id disappeared").toEqual([]);
    expect(legacy.filter((entry) => derived.get(entry.callSiteId) !== entry.callSiteFingerprint).map((entry) => entry.callSiteId), "legacy store.* fingerprint changed").toEqual([]);
  });
  it("enforces final lifecycle, axes, observations, proofs, and out-of-frontier tuple", () => {
    expect(currentManifest.inventoryStatus).toBe("final");
    for (const entry of currentManifest.entries) assertInventoryEntry(entry);
    for (const boundary of currentManifest.closureBoundary) expect(taskId.test(boundary.followUpTaskId)).toBe(true);
  });
  it("rebuilds a current manifest without changing it", () => {
    expect(buildInventoryManifest(manifest)).toEqual(manifest);
  });
  it("marks a missing call-site verdict pending and fails the lifecycle guard", () => {
    const withoutEntry = { ...manifest, entries: manifest.entries.slice(1) };
    const rebuilt = buildInventoryManifest(withoutEntry);
    const pending = rebuilt.entries.find((entry) => entry.callSiteId === manifest.entries[0]?.callSiteId);
    expect(pending?.followUpTaskId).toMatch(/^pending:/);
    expect(() => assertInventoryEntry(pending!)).toThrow();
  });
  it("carries every human verdict forward while replacing structural fields", () => {
    const prior = manifest.entries[0]!;
    const revised = { ...manifest, entries: [{ ...prior, axis1Evidence: "human verdict survives structural reconciliation" }] };
    const rebuilt = buildInventoryManifest(revised);
    const result = rebuilt.entries.find((entry) => entry.callSiteId === prior.callSiteId)!;
    const expectedVerdict = revised.entries[0]!;
    for (const field of ["owningEntryPoint", "reachableDataStates", "axis1", "axis1Evidence", "axis2Provisional", "axis2Final", "observedInSuite", "executionProof", "followUpTaskId"] as const) expect(result[field]).toEqual(expectedVerdict[field]);
    const derived = deriveMergeDurableWriteCallSites().callSites.find((site) => site.callSiteId === prior.callSiteId)!;
    const { lineHint: _lineHint, ...derivedIdentity } = derived;
    expect({ callSiteId: result.callSiteId, callSiteFingerprint: result.callSiteFingerprint, file: result.file, enclosingSymbolPath: result.enclosingSymbolPath, writer: result.writer, ordinal: result.ordinal }).toEqual(derivedIdentity);
  });
  it("never persists a line position in manifest entries", () => {
    const rebuilt = buildInventoryManifest(manifest);
    expect(rebuilt.entries.filter((entry) => "lineHint" in entry).map((entry) => entry.callSiteId)).toEqual([]);
    const pending = buildInventoryManifest({ ...manifest, entries: manifest.entries.slice(1) }).entries[0]!;
    expect("lineHint" in pending).toBe(false);
  });
  it("refuses regeneration when classification or receiver derivation is incomplete", () => {
    expect(() => assertInventoryRegenerationInputs({ unclassified: ["newWriter"], suspects: [] })).toThrow("unclassified TaskStore methods");
    expect(() => assertInventoryRegenerationInputs({ unclassified: [], suspects: [{ file: "fixture.ts", line: 1, text: "store[newWriter]()", reason: "computed" }] })).toThrow("unresolved durable-write receivers");
  });
});
