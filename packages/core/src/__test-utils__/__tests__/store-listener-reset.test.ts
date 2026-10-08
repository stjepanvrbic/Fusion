/*
FNXC:ExecutorLifecycle 2026-10-08-08:13 (KB-049):
The shared PG harness restores a store's listeners to a per-test snapshot so one test's executors cannot act on the next test's tasks.
Removal must be by raw-listener identity (never removeAllListeners), keep snapshot listeners and their order, and re-arm (not permanently disable) lazily wired activity listeners.
*/
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { restoreStoreListeners, snapshotStoreListeners } from "../pg-test-harness.js";

class FakeStore extends EventEmitter {
  activityListenersWired = false;

  /** Mirrors setupActivityLogListenersImpl: one-shot wiring behind the flag. */
  wireActivityListeners(onCreated: () => void): void {
    if (this.activityListenersWired) return;
    this.activityListenersWired = true;
    this.on("task:created", onCreated);
  }
}

describe("store listener snapshot/restore seam (KB-049)", () => {
  it("removes listeners added after the snapshot and keeps snapshot listeners in order", () => {
    const store = new FakeStore();
    const first = vi.fn();
    const second = vi.fn();
    store.on("task:moved", first);
    store.on("task:moved", second);
    const snapshot = snapshotStoreListeners(store);

    const added = vi.fn();
    const addedOther = vi.fn();
    store.on("task:moved", added);
    store.on("settings:updated", addedOther);
    restoreStoreListeners(store, snapshot);

    expect(store.rawListeners("task:moved")).toEqual([first, second]);
    expect(store.listenerCount("settings:updated")).toBe(0);
    store.emit("task:moved");
    store.emit("settings:updated");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(added).not.toHaveBeenCalled();
    expect(addedOther).not.toHaveBeenCalled();
  });

  it("removes a once listener added after the snapshot", () => {
    const store = new FakeStore();
    const snapshot = snapshotStoreListeners(store);
    const onceListener = vi.fn();
    store.once("task:deleted", onceListener);

    restoreStoreListeners(store, snapshot);

    expect(store.listenerCount("task:deleted")).toBe(0);
    store.emit("task:deleted");
    expect(onceListener).not.toHaveBeenCalled();
  });

  it("re-arms lazily wired activity listeners that were first wired during the test", () => {
    const store = new FakeStore();
    const snapshot = snapshotStoreListeners(store);
    const firstWiring = vi.fn();
    store.wireActivityListeners(firstWiring);

    restoreStoreListeners(store, snapshot);

    expect(store.activityListenersWired).toBe(false);
    expect(store.listenerCount("task:created")).toBe(0);
    const secondWiring = vi.fn();
    store.wireActivityListeners(secondWiring);
    store.emit("task:created");
    expect(secondWiring).toHaveBeenCalledOnce();
    expect(firstWiring).not.toHaveBeenCalled();
  });

  it("leaves activity listeners wired before the snapshot untouched", () => {
    const store = new FakeStore();
    const wired = vi.fn();
    store.wireActivityListeners(wired);
    const snapshot = snapshotStoreListeners(store);
    store.on("task:created", vi.fn());

    restoreStoreListeners(store, snapshot);

    expect(store.activityListenersWired).toBe(true);
    expect(store.rawListeners("task:created")).toEqual([wired]);
  });

  it("is a no-op for an empty snapshot with no changes", () => {
    const store = new FakeStore();
    const snapshot = snapshotStoreListeners(store);
    restoreStoreListeners(store, snapshot);
    expect(store.eventNames()).toEqual([]);
    expect(store.activityListenersWired).toBe(false);
  });
});
