// @vitest-environment node

/*
FNXC:ReviewLaneBypass 2026-10-08-02:27:
KB-019: GET /tasks/:id/bypass-review is the dashboard's only bypass-eligibility authority.
The route passes the store's evaluator answer through verbatim (including a required gate that never ran), maps lookup misses to 404, and leaves the POST bypass mutation untouched.
In-memory store fakes only (no DB, no network, no timers) per the AGENTS.md slow-test rule.
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { ReviewBypassEligibility, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const ABSENT: ReviewBypassEligibility = {
  bypassable: true,
  workflowStepId: "plan-review",
  workflowStepName: "plan-review",
  source: "absent",
  reason: null,
};

function makeHarness() {
  const eligibilitySpy = vi.fn(async (_id: string): Promise<ReviewBypassEligibility> => ABSENT);
  const bypassSpy = vi.fn(async (id: string, _input: { reason: string; actor: string }) => ({ id, column: "in-review" }));

  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getReviewBypassEligibility: eligibilitySpy,
    bypassFailedPreMergeReviewStep: bypassSpy,
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, eligibilitySpy, bypassSpy };
}

describe("GET /tasks/:id/bypass-review — server-owned eligibility", () => {
  it("passes the store's absent-gate answer through verbatim for the path id", async () => {
    const { app, eligibilitySpy, bypassSpy } = makeHarness();
    const res = await REQUEST(app, "GET", "/api/tasks/FN-ABSENT/bypass-review");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(ABSENT);
    expect(eligibilitySpy).toHaveBeenCalledWith("FN-ABSENT");
    expect(bypassSpy).not.toHaveBeenCalled();
  });

  it("passes a refusal through with 200", async () => {
    const { app, eligibilitySpy } = makeHarness();
    const refusal: ReviewBypassEligibility = {
      bypassable: false,
      workflowStepId: null,
      workflowStepName: null,
      source: null,
      reason: "Cannot bypass review lane for FN-1: task is paused",
    };
    eligibilitySpy.mockResolvedValueOnce(refusal);
    const res = await REQUEST(app, "GET", "/api/tasks/FN-1/bypass-review");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(refusal);
  });

  it("maps a not-found store rejection to 404", async () => {
    const { app, eligibilitySpy } = makeHarness();
    eligibilitySpy.mockRejectedValueOnce(Object.assign(new Error("Task FN-missing not found"), { name: "TaskNotFoundError", code: "TASK_NOT_FOUND" }));
    const typed = await REQUEST(app, "GET", "/api/tasks/FN-missing/bypass-review");
    eligibilitySpy.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }));
    const enoent = await REQUEST(app, "GET", "/api/tasks/FN-missing/bypass-review");

    expect(typed.status).toBe(404);
    expect(enoent.status).toBe(404);
  });

  it("maps a generic store failure to 500", async () => {
    const { app, eligibilitySpy } = makeHarness();
    eligibilitySpy.mockRejectedValueOnce(new Error("database unavailable"));
    const res = await REQUEST(app, "GET", "/api/tasks/FN-1/bypass-review");

    expect(res.status).toBe(500);
  });

  it("leaves the POST bypass mutation on its own handler", async () => {
    const { app, eligibilitySpy, bypassSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/FN-1/bypass-review", JSON.stringify({ reason: "gate never ran" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(bypassSpy).toHaveBeenCalledWith("FN-1", { reason: "gate never ran", actor: "dashboard-operator" });
    expect(eligibilitySpy).not.toHaveBeenCalled();
  });
});
