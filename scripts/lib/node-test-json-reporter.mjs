/*
FNXC:CI 2026-10-08-10:42:
KB-062 adds a Windows Full Suite lane for the scripts/__tests__ node:test suite. scripts/check-windows-known-failing.mjs reads Vitest's JSON report shape ({ testResults: [{ name, status, message, assertionResults }] }), and node:test has no built-in reporter that emits it, so this custom reporter converts node:test events into that shape.
One row per test file (absolute path). A file is failed when any event for it, at any nesting level, is a non-todo test:fail; this includes the file-level event node emits when a file fails to load. Skip and todo tests never fail a file.
failureMessages carry the error stack so the comparator's load-timeout classifier sees real evidence; node:test timeouts do not match Vitest's timeout text and are therefore classified as real failures, which is the conservative outcome.

Usage: node --test --test-reporter=./scripts/lib/node-test-json-reporter.mjs --test-reporter-destination=<report.json> <files>
*/
import path from "node:path";

const STDERR_TAIL_CHARS = 4000;

/** Unwraps node:test's ERR_TEST_FAILURE wrapper so the message names the real error. */
function describeError(error) {
  if (error === undefined || error === null) return "";
  const inner = error?.code === "ERR_TEST_FAILURE" && error.cause !== undefined && error.cause !== null ? error.cause : error;
  if (typeof inner === "string") return inner;
  const stack = typeof inner?.stack === "string" && inner.stack.trim() !== "" ? inner.stack : undefined;
  const message = typeof inner?.message === "string" ? inner.message : undefined;
  return stack ?? message ?? String(inner);
}

function statusOf(type, data) {
  if (data?.todo) return "todo";
  if (data?.skip) return "skipped";
  return type === "test:fail" ? "failed" : "passed";
}

/**
 * Builds the Vitest-shaped report from a list of node:test events. Pure, so it can be tested without a reporter stream.
 * @param {Array<{ type: string, data: any }>} events
 */
export function buildReport(events) {
  const files = new Map();
  // Ancestor names per file, indexed by nesting level, so assertion fullName reads "suite > case".
  const stacks = new Map();
  // Captured stderr per file: a load failure's error reaches the reporter only as the child's stderr.
  const stderr = new Map();
  for (const { type, data } of events) {
    if (type === "test:stderr" && typeof data?.file === "string") {
      const file = path.resolve(data.file);
      stderr.set(file, `${stderr.get(file) ?? ""}${String(data.message ?? "")}`.slice(-STDERR_TAIL_CHARS));
      continue;
    }
    if (type === "test:start" && typeof data?.file === "string") {
      const file = path.resolve(data.file);
      const stack = stacks.get(file) ?? [];
      stack[data.nesting ?? 0] = String(data.name ?? "");
      stack.length = (data.nesting ?? 0) + 1;
      stacks.set(file, stack);
      continue;
    }
    if ((type !== "test:pass" && type !== "test:fail") || typeof data?.file !== "string") continue;
    const file = path.resolve(data.file);
    const entry = files.get(file) ?? { name: file, status: "passed", message: "", assertionResults: [] };
    files.set(file, entry);
    const status = statusOf(type, data);
    const nesting = data.nesting ?? 0;
    const title = String(data.name ?? "");
    const ancestors = (stacks.get(file) ?? []).slice(0, nesting);
    // A top-level event named after the file itself is node's file-level result (for example a load error, whose own error is only "test failed").
    const fileLevel = nesting === 0 && (path.resolve(title) === file || title === data.file || title === path.basename(file));
    const errorText = describeError(data.details?.error);
    const evidence = fileLevel && status === "failed" ? (stderr.get(file) ?? "").trim() : "";
    const failureMessages = status === "failed" ? [evidence !== "" ? `${errorText}\n${evidence}` : errorText].filter((text) => text !== "") : [];
    if (fileLevel && status === "failed" && entry.message === "") entry.message = failureMessages[0] ?? "test file failed";
    entry.assertionResults.push({ status, title, fullName: [...ancestors, title].join(" > "), failureMessages });
    if (status === "failed") entry.status = "failed";
  }
  const testResults = [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    numTotalTestSuites: testResults.length,
    numFailedTestSuites: testResults.filter((result) => result.status === "failed").length,
    success: testResults.every((result) => result.status !== "failed"),
    testResults,
  };
}

/** node:test custom reporter: collects every event, then yields exactly one JSON document. */
export default async function* nodeTestJsonReporter(source) {
  const events = [];
  for await (const event of source) {
    if (event.type === "test:start" || event.type === "test:pass" || event.type === "test:fail" || event.type === "test:stderr") events.push({ type: event.type, data: event.data });
  }
  yield `${JSON.stringify(buildReport(events), null, 2)}\n`;
}
