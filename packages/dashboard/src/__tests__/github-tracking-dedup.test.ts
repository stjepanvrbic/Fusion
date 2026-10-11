import { describe, expect, it } from "vitest";
import { applyOriginalDescription } from "@fusion/core";
import {
  buildIssueSearchQueries,
  DEDUP_MATCH_THRESHOLD,
  extractFileScopePaths,
  extractSymptomKeywords,
  scoreCandidateIssue,
} from "../github-tracking-dedup.js";

describe("extractFileScopePaths", () => {
  it("parses file scope block, dedupes, strips trailing globs, and caps results", () => {
    const prompt = `# Task\n\n- before\n\n## File Scope\n- \`packages/dashboard/src/routes/register-session-diff-routes.ts\`\n- packages/foo/*\n- packages/foo/*\n- packages/bar/**\n- packages/a\n- packages/b\n- packages/c\n- packages/d\n- packages/e\n- packages/f\n\n## Steps\n- after`;

    expect(extractFileScopePaths({ description: "desc", prompt })).toEqual([
      "packages/dashboard/src/routes/register-session-diff-routes.ts",
      "packages/foo",
      "packages/bar",
      "packages/a",
      "packages/b",
      "packages/c",
      "packages/d",
      "packages/e",
    ]);
  });

  it("returns empty when file scope section is missing", () => {
    expect(extractFileScopePaths({ description: "no section" })).toEqual([]);
  });

  it("uses the plan's File Scope, not a list quoted in the Original Description", () => {
    const request = "The requester explains the defect.\n\n## File Scope\n- `decoy/quoted-only.ts`\n\nOrigin: an earlier planning session.";
    const plan = "# Task\n\n## Mission\n\nDo it.\n\n## File Scope\n\n- `packages/engine/src/real.ts`\n\n## Steps\n\n- go\n";
    const prompt = applyOriginalDescription(plan, request);

    expect(extractFileScopePaths({ description: request, prompt })).toEqual(["packages/engine/src/real.ts"]);
  });

  it("reads a File Scope heading from a description-only task", () => {
    const description = "Fix the dedup search.\n\n## File Scope\n- `packages/dashboard/src/github-tracking-dedup.ts`\n";

    expect(extractFileScopePaths({ description })).toEqual(["packages/dashboard/src/github-tracking-dedup.ts"]);
  });
});

describe("extractSymptomKeywords", () => {
  it("extracts identifiers and error names, drops stopwords, respects max", () => {
    const keywords = extractSymptomKeywords({
      title: "Fix rebaseMergeTruncation and ParseIssueError",
      description: "Touches `registerSessionDiffRoutes` and `fusion` and `tokenizeIssueBody`",
    }, { max: 3 });

    expect(keywords).toEqual(["registerSessionDiffRoutes", "tokenizeIssueBody", "ParseIssueError"]);
  });
});

describe("buildIssueSearchQueries", () => {
  it("returns keyword query and quoted path queries (1-3 total)", () => {
    const queries = buildIssueSearchQueries(
      ["packages/dashboard/src/routes/register-session-diff-routes.ts", "packages/dashboard/src/github.ts"],
      ["rebaseMerge", "registerSessionDiffRoutes", "ParseIssueError"],
    );

    expect(queries).toEqual([
      "rebaseMerge registerSessionDiffRoutes ParseIssueError",
      '"packages/dashboard/src/routes/register-session-diff-routes.ts"',
      '"packages/dashboard/src/github.ts"',
    ]);
  });
});

describe("scoreCandidateIssue", () => {
  it("scores path + keyword matches and threshold gate is usable", () => {
    const scored = scoreCandidateIssue(
      {
        title: "Rebase merge truncation in registerSessionDiffRoutes",
        body: "File: packages/dashboard/src/routes/register-session-diff-routes.ts throws ParseIssueError",
      },
      ["packages/dashboard/src/routes/register-session-diff-routes.ts"],
      ["registerSessionDiffRoutes", "ParseIssueError", "nonMatchKeyword"],
    );

    expect(scored.matchedPaths).toEqual(["packages/dashboard/src/routes/register-session-diff-routes.ts"]);
    expect(scored.matchedKeywords).toEqual(["registerSessionDiffRoutes", "ParseIssueError"]);
    expect(scored.score).toBe(4);
    expect(scored.score).toBeGreaterThanOrEqual(DEDUP_MATCH_THRESHOLD);
  });
});
