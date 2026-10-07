import { describe, expect, it } from "vitest";
import {
  LIVE_PROVIDER_CREDENTIALS_OPT_IN_ENV,
  isLiveProviderCredentialName,
} from "../../../core/src/__test-utils__/live-provider-credentials";
import { createFusionAuthStorage } from "../auth/auth-storage.js";

/*
FNXC:TestIsolation 2026-10-07-18:04:
An unmocked engine review session reached a paid model because the worker inherited the operator's provider keys. The engine lanes run the shared setup, which must leave no credential that a live provider session could resolve unless the run opts in.
*/
describe.skipIf(process.env[LIVE_PROVIDER_CREDENTIALS_OPT_IN_ENV] === "1")("engine test setup live provider guard", () => {
  it("exposes no provider credential variable to an engine test worker", () => {
    expect(Object.keys(process.env).filter(isLiveProviderCredentialName)).toEqual([]);
  });

  it("resolves no live provider key through Fusion auth storage", async () => {
    const storage = createFusionAuthStorage();
    for (const provider of ["openrouter", "anthropic", "openai"]) {
      expect(await storage.getApiKey(provider)).toBeUndefined();
    }
  });
});
