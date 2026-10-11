import { describe, expect, it } from "vitest";

import { buildDesktopVitestArgs } from "../test-args";

describe("buildDesktopVitestArgs", () => {
  it("defaults to concise dot output when no caller selects a reporter", () => {
    expect(buildDesktopVitestArgs([])).toEqual(["run", "--silent=passed-only", "--reporter=dot"]);
    expect(buildDesktopVitestArgs(["src/__tests__/main.test.ts"])).toEqual([
      "run",
      "--silent=passed-only",
      "src/__tests__/main.test.ts",
      "--reporter=dot",
    ]);
  });

  it("forwards exact CI JSON timing flags without adding a conflicting default", () => {
    const shardFlags = ["--reporter=json", "--outputFile.json=.timings/timings-shard1-0.json"];
    expect(buildDesktopVitestArgs(shardFlags)).toEqual(["run", "--silent=passed-only", ...shardFlags]);
  });

  it("preserves supported split reporter/output syntax and multiple reporters", () => {
    const callerArgs = [
      "--reporter",
      "json",
      "--outputFile.json",
      ".timings/timings-shard2-0.json",
      "--reporter=verbose",
      "--shard=1/2",
    ];
    expect(buildDesktopVitestArgs(callerArgs)).toEqual(["run", "--silent=passed-only", ...callerArgs]);
  });

  it("recognizes the supported short reporter form", () => {
    expect(buildDesktopVitestArgs(["-r=json"])).toEqual(["run", "--silent=passed-only", "-r=json"]);
    expect(buildDesktopVitestArgs(["-r", "json"])).toEqual(["run", "--silent=passed-only", "-r", "json"]);
  });

  it("still appends dot output when caller flags select no reporter", () => {
    const callerArgs = ["--project=desktop", "--outputFile.json=.timings/x.json"];
    expect(buildDesktopVitestArgs(callerArgs)).toEqual([
      "run",
      "--silent=passed-only",
      ...callerArgs,
      "--reporter=dot",
    ]);
  });
});
