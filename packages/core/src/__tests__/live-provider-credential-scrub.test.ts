import { describe, expect, it } from "vitest";
import {
  LIVE_PROVIDER_CREDENTIALS_OPT_IN_ENV,
  isLiveProviderCredentialName,
  scrubLiveProviderCredentials,
} from "../__test-utils__/live-provider-credentials";

/*
FNXC:TestIsolation 2026-10-07-18:04:
Test workers inherited the operator's shell provider keys, so an unmocked review session reached a paid model (openrouter/moonshotai/kimi-k2.6) and timed out. The shared setup scrubs provider credentials from every worker unless the run explicitly opts in.
*/
describe("live provider credential scrub", () => {
  it("removes every provider key and token shape while keeping unrelated variables", () => {
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "sk-or",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_OAUTH_TOKEN: "oauth",
      ANTHROPIC_AUTH_TOKEN: "auth",
      OPENAI_API_KEY: "sk-openai",
      API_KEY_21ST: "prefixed",
      AWS_ACCESS_KEY_ID: "akid",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock",
      AWS_PROFILE: "operator",
      GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
      COPILOT_GITHUB_TOKEN: "copilot",
      HF_TOKEN: "hf",
      PATH: "/usr/bin",
      HOME: "/home/test",
      FUSION_TEST_RUN_TOKEN: "run-token",
      GITHUB_TOKEN: "gh",
    };

    const removed = scrubLiveProviderCredentials(env);

    expect(removed).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "API_KEY_21ST",
      "AWS_ACCESS_KEY_ID",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_PROFILE",
      "AWS_SECRET_ACCESS_KEY",
      "COPILOT_GITHUB_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "HF_TOKEN",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      FUSION_TEST_RUN_TOKEN: "run-token",
      GITHUB_TOKEN: "gh",
    });
  });

  it("keeps credentials when the run explicitly opts in to live providers", () => {
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "sk-or", [LIVE_PROVIDER_CREDENTIALS_OPT_IN_ENV]: "1" };

    expect(scrubLiveProviderCredentials(env)).toEqual([]);
    expect(env.OPENROUTER_API_KEY).toBe("sk-or");
  });

  it("leaves this test worker without any live provider credential", () => {
    if (process.env[LIVE_PROVIDER_CREDENTIALS_OPT_IN_ENV] === "1") return;
    expect(Object.keys(process.env).filter(isLiveProviderCredentialName)).toEqual([]);
  });
});
