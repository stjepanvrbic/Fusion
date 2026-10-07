import { describe, expect, it } from "vitest";

import { resolvePgAvailability } from "../__test-utils__/pg-test-harness.js";
import pgGateConfig from "../../vitest.pg.config";

/*
FNXC:PgGateRequired 2026-10-07-18:03:
The required PostgreSQL gate lane must fail, not skip, for every missing prerequisite (stopped server, wrong endpoint, skip override, empty URL), while optional lanes keep skipping.
*/
const URL_BASE = "postgresql://postgres:postgres@localhost:55432";
const reachable = () => true;
const unreachable = () => false;

describe("resolvePgAvailability", () => {
  it("runs PG suites when the server answers, in required and optional lanes", () => {
    expect(resolvePgAvailability({}, URL_BASE, reachable)).toEqual({ available: true });
    expect(resolvePgAvailability({ FUSION_PG_TEST_REQUIRED: "1" }, URL_BASE, reachable)).toEqual({ available: true });
  });

  it("probes the configured endpoint, not a default", () => {
    const probed: Array<[string, number]> = [];
    resolvePgAvailability({}, "postgresql://u:p@db.internal:6543", (host, port) => {
      probed.push([host, port]);
      return true;
    });
    expect(probed).toEqual([["db.internal", 6543]]);
  });

  it("skips in an optional lane for every missing prerequisite", () => {
    expect(resolvePgAvailability({}, URL_BASE, unreachable)).toMatchObject({ available: false, reason: "unreachable" });
    expect(resolvePgAvailability({ FUSION_PG_TEST_SKIP: "1" }, URL_BASE, reachable)).toMatchObject({ available: false, reason: "skip-requested" });
    expect(resolvePgAvailability({}, "", reachable)).toMatchObject({ available: false, reason: "no-url" });
  });

  it("fails the required lane when the server is down or the endpoint is wrong", () => {
    expect(() => resolvePgAvailability({ FUSION_PG_TEST_REQUIRED: "1" }, URL_BASE, unreachable)).toThrow(
      /required for this test lane .*no PostgreSQL accepting connections at localhost:55432/,
    );
  });

  it("fails the required lane when the skip override is inherited, even with a live server", () => {
    expect(() => resolvePgAvailability({ FUSION_PG_TEST_REQUIRED: "1", FUSION_PG_TEST_SKIP: "1" }, URL_BASE, reachable)).toThrow(
      /FUSION_PG_TEST_SKIP=1 is set/,
    );
  });

  it("fails the required lane when no URL is configured", () => {
    expect(() => resolvePgAvailability({ FUSION_PG_TEST_REQUIRED: "1" }, "", reachable)).toThrow(/FUSION_PG_TEST_URL_BASE is empty/);
  });

  it("never echoes connection credentials in the failure", () => {
    expect(() => resolvePgAvailability({ FUSION_PG_TEST_REQUIRED: "1" }, URL_BASE, unreachable)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("postgres:postgres") }),
    );
  });
});

describe("test:pg-gate config", () => {
  it("marks the dedicated PostgreSQL gate lane as required and participating", () => {
    expect(pgGateConfig.test?.env).toMatchObject({ FUSION_PG_TEST_REQUIRED: "1", FUSION_PG_TEST_SETUP_PARTICIPANT: "1" });
  });
});
