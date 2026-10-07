/*
FNXC:TestIsolation 2026-10-07-18:04:
Test workers must never reach a paid model with the operator's credentials. HOME is already redirected, but provider SDKs also read keys from the environment, and an operator shell commonly exports them; one unmocked review session opened openrouter/moonshotai/kimi-k2.6 and spent credits.
The shared setup removes every provider credential variable before any test runs. A run that genuinely needs live providers sets FUSION_TEST_ALLOW_LIVE_PROVIDER_CREDENTIALS=1.
The explicit names come from pi-ai's environment key resolver; the `API_KEY` shapes cover every keyed provider without tracking each one.
*/
export const LIVE_PROVIDER_CREDENTIALS_OPT_IN_ENV = "FUSION_TEST_ALLOW_LIVE_PROVIDER_CREDENTIALS";

const API_KEY_NAME = /(^|_)API_KEY($|_)/;

const PROVIDER_CREDENTIAL_NAMES = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "COPILOT_GITHUB_TOKEN",
  "HF_TOKEN",
]);

export function isLiveProviderCredentialName(name: string): boolean {
  return API_KEY_NAME.test(name) || PROVIDER_CREDENTIAL_NAMES.has(name);
}

/** Deletes provider credentials from `env` unless the opt-in is set; returns the removed names, sorted. */
export function scrubLiveProviderCredentials(env: NodeJS.ProcessEnv): string[] {
  if (env[LIVE_PROVIDER_CREDENTIALS_OPT_IN_ENV] === "1") return [];
  const removed = Object.keys(env).filter(isLiveProviderCredentialName).sort();
  for (const name of removed) delete env[name];
  return removed;
}
