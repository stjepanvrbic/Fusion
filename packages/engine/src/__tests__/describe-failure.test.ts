import { describe, expect, it } from "vitest";
import { describeFailure } from "../errors/describe-failure.js";
import { classifyExternalObstacle } from "../execution-block-classifier.js";

const F = "Agent session failed without an error message";

function causeChain(depth: number): Error {
  let err = new Error("");
  for (let i = 0; i < depth; i++) err = new Error("", { cause: err });
  return err;
}

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

const selfCaused = new Error("");
(selfCaused as { cause?: unknown }).cause = selfCaused;

const longStderr = `start ${"x".repeat(600)} end`;

describe("describeFailure", () => {
  it.each<[string, unknown, string]>([
    ["a non-blank Error message unchanged", new Error("429 too many requests"), "429 too many requests"],
    ["a non-blank Error message without trimming", new Error("  padded  "), "  padded  "],
    ["a non-blank string unchanged", "boom", "boom"],
    ["a plain object message", { message: "429 Too Many Requests" }, "429 Too Many Requests"],
    ["an empty Error message", new Error(""), `${F} (error type: Error)`],
    ["a whitespace Error message", new Error("  \n "), `${F} (error type: Error)`],
    ["the subclass name", new TypeError(""), `${F} (error type: TypeError)`],
    ["the constructor name when the name is blank", Object.assign(new Error(""), { name: "" }), `${F} (error type: Error)`],
    [
      "exit code and stderr",
      Object.assign(new Error(""), { exitCode: 1, stderr: "fatal: not logged in\n" }),
      `${F} (error type: Error; exit code: 1; stderr: fatal: not logged in)`,
    ],
    ["a string code", Object.assign(new Error(""), { code: "ECONNRESET" }), `${F} (error type: Error; code: ECONNRESET)`],
    ["a numeric code", Object.assign(new Error(""), { code: 7 }), `${F} (error type: Error; code: 7)`],
    ["a signal", Object.assign(new Error(""), { signal: "SIGKILL" }), `${F} (error type: Error; signal: SIGKILL)`],
    ["a Buffer stderr", Object.assign(new Error(""), { stderr: Buffer.from("  denied \n\t now ") }), `${F} (error type: Error; stderr: denied now)`],
    ["the stderr tail", Object.assign(new Error(""), { stderr: longStderr }), `${F} (error type: Error; stderr: …${longStderr.slice(-500)})`],
    [
      "all fields in order",
      Object.assign(new Error("", { cause: new Error("upstream") }), { stderr: "e", signal: "SIGTERM", exitCode: 2, code: "X" }),
      `${F} (error type: Error; code: X; exit code: 2; signal: SIGTERM; stderr: e; cause: upstream)`,
    ],
    ["a message-bearing cause", new Error("", { cause: new Error("429 Too Many Requests") }), `${F} (error type: Error; cause: 429 Too Many Requests)`],
    ["an empty cause", new Error("", { cause: new Error("") }), `${F} (error type: Error; cause: ${F} (error type: Error))`],
    [
      "at most three cause levels",
      causeChain(4),
      `${F} (error type: Error; cause: ${F} (error type: Error; cause: ${F} (error type: Error; cause: ${F} (error type: Error))))`,
    ],
    ["a cyclic cause once", selfCaused, `${F} (error type: Error)`],
    ["undefined", undefined, `${F} (rejection value: undefined)`],
    ["null", null, `${F} (rejection value: null)`],
    ["an empty string", "", `${F} (rejection value: empty string)`],
    ["a whitespace string", "   ", `${F} (rejection value: empty string)`],
    ["an empty object", {}, `${F} (rejection value: {})`],
    ["a number", 42, `${F} (rejection value: 42)`],
    ["a cyclic object", cyclic, `${F} (rejection value: [object Object])`],
    ["a large object bounded", { data: "y".repeat(600) }, `${F} (rejection value: ${JSON.stringify({ data: "y".repeat(600) }).slice(0, 500)}…)`],
  ])("describes %s", (_label, value, expected) => {
    expect(describeFailure(value, "Agent session")).toBe(expected);
  });

  it("uses the given subject", () => {
    expect(describeFailure(new Error(""), "Workflow node")).toBe("Workflow node failed without an error message (error type: Error)");
  });
});

describe("classification of described failures", () => {
  it.each<[string, unknown]>([
    ["an empty Error", new Error("")],
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["an empty object", {}],
    ["a number", 42],
  ])("does not classify %s", (_label, value) => {
    expect(classifyExternalObstacle(describeFailure(value, "Agent session"))).toBeUndefined();
  });

  it("classifies a 429 cause as a provider rate limit", () => {
    const text = describeFailure(new Error("", { cause: new Error("429 Too Many Requests") }), "Agent session");
    expect(classifyExternalObstacle(text)).toEqual({ origin: "model-provider", code: "RATE_LIMIT" });
  });

  it("classifies a network code as a network failure", () => {
    const text = describeFailure(Object.assign(new Error(""), { code: "ECONNRESET" }), "Agent session");
    expect(classifyExternalObstacle(text)).toEqual({ origin: "network", code: "ECONNRESET" });
  });
});
