import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeSessionRegistry,
  reconcileSelfOwnedActiveSessionForRemoval,
  ActiveSessionPathHeldByForeignTaskError,
} from "../agents/active-session-registry.js";

describe("activeSessionRegistry", () => {
  beforeEach(() => {
    activeSessionRegistry.clear();
  });

  it("registers and unregisters paths", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    expect(activeSessionRegistry.isPathActive("/tmp/w1")).toBe(true);

    activeSessionRegistry.unregisterPath("/tmp/w1");
    expect(activeSessionRegistry.isPathActive("/tmp/w1")).toBe(false);
  });

  it("supports multiple paths for same task", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    activeSessionRegistry.registerPath("/tmp/w2", { taskId: "FN-1", kind: "workflow-step", ownerKey: "FN-1#workflow-step" });

    expect(activeSessionRegistry.pathsForTask("FN-1").sort()).toEqual(["/tmp/w1", "/tmp/w2"]);
  });

  it("returns null for unregistered path", () => {
    expect(activeSessionRegistry.lookupByPath("/tmp/missing")).toBeNull();
  });

  // FNXC:Workspace 2026-06-22-04:10 (Phase C review A2 — taskId-aware lease across kinds):
  // registerPath must NOT silently clobber an entry held by a DIFFERENT task (that was the
  // cross-phase clobber bug: a merging task's land lease overwriting an executing task's
  // acquire lease on a shared sub-repo). A foreign-task overwrite now THROWS; the existing
  // foreign holder is preserved.
  it("rejects a foreign-task overwrite (does not clobber the held entry)", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    expect(() =>
      activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-2", kind: "workflow-step", ownerKey: "FN-2#workflow-step" }),
    ).toThrow(ActiveSessionPathHeldByForeignTaskError);
    // The original holder is untouched.
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-1");
  });

  // Same-task re-registration stays idempotent (an executor re-claiming/refreshing its own path).
  it("allows same-task re-registration (idempotent re-claim)", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    expect(() =>
      activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "step-session", ownerKey: "FN-1#step-session" }),
    ).not.toThrow();
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.kind).toBe("step-session");
  });

  it("reconcileStaleSelfOwned returns no-entry when path is unregistered", () => {
    expect(activeSessionRegistry.reconcileStaleSelfOwned("/tmp/missing", "FN-1")).toEqual({
      reconciled: false,
      reason: "no-entry",
    });
  });

  it("reconcileStaleSelfOwned returns foreign-task for mismatched owner", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-2", kind: "executor", ownerKey: "FN-2" });

    expect(activeSessionRegistry.reconcileStaleSelfOwned("/tmp/w1", "FN-1")).toEqual({
      reconciled: false,
      reason: "foreign-task",
    });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-2");
  });

  it("reconcileStaleSelfOwned unregisters matching self-owned entry", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    expect(activeSessionRegistry.reconcileStaleSelfOwned("/tmp/w1", "FN-1")).toEqual({
      reconciled: true,
      reason: "reconciled",
    });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")).toBeNull();
  });

  it("reconcileSelfOwnedActiveSessionForRemoval returns no-entry when path is unregistered", () => {
    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/missing", "FN-1", () => false),
    ).toEqual({ action: "no-entry" });
  });

  it("reconcileSelfOwnedActiveSessionForRemoval returns foreign-task without clearing", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-2", kind: "executor", ownerKey: "FN-2" });

    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => false),
    ).toEqual({ action: "foreign-task", ownerTaskId: "FN-2" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-2");
  });

  it("reconcileSelfOwnedActiveSessionForRemoval returns live-binding-refuses without clearing", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => true),
    ).toEqual({ action: "live-binding-refuses", ownerTaskId: "FN-1" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-1");
  });

  it("reconcileSelfOwnedActiveSessionForRemoval clears stale same-task entry", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => false, {
        minIdleMs: 0,
      }),
    ).toEqual({ action: "reconciled" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")).toBeNull();
  });

  it("reconcileSelfOwnedActiveSessionForRemoval is idempotent", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => false, {
        minIdleMs: 0,
      }),
    ).toEqual({ action: "reconciled" });
    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => false, {
        minIdleMs: 0,
      }),
    ).toEqual({ action: "no-entry" });
  });

  it("FN-5256: refuses reconcile when processActiveProbe returns true", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      "/tmp/w1",
      "FN-1",
      () => false,
      { processActiveProbe: () => true, minIdleMs: 0 },
    );
    expect(outcome).toEqual({ action: "process-active-refuses", ownerTaskId: "FN-1" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-1");
  });

  it("FN-5256: refuses reconcile when registration is younger than minIdleMs", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    const registeredAt = activeSessionRegistry.lookupByPath("/tmp/w1")!.registeredAt;

    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      "/tmp/w1",
      "FN-1",
      () => false,
      { minIdleMs: 5000, now: () => registeredAt + 100 },
    );
    expect(outcome).toMatchObject({ action: "too-recent-refuses", ownerTaskId: "FN-1", minIdleMs: 5000 });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-1");
  });

  it("FN-5256: reconciles when all signals clean (default min-idle window elapsed)", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    const registeredAt = activeSessionRegistry.lookupByPath("/tmp/w1")!.registeredAt;

    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      "/tmp/w1",
      "FN-1",
      () => false,
      {
        processActiveProbe: () => false,
        minIdleMs: 5000,
        now: () => registeredAt + 6000,
      },
    );
    expect(outcome).toEqual({ action: "reconciled" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")).toBeNull();
  });

  it("FN-5256: live-binding takes precedence over process-active and too-recent", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      "/tmp/w1",
      "FN-1",
      () => true,
      { processActiveProbe: () => true, minIdleMs: 5000 },
    );
    expect(outcome).toEqual({ action: "live-binding-refuses", ownerTaskId: "FN-1" });
  });
});

/*
FNXC:ActiveSessionRegistry 2026-10-07-23:34:
One checkout is one live session whatever spelling names it: an 8.3 short name, a different letter case on Windows, or a symlink or junction alias.
Sweeps canonicalize their candidates while sessions register the spelling their caller held, so a raw-string registry let a sweep miss a live session and delete its checkout.
*/
describe("activeSessionRegistry path identity", () => {
  const roots: string[] = [];

  beforeEach(() => {
    activeSessionRegistry.clear();
  });

  afterEach(() => {
    activeSessionRegistry.clear();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function aliasedCheckout(): { real: string; alias: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "fusion-session-identity-"));
    roots.push(root);
    const real = join(root, "real", "fn-1");
    mkdirSync(real, { recursive: true });
    const aliasRoot = join(root, "alias");
    symlinkSync(join(root, "real"), aliasRoot, "junction");
    return { real, alias: join(aliasRoot, "fn-1"), root };
  }

  function spellings(real: string, alias: string): string[] {
    return process.platform === "win32" ? [alias, real.toUpperCase(), real.toLowerCase()] : [alias];
  }

  it("matches a session registered under one spelling through every other spelling of the same checkout", () => {
    const { real, alias } = aliasedCheckout();
    for (const registered of [real, ...spellings(real, alias)]) {
      activeSessionRegistry.clear();
      activeSessionRegistry.registerPath(registered, { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
      for (const probe of [real, ...spellings(real, alias)]) {
        expect(activeSessionRegistry.isPathActive(probe)).toBe(true);
        expect(activeSessionRegistry.lookupByPath(probe)?.taskId).toBe("FN-1");
        expect(() => activeSessionRegistry.registerPath(probe, { taskId: "FN-2", kind: "executor", ownerKey: "FN-2" }))
          .toThrow(ActiveSessionPathHeldByForeignTaskError);
      }
      expect(activeSessionRegistry.pathsForTask("FN-1")).toEqual([registered]);
      expect(activeSessionRegistry.entriesByKind("executor").map((entry) => entry.path)).toEqual([registered]);
    }
  });

  it("releases a session through another spelling and through its own spelling after the alias is gone", () => {
    const { real, alias, root } = aliasedCheckout();
    activeSessionRegistry.registerPath(alias, { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    activeSessionRegistry.unregisterPath(real);
    expect(activeSessionRegistry.isPathActive(alias)).toBe(false);

    activeSessionRegistry.registerPath(alias, { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    rmSync(join(root, "alias"), { recursive: true, force: true });
    activeSessionRegistry.unregisterPath(alias);
    expect(activeSessionRegistry.pathsForTask("FN-1")).toEqual([]);
  });

  it("keeps distinct checkouts distinct", () => {
    const { real, root } = aliasedCheckout();
    const sibling = join(root, "real", "fn-2");
    mkdirSync(sibling);
    activeSessionRegistry.registerPath(real, { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    expect(activeSessionRegistry.isPathActive(sibling)).toBe(false);
    expect(activeSessionRegistry.isPathActive(`${real}#session:FN-1`)).toBe(false);
  });
});
