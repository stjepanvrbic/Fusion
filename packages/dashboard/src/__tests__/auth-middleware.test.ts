// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware, hasVerifiedDaemonRequest, isDaemonAuthActive } from "../auth-middleware.js";

describe("createAuthMiddleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: NextFunction;

  beforeEach(() => {
    mockReq = {
      path: "/api/tasks",
      headers: {},
    };

    mockRes = {
      status: vi.fn().mockReturnThis() as unknown as Response["status"],
      json: vi.fn().mockReturnThis() as unknown as Response["json"],
    };

    nextFn = vi.fn();
  });

  it("returns 401 when Authorization header is missing", () => {
    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      message: "Valid bearer token required",
    });
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header uses wrong scheme", () => {
    mockReq.headers = { authorization: "Basic dXNlcjpwYXNz" };

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      message: "Valid bearer token required",
    });
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when token is wrong", () => {
    mockReq.headers = { authorization: "Bearer wrong_token" };

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      message: "Valid bearer token required",
    });
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("calls next() when token matches", () => {
    const token = "fn_abc123def456789";
    mockReq.headers = { authorization: `Bearer ${token}` };

    const middleware = createAuthMiddleware(token);
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
    expect(hasVerifiedDaemonRequest(mockReq as Request)).toBe(true);
  });

  it("marks a valid fn_token query request as verified", () => {
    mockReq.url = "/api/tasks?fn_token=fn_abc123def456789";
    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(hasVerifiedDaemonRequest(mockReq as Request)).toBe(true);
  });

  it("does not mark exempt, SPA, or rejected requests as verified", () => {
    const middleware = createAuthMiddleware("fn_abc123def456789");
    mockReq.path = "/api/health";
    middleware(mockReq as Request, mockRes as Response, nextFn);
    expect(hasVerifiedDaemonRequest(mockReq as Request)).toBe(false);

    mockReq.path = "/";
    mockReq.headers = { authorization: "Bearer fn_abc123def456789" };
    middleware(mockReq as Request, mockRes as Response, nextFn);
    expect(hasVerifiedDaemonRequest(mockReq as Request)).toBe(false);

    mockReq.path = "/api/tasks";
    mockReq.headers = { authorization: "Bearer wrong" };
    middleware(mockReq as Request, mockRes as Response, nextFn);
    expect(hasVerifiedDaemonRequest(mockReq as Request)).toBe(false);
  });

  it("exempts /api/health path without token", () => {
    mockReq.path = "/api/health";

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("exempts paths starting with /api/health/", () => {
    mockReq.path = "/api/health/check";

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("handles tokens of different lengths without crashing", () => {
    // Test with shorter token
    mockReq.headers = { authorization: "Bearer short" };
    const shortToken = "fn_verylongtoken1234567890123456789012345678901234567890";

    const middleware = createAuthMiddleware(shortToken);
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("handles malformed bearer header (missing space)", () => {
    mockReq.headers = { authorization: "Bearertoken" };

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("handles empty bearer token", () => {
    mockReq.headers = { authorization: "Bearer " };

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("does not accept remote-login rt query tokens for non-remote API auth", () => {
    mockReq.url = "/api/tasks?rt=frt_persistent_token";

    const middleware = createAuthMiddleware("fn_abc123def456789");
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });
});

/*
FNXC:DaemonAuth 2026-10-07-19:55:
Provider-signed webhook ingress (signal connectors, GitHub App, routine webhooks, monitor ingestion) cannot carry the daemon bearer token, so it bypasses the daemon gate and relies on each route's mandatory signature or ingest-secret check.
The bypass is method- and path-exact: every neighbouring management route stays gated, and gating is case-insensitive because Express routing is.
*/
describe("createAuthMiddleware — self-authenticating webhook ingress", () => {
  const token = "fn_abc123def456789";

  function run(method: string, path: string) {
    const req = { method, path, headers: {} } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn();
    createAuthMiddleware(token)(req, res, next);
    return { passed: next.mock.calls.length === 1, status: (res.status as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0], verified: hasVerifiedDaemonRequest(req) };
  }

  const exempt: Array<[string, string]> = [
    ["POST", "/api/signals/webhook"],
    ["POST", "/api/signals/sentry"],
    ["POST", "/api/signals/datadog"],
    ["POST", "/api/signals/pagerduty"],
    ["POST", "/api/signals/gitlab"],
    ["POST", "/api/signals/github"],
    ["POST", "/api/signals/github/"],
    ["POST", "/api/github/webhooks"],
    ["POST", "/api/github/webhooks/"],
    ["POST", "/api/routines/routine-1/webhook"],
    ["POST", "/api/routines/routine-1/webhook/"],
    ["POST", "/api/monitor/incidents"],
    ["POST", "/api/monitor/deployments"],
    ["POST", "/API/Signals/webhook"],
  ];

  it.each(exempt)("passes %s %s through without a bearer token and without marking it verified", (method, path) => {
    expect(run(method, path)).toEqual({ passed: true, status: undefined, verified: false });
  });

  const protectedNeighbours: Array<[string, string]> = [
    ["GET", "/api/signals/webhook"],
    ["POST", "/api/signals"],
    ["POST", "/api/signals/webhook/extra"],
    ["GET", "/api/signals/status"],
    ["GET", "/api/github/webhooks"],
    ["POST", "/api/github/webhooks/extra"],
    ["POST", "/api/github/prs"],
    ["POST", "/api/routines/routine-1/run"],
    ["POST", "/api/routines/routine-1/trigger"],
    ["PATCH", "/api/routines/routine-1/webhook"],
    ["POST", "/api/routines/webhook"],
    ["GET", "/api/monitor/metrics"],
    ["GET", "/api/monitor/incidents"],
    ["POST", "/api/monitor/other"],
    ["GET", "/api/tasks"],
  ];

  it.each(protectedNeighbours)("still rejects %s %s without a bearer token", (method, path) => {
    expect(run(method, path)).toEqual({ passed: false, status: 401, verified: false });
  });

  it.each([["GET", "/API/tasks"], ["GET", "/Api/settings"], ["POST", "/API/MONITOR/METRICS"], ["GET", "/API"]])(
    "gates %s %s case-insensitively, matching Express routing",
    (method, path) => {
      expect(run(method, path)).toEqual({ passed: false, status: 401, verified: false });
    },
  );

  it("still exempts liveness and CLI-agent hooks regardless of case", () => {
    expect(run("GET", "/API/health").passed).toBe(true);
    expect(run("POST", "/Api/cli-agent/hooks").passed).toBe(true);
  });
});

describe("isDaemonAuthActive", () => {
  const originalEnv = process.env.FUSION_DAEMON_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FUSION_DAEMON_TOKEN;
    } else {
      process.env.FUSION_DAEMON_TOKEN = originalEnv;
    }
  });

  it("returns true when daemon option with token is provided", () => {
    const result = isDaemonAuthActive({ daemon: { token: "fn_abc123" } });
    expect(result).toBe(true);
  });

  it("returns true when FUSION_DAEMON_TOKEN env var is set", () => {
    process.env.FUSION_DAEMON_TOKEN = "fn_xyz789";
    const result = isDaemonAuthActive();
    expect(result).toBe(true);
  });

  it("returns false when no daemon option and env var not set", () => {
    delete process.env.FUSION_DAEMON_TOKEN;
    const result = isDaemonAuthActive();
    expect(result).toBe(false);
  });

  it("prefers daemon option over env var", () => {
    process.env.FUSION_DAEMON_TOKEN = "fn_env_token";
    const result = isDaemonAuthActive({ daemon: { token: "fn_option_token" } });
    expect(result).toBe(true);
  });
});
