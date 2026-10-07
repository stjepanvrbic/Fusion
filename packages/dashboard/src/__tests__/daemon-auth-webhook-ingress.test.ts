// @vitest-environment node

import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request } from "../test-request.js";

/*
FNXC:DaemonAuth 2026-10-07-19:55:
With daemon auth on, a correctly signed provider delivery must reach its route's own verification without the daemon bearer token, a badly signed one must still be refused by that route, and every neighbouring route must stay behind the daemon gate.
This drives the real middleware-to-router stack rather than the middleware alone, so a mount-order or body-parser change that breaks ingress is caught.
*/

const DAEMON_TOKEN = "fn_daemon_ingress_token";
const DAEMON_REJECTION = "Valid bearer token required";

const ENV: Record<string, string> = {
  FUSION_SIGNAL_WEBHOOK_SECRET: "wh-secret",
  FUSION_SIGNAL_SENTRY_SECRET: "sentry-secret",
  FUSION_SIGNAL_DATADOG_SECRET: "datadog-secret",
  FUSION_SIGNAL_PAGERDUTY_SECRET: "pd-secret",
  FUSION_SIGNAL_GITLAB_SECRET: "gitlab-secret",
  FUSION_SIGNAL_GITHUB_SECRET: "github-signal-secret",
  FUSION_GITHUB_APP_ID: "12345",
  FUSION_GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
  FUSION_GITHUB_WEBHOOK_SECRET: "github-app-secret",
  FUSION_MONITOR_INGEST_SECRET: "monitor-secret",
};

function hmac(raw: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex");
}

class IngressStore extends EventEmitter {
  readonly tasks: Task[] = [];
  createTaskGate: Promise<void> | undefined;
  getRootDir() { return process.cwd(); }
  getFusionDir() { return `${process.cwd()}/.fusion`; }
  getSettings = vi.fn(async () => ({}));
  getSettingsFast = this.getSettings;
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
  getTaskWorkflowSelection = vi.fn();
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "daemon-ingress");
  getAsyncLayer = vi.fn(() => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })) } }));
  listTasks = vi.fn(async () => this.tasks);
  createTask = vi.fn(async (input: { title: string; source?: Task["source"] }) => {
    await this.createTaskGate;
    const task = { id: `FN-${this.tasks.length + 1}`, title: input.title, column: "triage", source: input.source } as unknown as Task;
    this.tasks.push(task);
    return task;
  });
}

const routineRunner = {
  triggerManual: vi.fn(),
  triggerWebhook: vi.fn(async () => ({ success: true })),
};
const routineStore = {
  getRoutine: vi.fn(async (id: string) => ({ id, name: "hook", enabled: true, trigger: { type: "webhook", secret: "routine-secret" } })),
};

function boot() {
  const store = new IngressStore();
  const app = createServer(store as unknown as TaskStore, {
    daemon: { token: DAEMON_TOKEN },
    routineStore: routineStore as never,
    routineRunner: routineRunner as never,
    chatStore: Object.assign(new EventEmitter(), { deleteSessionsForAgentId: vi.fn().mockResolvedValue(undefined) }) as never,
    aiSessionStore: Object.assign(new EventEmitter(), {
      recoverStaleSessions: vi.fn().mockResolvedValue(undefined), rehydrateFromStore: vi.fn().mockResolvedValue(0),
      stopScheduledCleanup: vi.fn(), cleanupStaleSessions: vi.fn().mockResolvedValue({ terminalDeleted: 0, orphanedDeleted: 0 }),
    }) as never,
  });
  return { app, store };
}

function post(app: ReturnType<typeof createServer>, path: string, raw: string, headers: Record<string, string>) {
  return request(app, "POST", path, raw, { "Content-Type": "application/json", ...headers });
}

function daemonRejected(response: { status: number; body: unknown }): boolean {
  return response.status === 401 && (response.body as { message?: string } | undefined)?.message === DAEMON_REJECTION;
}

interface SignalDelivery {
  provider: string;
  payload: object;
  headers(raw: string, valid: boolean): Record<string, string>;
}

const signalDeliveries: SignalDelivery[] = [
  {
    provider: "webhook",
    payload: { id: "wh-ingress", title: "Disk full", severity: "critical" },
    headers: (raw, valid) => ({ "X-Fusion-Signature": hmac(valid ? raw : "tampered", ENV.FUSION_SIGNAL_WEBHOOK_SECRET), "X-Fusion-Timestamp": String(Date.now()) }),
  },
  {
    provider: "sentry",
    payload: { data: { issue: { id: "sentry-ingress", title: "Fatal", level: "fatal" } } },
    headers: (raw, valid) => ({ "Sentry-Hook-Signature": hmac(valid ? raw : "tampered", ENV.FUSION_SIGNAL_SENTRY_SECRET) }),
  },
  {
    provider: "datadog",
    payload: { aggreg_key: "dd-ingress", event_id: "dd-ingress-event", title: "Warn", alert_type: "warning" },
    headers: (raw, valid) => ({ "X-Datadog-Signature": hmac(valid ? raw : "tampered", ENV.FUSION_SIGNAL_DATADOG_SECRET) }),
  },
  {
    provider: "pagerduty",
    payload: { event: { id: "pd-ingress-event", event_type: "incident.triggered", occurred_at: new Date().toISOString(), data: { id: "pd-ingress", title: "Pager", urgency: "high", status: "triggered" } } },
    headers: (raw, valid) => ({ "X-PagerDuty-Signature": `v1=${hmac(valid ? raw : "tampered", ENV.FUSION_SIGNAL_PAGERDUTY_SECRET)}` }),
  },
  {
    provider: "gitlab",
    payload: {
      object_kind: "issue",
      event_type: "issue",
      project: { id: 1, path_with_namespace: "gitlabhq/gitlab-test", web_url: "https://gitlab.example.com/gitlabhq/gitlab-test" },
      object_attributes: { id: 301, iid: 23, title: "GitLab ingress", description: "Broken", state: "opened", action: "open", url: "https://gitlab.example.com/gitlabhq/gitlab-test/-/issues/23", severity: "critical" },
    },
    headers: (_raw, valid) => ({ "X-Gitlab-Token": valid ? ENV.FUSION_SIGNAL_GITLAB_SECRET : "wrong-token", "X-Gitlab-Event-UUID": "gl-ingress" }),
  },
  {
    provider: "github",
    payload: {
      repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
      check_suite: { status: "completed", conclusion: "failure", head_sha: "abc1234", head_branch: "main", updated_at: new Date().toISOString(), app: { slug: "checks" } },
    },
    headers: (raw, valid) => ({ "X-Hub-Signature-256": `sha256=${hmac(valid ? raw : "tampered", ENV.FUSION_SIGNAL_GITHUB_SECRET)}`, "X-GitHub-Event": "check_suite", "X-GitHub-Delivery": "github-ingress" }),
  },
];

describe("daemon auth — provider-signed webhook ingress", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    routineRunner.triggerWebhook.mockClear();
  });
  afterEach(() => {
    for (const key of Object.keys(ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it.each(signalDeliveries.map((d) => [d.provider, d] as const))("creates a task for a signed %s signal without the daemon token", async (_provider, delivery) => {
    const { app, store } = boot();
    const raw = JSON.stringify(delivery.payload);
    const response = await post(app, `/api/signals/${delivery.provider}`, raw, delivery.headers(raw, true));
    expect(response.status).toBe(201);
    expect(store.tasks).toHaveLength(1);
  });

  it.each(signalDeliveries.map((d) => [d.provider, d] as const))("lets the %s signal route refuse a bad signature itself", async (_provider, delivery) => {
    const { app, store } = boot();
    const raw = JSON.stringify(delivery.payload);
    const response = await post(app, `/api/signals/${delivery.provider}`, raw, delivery.headers(raw, false));
    expect(response.status).toBe(401);
    expect(daemonRejected(response)).toBe(false);
    expect(store.tasks).toHaveLength(0);
  });

  it("refuses a signal when the provider secret is missing", async () => {
    delete process.env.FUSION_SIGNAL_WEBHOOK_SECRET;
    const { app, store } = boot();
    const delivery = signalDeliveries[0];
    const raw = JSON.stringify(delivery.payload);
    const response = await post(app, "/api/signals/webhook", raw, delivery.headers(raw, true));
    expect(response.status).toBe(401);
    expect(daemonRejected(response)).toBe(false);
    expect(store.tasks).toHaveLength(0);
  });

  it("answers a duplicate that arrives mid-flight with a retryable 503 and Retry-After", async () => {
    const { app, store } = boot();
    let release!: () => void;
    store.createTaskGate = new Promise<void>((resolve) => { release = resolve; });
    const delivery = signalDeliveries[0];
    const raw = JSON.stringify(delivery.payload);
    const first = post(app, "/api/signals/webhook", raw, delivery.headers(raw, true));
    await vi.waitFor(() => expect(store.createTask).toHaveBeenCalled());
    const duplicate = await post(app, "/api/signals/webhook", raw, delivery.headers(raw, true));
    expect(duplicate.status).toBe(503);
    expect(duplicate.headers["retry-after"]).toBeDefined();
    release();
    expect((await first).status).toBe(201);
    expect(store.tasks).toHaveLength(1);
  });

  it("accepts a signed GitHub App ping and refuses a tampered one at the route", async () => {
    const { app } = boot();
    const raw = JSON.stringify({ zen: "Keep it logically awesome." });
    const ping = await post(app, "/api/github/webhooks", raw, { "X-Hub-Signature-256": `sha256=${hmac(raw, ENV.FUSION_GITHUB_WEBHOOK_SECRET)}`, "X-GitHub-Event": "ping" });
    expect(ping.status).toBe(200);
    const tampered = await post(app, "/api/github/webhooks", raw, { "X-Hub-Signature-256": `sha256=${hmac("tampered", ENV.FUSION_GITHUB_WEBHOOK_SECRET)}`, "X-GitHub-Event": "ping" });
    expect(tampered.status).toBe(403);
  });

  it("triggers a signed routine webhook and refuses a tampered one at the route", async () => {
    const { app } = boot();
    const raw = JSON.stringify({ hello: "world" });
    const signed = await post(app, "/api/routines/routine-1/webhook", raw, { "X-Hub-Signature-256": `sha256=${hmac(raw, "routine-secret")}` });
    expect(signed.status).toBe(200);
    expect(routineRunner.triggerWebhook).toHaveBeenCalledTimes(1);
    const tampered = await post(app, "/api/routines/routine-1/webhook", raw, { "X-Hub-Signature-256": `sha256=${hmac("tampered", "routine-secret")}` });
    expect(tampered.status).toBe(401);
    expect(daemonRejected(tampered)).toBe(false);
    expect(routineRunner.triggerWebhook).toHaveBeenCalledTimes(1);
  });

  it.each(["/api/monitor/incidents", "/api/monitor/deployments"])("lets %s check its own ingest secret", async (path) => {
    const { app } = boot();
    const raw = JSON.stringify({ groupingKey: "g", title: "t" });
    const wrong = await post(app, path, raw, { Authorization: "Bearer not-the-secret" });
    expect(wrong.status).toBe(401);
    expect(daemonRejected(wrong)).toBe(false);
    const daemonTokenIsNotTheIngestSecret = await post(app, path, raw, { Authorization: `Bearer ${DAEMON_TOKEN}` });
    expect(daemonTokenIsNotTheIngestSecret.status).toBe(401);
    const right = await post(app, path, raw, { Authorization: `Bearer ${ENV.FUSION_MONITOR_INGEST_SECRET}` });
    expect(right.status).not.toBe(401);
  });

  it.each([
    ["GET", "/api/monitor/metrics"],
    ["POST", "/api/routines/routine-1/trigger"],
    ["GET", "/api/routines/routine-1"],
    ["GET", "/api/signals/webhook"],
    ["GET", "/api/tasks"],
    ["GET", "/API/tasks"],
  ])("keeps %s %s behind the daemon gate", async (method, path) => {
    const { app } = boot();
    const response = await request(app, method, path);
    expect(daemonRejected(response)).toBe(true);
  });
});
