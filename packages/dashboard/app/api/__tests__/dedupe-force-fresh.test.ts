import { afterEach, describe, expect, it, vi } from "vitest";
import { dedupe } from "../client/dedupe";
import { fetchSettings } from "../settings/settings";
import { fetchAgents } from "../agents/agents";
import { fetchBoardWorkflows } from "../projects/board-workflows";

/*
FNXC:DashboardFetchDedupe 2026-10-07-17:59:
Once a caller requests forceFresh, every caller sharing that in-flight entry must settle with the newest forced fetch, whichever inner fetch completes first.
A superseded fetch's success or failure is ignored, so a mutation's refetch can never return the pre-mutation snapshot.
*/

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let keySeq = 0;
const nextKey = () => `dedupe-test-${++keySeq}`;

describe("dedupe forceFresh ownership", () => {
  it("settles every caller with the forced fetch when the superseded fetch resolves first", async () => {
    const key = nextKey();
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const first = dedupe(key, () => stale.promise);
    const second = dedupe(key, () => fresh.promise, { forceFresh: true });

    stale.resolve("stale");
    await Promise.resolve();
    fresh.resolve("fresh");

    await expect(first).resolves.toBe("fresh");
    await expect(second).resolves.toBe("fresh");
  });

  it("settles every caller with the forced fetch when it resolves first", async () => {
    const key = nextKey();
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const first = dedupe(key, () => stale.promise);
    const second = dedupe(key, () => fresh.promise, { forceFresh: true });

    fresh.resolve("fresh");
    await expect(first).resolves.toBe("fresh");
    stale.resolve("stale");
    await expect(second).resolves.toBe("fresh");
  });

  it("ignores a superseded fetch's rejection", async () => {
    const key = nextKey();
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const first = dedupe(key, () => stale.promise);
    const second = dedupe(key, () => fresh.promise, { forceFresh: true });

    stale.reject(new Error("stale request failed"));
    await Promise.resolve();
    fresh.resolve("fresh");

    await expect(first).resolves.toBe("fresh");
    await expect(second).resolves.toBe("fresh");
  });

  it("propagates the forced fetch's own rejection", async () => {
    const key = nextKey();
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const first = dedupe(key, () => stale.promise);
    const second = dedupe(key, () => fresh.promise, { forceFresh: true });

    stale.resolve("stale");
    await Promise.resolve();
    fresh.reject(new Error("fresh request failed"));

    await expect(first).rejects.toThrow("fresh request failed");
    await expect(second).rejects.toThrow("fresh request failed");
  });

  it("lets only the newest of several forced fetches settle the callers", async () => {
    const key = nextKey();
    const original = deferred<string>();
    const forcedA = deferred<string>();
    const forcedB = deferred<string>();
    const callers = [
      dedupe(key, () => original.promise),
      dedupe(key, () => forcedA.promise, { forceFresh: true }),
      dedupe(key, () => forcedB.promise, { forceFresh: true }),
      dedupe(key, () => Promise.resolve("joined")),
    ];

    forcedA.resolve("forced-a");
    original.resolve("original");
    await Promise.resolve();
    forcedB.resolve("forced-b");

    await expect(Promise.all(callers)).resolves.toEqual(["forced-b", "forced-b", "forced-b", "forced-b"]);
  });

  it("starts a new fetch once the shared entry has settled", async () => {
    const key = nextKey();
    await expect(dedupe(key, async () => "first")).resolves.toBe("first");
    await expect(dedupe(key, async () => "second")).resolves.toBe("second");
  });
});

describe("dedupe forceFresh through real fetchers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  /** The pre-mutation fetch completes before the forced post-mutation fetch. */
  async function expectForcedFetchWins<T>(
    load: (forceFresh: boolean) => Promise<T>,
    stale: unknown,
    fresh: unknown,
  ): Promise<void> {
    const responses = [deferred<Response>(), deferred<Response>()];
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => responses[call++].promise);

    const first = load(false);
    const second = load(true);
    responses[0].resolve(jsonResponse(stale));
    await new Promise((resolve) => setTimeout(resolve, 0));
    responses[1].resolve(jsonResponse(fresh));

    await expect(first).resolves.toEqual(fresh);
    await expect(second).resolves.toEqual(fresh);
    expect(call).toBe(2);
  }

  it("fetchSettings", async () => {
    await expectForcedFetchWins(
      (forceFresh) => fetchSettings("dedupe-settings", forceFresh ? { forceFresh } : undefined),
      { maxConcurrent: 1 },
      { maxConcurrent: 5 },
    );
  });

  it("fetchAgents", async () => {
    await expectForcedFetchWins(
      (forceFresh) => fetchAgents(undefined, "dedupe-agents", forceFresh ? { forceFresh } : undefined),
      [{ id: "agent-old" }],
      [{ id: "agent-new" }],
    );
  });

  it("fetchBoardWorkflows", async () => {
    await expectForcedFetchWins(
      (forceFresh) => fetchBoardWorkflows("dedupe-workflows", forceFresh ? { forceFresh } : undefined),
      { workflows: [] },
      { workflows: [{ id: "WF-002" }] },
    );
  });
});
