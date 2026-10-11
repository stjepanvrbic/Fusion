import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { McpSecretReader, TaskStore } from "@fusion/core";
import { buildFusionMemoryBuiltIns } from "@fusion/core/mcp-builtin-servers";
import {
  resolveMcpExportEffectiveServers,
  resolveMcpListEffectiveServers,
  resolveMcpValidateEffectiveServers,
} from "../../../cli/src/commands/mcp.js";
import { resolveMcpServersForMcpProbe } from "../../../dashboard/src/routes/register-config-mcp-pi-settings-routes.js";
import { resolveMcpServers } from "../executor/resolve-mcp-servers.js";
import { resolveHeartbeatMcpForAgent } from "../agent-heartbeat.js";
import { resolveMcpServersForRuntime, resolveMcpServersForStore, type McpSettingsAndSecretsStore } from "../mcp/mcp-resolution.js";

const repoRoot = resolve(process.cwd(), "../..");
const roots = ["packages/engine/src", "packages/dashboard/src", "packages/dashboard/app", "packages/cli/src", "packages/core/src"];
const needles = ["resolveMcpServersForStore(", "resolveMcpServersForRuntime(", "resolveEffectiveMcpServers("] as const;
const fixtureEntry = resolve(repoRoot, "package.json");
type Bucket = "A" | "B" | "C" | "D" | "R";
type LedgerRow = { file: string; symbol: string; needle: string; ordinal: number; anchor: string; bucket: Bucket; expression: string; type?: "TaskStore" | "nullable-root"; reason: string; passesBuiltIns?: true | "descriptor-only" };
type LedgerTuple = [file: string, symbol: string, needle: string, ordinal: number, bucket: Bucket, expression: string, type: LedgerRow["type"], reason: string, passesBuiltIns?: LedgerRow["passesBuiltIns"]];

/*
 * FNXC:MemoryMcpCoverage 2026-08-11-00:05:
 * This is intentionally a per-call-site ledger, not a file/count inventory. A resolver forwarding
 * scan cannot prove a lane passes a root-capable store, so each A row names its real expression and
 * type while D records direct callers that would otherwise bypass the runtime resolver.
 *
 * FNXC:MemoryMcpCoverage 2026-10-11-19:54:
 * Rows identify a call site by symbol anchor (`file::enclosingSymbolPath::needle#ordinal`), never by line number.
 * Line pins turned this guard red whenever an unrelated edit moved code above a ledgered call.
 * An anchor changes only when a call is added, removed, or moved into a different enclosing function, which are the changes this ledger must report.
 * Row shape: [file, enclosingSymbolPath, needle, ordinal, bucket, expression, type, reason, passesBuiltIns?].
 */
const LEDGER: LedgerRow[] = ([
  ["packages/engine/src/executor/resolve-mcp-servers.ts","resolveMcpServers","resolveMcpServersForStore",1,"A","deps.store","TaskStore","executor TaskStore"],
  ["packages/engine/src/execution/reviewer.ts","reviewStep.createReviewerSession","resolveMcpServersForStore",1,"A","options.store","TaskStore","reviewer TaskStore"],
  ["packages/engine/src/merger.ts","resolveMergerMcpServers","resolveMcpServersForStore",1,"A","store","TaskStore","merger TaskStore"],
  ["packages/engine/src/merge/merger-ai.ts","makeMutatingAgent","resolveMcpServersForStore",1,"A","store","TaskStore","merger AI TaskStore"],
  ["packages/engine/src/merge/merger-ai.ts","makeReviewAgent","resolveMcpServersForStore",1,"A","store","TaskStore","merger AI TaskStore"],
  ["packages/engine/src/merge/pr-response-run-ops.ts","makePrResponseAgentRunner","resolveMcpServersForStore",1,"A","store","TaskStore","PR response TaskStore"],
  ["packages/engine/src/agent-heartbeat.ts","resolveHeartbeatMcpForAgent","resolveMcpServersForStore",1,"A","taskStore","nullable-root","heartbeat accepts a nullable root"],
  ["packages/engine/src/triage.ts","TriageProcessor.specifyTask.agentWork","resolveMcpServersForStore",1,"A","this.store","TaskStore","triage TaskStore"],
  ["packages/engine/src/scheduling/cron-runner.ts","createAiPromptExecutor","resolveMcpServersForStore",1,"A","store","TaskStore","cron TaskStore"],
  ["packages/engine/src/missions/mission-execution-loop.ts","MissionExecutionLoop.runValidation","resolveMcpServersForStore",1,"A","this.taskStore","TaskStore","mission TaskStore"],
  ["packages/engine/src/agents/agent-reflection.ts","AgentReflectionService.generateReflection","resolveMcpServersForStore",1,"A","this.taskStore","TaskStore","reflection TaskStore"],
  ["packages/engine/src/eval/evaluator.ts","HybridEvaluatorService.runPrompt","resolveMcpServersForStore",1,"A","this.deps.store","TaskStore","evaluator TaskStore"],
  // FNXC:MemoryMcpCoverage 2026-08-23-19:48: memory-semantics runs a readonly model session on `input.taskStore` (typed TaskStore, root-capable), so it is an A lane like every other store-backed resolver call.
  ["packages/engine/src/memory/memory-semantics.ts","runMemorySemanticsPass","resolveMcpServersForStore",1,"A","input.taskStore","TaskStore","memory semantics TaskStore"],
  ["packages/dashboard/src/chat.ts","ChatManager.sendMessage","resolveMcpServersForStore",1,"A","this.taskStore","TaskStore","chat scoped TaskStore"],
  ["packages/dashboard/src/planning.ts","resolvePlanningMcpServers","resolveMcpServersForStore",1,"A","store","TaskStore","planning TaskStore"],
  ["packages/dashboard/src/milestone-slice-interview.ts","createTargetInterviewAgent","resolveMcpServersForStore",1,"A","store","TaskStore","milestone TaskStore"],
  ["packages/dashboard/src/mission-interview.ts","createMissionInterviewAgent","resolveMcpServersForStore",1,"A","store","TaskStore","mission interview TaskStore"],
  ["packages/dashboard/src/agent-generation.ts","generateSpecWithAI","resolveMcpServersForStore",1,"A","store ?? {}","TaskStore","optional store resolves as TaskStore when present"],
  ["packages/dashboard/src/pr-conflict-resolver.ts","runResolutionAgent","resolveMcpServersForStore",1,"A","store","TaskStore","conflict resolver TaskStore"],
  ["packages/dashboard/src/routes/automation-step-execution.ts","resolveManualAiPromptMcpServers","resolveMcpServersForStore",1,"A","taskStore","TaskStore","automation TaskStore"],
  ["packages/dashboard/src/ai-refine.ts","refineText","resolveMcpServersForStore",1,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/ai-refine.ts","draftGoalDescription","resolveMcpServersForStore",1,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/ai-translate.ts","translateText","resolveMcpServersForStore",1,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/agent-onboarding.ts","createAgentOnboardingAgent","resolveMcpServersForStore",1,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/pr-metadata-generator.ts","generatePrMetadata","resolveMcpServersForStore",1,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/insights-routes.ts","executeInsightAttempt","resolveMcpServersForStore",1,"B","params.taskStore ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/engine/src/agent-heartbeat.ts","resolveHeartbeatMcpForAgent","resolveMcpServersForStore",1,"C","taskStore","nullable-root","undefined or empty root omits only built-in"],
  ["packages/cli/src/commands/mcp.ts","resolveMcpListEffectiveServers","resolveEffectiveMcpServers",1,"D","builtIns",undefined,"CLI list direct resolver",true],
  ["packages/cli/src/commands/mcp.ts","resolveMcpExportEffectiveServers","resolveEffectiveMcpServers",1,"D","builtIns",undefined,"CLI export direct resolver",true],
  ["packages/cli/src/commands/mcp.ts","resolveMcpValidateEffectiveServers","resolveEffectiveMcpServers",1,"D","builtIns",undefined,"CLI validate direct resolver",true],
  ["packages/dashboard/app/components/settings/sections/McpServersCard.tsx","McpServersCard","resolveEffectiveMcpServers",1,"D","descriptor display",undefined,"browser has no spawn entry","descriptor-only"],
  ["packages/engine/src/mcp/mcp-resolution.ts","resolveMcpServersForRuntime","resolveMcpServersForRuntime",1,"D","runtime resolver",undefined,"runtime entrypoint",true],
  ["packages/engine/src/mcp/mcp-resolution.ts","resolveMcpServersForRuntime","resolveEffectiveMcpServers",1,"D","built-in factory",undefined,"runtime calls effective resolver",true],
  ["packages/engine/src/mcp/mcp-resolution.ts","resolveMcpServersForStore","resolveMcpServersForStore",1,"D","store resolver",undefined,"store entrypoint",true],
  ["packages/engine/src/mcp/mcp-resolution.ts","resolveMcpServersForStore","resolveMcpServersForRuntime",1,"D","projectRoot",undefined,"store forwards root",true],
  ["packages/core/src/config/mcp-config.ts","resolveEffectiveMcpServers","resolveEffectiveMcpServers",1,"D","effective resolver",undefined,"resolution chokepoint",true],
  ["packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts","resolveMcpServersForMcpProbe","resolveMcpServersForRuntime",1,"R","explicit projectRoot",undefined,"server probe root"],
  ["packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts","resolveMcpServerForValidation","resolveMcpServersForStore",1,"R","scopedStore",undefined,"server settings root"],
] satisfies LedgerTuple[]).map(([file, symbol, needle, ordinal, bucket, expression, type, reason, passesBuiltIns]) => ({
  file, symbol, needle, ordinal, anchor: `${file}::${symbol}::${needle}#${ordinal}`, bucket, expression, type, reason, passesBuiltIns,
}));

const secretReader: McpSecretReader = { revealSecret: async () => { throw new Error("unexpected secret"); } };
const rootStore = {
  async getSettingsByScope() { return { global: { mcpServers: { enabled: true } }, project: { mcpServers: { enabled: true } } }; },
  getSecretsStore: async () => secretReader,
  getRootDir: () => "/fixture",
};

type NullableRootStore = Omit<McpSettingsAndSecretsStore, "getRootDir"> & { getRootDir(): string | undefined };
const taskStoreWitness = null as unknown as TaskStore satisfies McpSettingsAndSecretsStore;
const nullableRootWitness = null as unknown as NullableRootStore satisfies McpSettingsAndSecretsStore;
void taskStoreWitness;
void nullableRootWitness;

type DerivedSite = { anchor: string; file: string; symbolPath: string; needle: string; ordinal: number; lineText: string; lineHint: number };

/** Name a node contributes to the enclosing symbol path, following `_merge-durable-write-callsites.ts`. */
function symbolName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node))
    && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
  return undefined;
}

/**
 * Derive the resolver call sites of one source file.
 * Detection stays line-based (a line containing a needle, first needle wins) so the census equals the one the line-pinned ledger counted.
 * Identity is the enclosing symbol path plus a 1-based ordinal per (file, symbol, needle).
 * `lineHint` is diagnostic text for failure messages and is never compared.
 */
function deriveSites(file: string, text: string): DerivedSite[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: DerivedSite[] = [];
  const ordinals = new Map<string, number>();
  for (const [index, lineText] of text.split(/\r?\n/).entries()) {
    const match = needles.find((needle) => lineText.includes(needle));
    if (!match) continue;
    const position = sf.getPositionOfLineAndCharacter(index, lineText.indexOf(match));
    const names: string[] = [];
    const visit = (node: ts.Node) => {
      if (position < node.getStart(sf) || position >= node.getEnd()) return;
      const name = symbolName(node);
      if (name) names.push(name);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    const symbolPath = names.join(".") || "<module>";
    const needle = match.slice(0, -1);
    const key = `${symbolPath}::${needle}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    sites.push({ anchor: `${file}::${symbolPath}::${needle}#${ordinal}`, file, symbolPath, needle, ordinal, lineText, lineHint: index + 1 });
  }
  return sites;
}

function sourceSites(): DerivedSite[] {
  const found: DerivedSite[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "__tests__" && entry.name !== "mocks") walk(full); continue; }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      found.push(...deriveSites(full.slice(repoRoot.length + 1).replaceAll("\\", "/"), readFileSync(full, "utf8")));
    }
  };
  for (const root of roots) walk(resolve(repoRoot, root));
  return found;
}

type LedgerComparison = { unmapped: string[]; missing: string[]; duplicateSites: string[] };

/**
 * FNXC:MemoryMcpCoverage 2026-10-11-19:57:
 * The ledger guarantee is that every derived resolver call site has a ledger row and every ledger row has a call site.
 * Equality is by anchor only: `lineHint` appears in the `unmapped` text so a failure points at the call, and it never decides the result.
 * Ledger rows may share an anchor, because one call can sit in two buckets (the heartbeat call is both A and C), so rows are compared as an anchor set.
 * Two derived sites sharing an anchor would let one row cover two calls, so that is reported as a failure of its own.
 */
function compareLedger(sites: DerivedSite[], ledger: Pick<LedgerRow, "anchor">[]): LedgerComparison {
  const ledgerAnchors = new Set(ledger.map((row) => row.anchor));
  const siteCounts = new Map<string, number>();
  for (const site of sites) siteCounts.set(site.anchor, (siteCounts.get(site.anchor) ?? 0) + 1);
  return {
    unmapped: sites.filter((site) => !ledgerAnchors.has(site.anchor)).map((site) => `${site.anchor} (near line ${site.lineHint})`),
    missing: [...ledgerAnchors].filter((anchor) => !siteCounts.has(anchor)),
    duplicateSites: [...siteCounts].filter(([, count]) => count > 1).map(([anchor]) => anchor),
  };
}

const CLEAN_LEDGER: LedgerComparison = { unmapped: [], missing: [], duplicateSites: [] };

/** In-memory source covering a module-level call, two calls in one function, a call-free function and a class method. */
const anchorFixtureSource = [
  "const top = resolveMcpServersForStore(store);",
  "export async function lane(store: unknown) {",
  "  const a = await resolveMcpServersForStore(store);",
  "  const b = await resolveMcpServersForStore(store);",
  "  return [a, b];",
  "}",
  "export async function otherLane(store: unknown) {",
  "  return store;",
  "}",
  "class Runner {",
  "  async run() { return resolveMcpServersForRuntime({}); }",
  "}",
].join("\n");

function hasMemoryServer(result: { servers: Array<{ name: string; args?: string[] }> }) {
  expect(result.servers).toContainEqual(expect.objectContaining({ name: "fusion-memory", args: expect.arrayContaining([fixtureEntry]) }));
}

describe("fusion-memory MCP lane ledger", () => {
  const priorEntry = process.env.FUSION_MEMORY_MCP_ENTRY;
  afterEach(() => {
    if (priorEntry === undefined) delete process.env.FUSION_MEMORY_MCP_ENTRY;
    else process.env.FUSION_MEMORY_MCP_ENTRY = priorEntry;
  });

  it("maps every resolver call across all roots to one required bucket", () => {
    const sites = sourceSites();
    expect(
      compareLedger(sites, LEDGER),
      "resolver call sites must map 1:1 to ledger anchors; add a LEDGER row for each unmapped site and remove each missing one",
    ).toEqual(CLEAN_LEDGER);
    const siteByAnchor = new Map(sites.map((site) => [site.anchor, site]));
    expect(LEDGER.filter((row) => row.bucket === "A").map((row) => row.file)).toEqual(expect.arrayContaining([
      expect.stringContaining("executor"), expect.stringContaining("reviewer"), expect.stringContaining("merger"), expect.stringContaining("triage"), expect.stringContaining("agent-heartbeat"), expect.stringContaining("chat"), expect.stringContaining("planning"),
    ]));
    expect(LEDGER.filter((row) => row.bucket === "D" && row.passesBuiltIns === true).filter((row) => row.file === "packages/cli/src/commands/mcp.ts")).toHaveLength(3);
    for (const row of LEDGER.filter((entry) => entry.file === "packages/cli/src/commands/mcp.ts")) expect(siteByAnchor.get(row.anchor)?.lineText).toContain("builtIns");
  });

  describe("symbol anchors", () => {
    const anchors = (text: string) => deriveSites("pkg/x.ts", text).map((site) => site.anchor);

    it("are invariant under line shifts", () => {
      const expected = [
        "pkg/x.ts::<module>::resolveMcpServersForStore#1",
        "pkg/x.ts::lane::resolveMcpServersForStore#1",
        "pkg/x.ts::lane::resolveMcpServersForStore#2",
        "pkg/x.ts::Runner.run::resolveMcpServersForRuntime#1",
      ];
      expect(anchors(anchorFixtureSource)).toEqual(expected);
      const shifted = `${Array.from({ length: 40 }, (_, index) => `const filler${index} = ${index};`).join("\r\n")}\r\n${anchorFixtureSource}`;
      expect(anchors(shifted)).toEqual(expected);
    });

    it("change when the enclosing function is renamed", () => {
      const renamed = anchors(anchorFixtureSource.replace("function lane", "function renamedLane"));
      expect(renamed).toContain("pkg/x.ts::renamedLane::resolveMcpServersForStore#1");
      expect(renamed).not.toContain("pkg/x.ts::lane::resolveMcpServersForStore#1");
    });

    it("number additional calls in the same function by ordinal", () => {
      const third = anchorFixtureSource.replace("  return [a, b];", "  const c = await resolveMcpServersForStore(store);\n  return [a, b, c];");
      expect(anchors(third)).toContain("pkg/x.ts::lane::resolveMcpServersForStore#3");
    });

    it("resolve the enclosing component of a call inside a .tsx callback", () => {
      const component = [
        "export function Card() {",
        "  const servers = useMemo(() => resolveEffectiveMcpServers(globalMcp, projectMcp), []);",
        "  return <ul>{servers.map((server) => <li key={server.name}>{server.name}</li>)}</ul>;",
        "}",
      ].join("\n");
      expect(deriveSites("pkg/card.tsx", component).map((site) => site.anchor)).toEqual(["pkg/card.tsx::Card::resolveEffectiveMcpServers#1"]);
    });
  });

  describe("ledger comparison", () => {
    const file = "pkg/x.ts";
    const pinned = deriveSites(file, anchorFixtureSource);
    const ledger = pinned.map(({ anchor }) => ({ anchor }));
    const compare = (text: string) => compareLedger(deriveSites(file, text), ledger);
    const secondLaneCall = "  const b = await resolveMcpServersForStore(store);\n";

    it.each([["LF", "\n"], ["CRLF", "\r\n"]])("stays clean when lines are inserted above a pinned call (%s)", (_name, eol) => {
      const filler = Array.from({ length: 40 }, (_, index) => `const filler${index} = ${index};`);
      const insideLane = anchorFixtureSource.replace("  const a = await", "  const inserted = 1;\n  const a = await");
      const shiftedSites = deriveSites(file, [...filler, ...insideLane.split("\n")].join(eol));
      expect(compareLedger(shiftedSites, ledger)).toEqual(CLEAN_LEDGER);
      expect(shiftedSites).toHaveLength(pinned.length);
      expect(shiftedSites.every((site, index) => site.lineHint > pinned[index].lineHint), "every call moved to a later line").toBe(true);
    });

    it("reports a call moved into a different function as unmapped there and missing where it was", () => {
      const moved = anchorFixtureSource.replace(secondLaneCall, "").replace("  return store;", `${secondLaneCall}  return store;`);
      expect(compare(moved)).toEqual({
        unmapped: [expect.stringContaining("pkg/x.ts::otherLane::resolveMcpServersForStore#1 (near line ")],
        missing: ["pkg/x.ts::lane::resolveMcpServersForStore#2"],
        duplicateSites: [],
      });
    });

    it.each([
      ["a third call in a ledgered function", anchorFixtureSource.replace("  return [a, b];", "  const c = await resolveMcpServersForStore(store);\n  return [a, b, c];"), "pkg/x.ts::lane::resolveMcpServersForStore#3"],
      ["a call above the ledgered ones in the same function", anchorFixtureSource.replace("  const a = await", "  const first = await resolveMcpServersForStore(store);\n  const a = await"), "pkg/x.ts::lane::resolveMcpServersForStore#3"],
      ["a call in a function that had none", anchorFixtureSource.replace("  return store;", "  return resolveMcpServersForStore(store);"), "pkg/x.ts::otherLane::resolveMcpServersForStore#1"],
      ["a call in a new function", `${anchorFixtureSource}\nexport async function newLane(store: unknown) {\n  return resolveMcpServersForStore(store);\n}`, "pkg/x.ts::newLane::resolveMcpServersForStore#1"],
      ["a new module-level call", `${anchorFixtureSource}\nconst extra = resolveMcpServersForRuntime({});`, "pkg/x.ts::<module>::resolveMcpServersForRuntime#1"],
    ])("reports %s as unmapped", (_name, source, anchor) => {
      expect(compare(source)).toEqual({ unmapped: [expect.stringContaining(`${anchor} (near line `)], missing: [], duplicateSites: [] });
    });

    it("reports a removed call as a missing ledger row", () => {
      expect(compare(anchorFixtureSource.replace(secondLaneCall, ""))).toEqual({ unmapped: [], missing: ["pkg/x.ts::lane::resolveMcpServersForStore#2"], duplicateSites: [] });
    });

    it("reports two derived sites that share one anchor", () => {
      expect(compareLedger([...pinned, { ...pinned[1] }], ledger)).toEqual({ unmapped: [], missing: [], duplicateSites: ["pkg/x.ts::lane::resolveMcpServersForStore#1"] });
    });

    it("accepts ledger rows that share an anchor, and an empty ledger for a tree with no calls", () => {
      expect(compareLedger(pinned, [...ledger, ledger[1]])).toEqual(CLEAN_LEDGER);
      expect(compareLedger([], [])).toEqual(CLEAN_LEDGER);
    });
  });

  it("proves bucket behavior with an injected entry and no ambient build dependency", async () => {
    const enabled = { mcpServers: { enabled: true, servers: [{ name: "other", transport: "stdio" as const, command: "other" }] } };
    hasMemoryServer(await resolveMcpServersForRuntime({ globalSettings: enabled, projectSettings: null, secrets: secretReader, projectRoot: "/fixture", memoryMcpEntry: fixtureEntry }));
    await expect(resolveMcpServersForStore({})).resolves.toEqual({ servers: [], errors: [] });
    for (const root of [undefined, ""]) {
      const result = await resolveMcpServersForRuntime({ globalSettings: enabled, projectSettings: null, secrets: secretReader, projectRoot: root, memoryMcpEntry: fixtureEntry });
      expect(result.servers.map((server) => server.name)).toEqual(["other"]);
    }
    const missing = await resolveMcpServersForRuntime({ globalSettings: enabled, projectSettings: null, secrets: secretReader, projectRoot: "/fixture", memoryMcpEntry: null });
    expect(missing.servers.map((server) => server.name)).toEqual(["other"]);
  });

  it("drives every CLI direct resolver and the explicit-root probe with an injected entry", async () => {
    const global = { enabled: true, servers: [{ name: "other", transport: "stdio" as const, command: "other" }] };
    const builtIns = buildFusionMemoryBuiltIns("/fixture", fixtureEntry);
    const directResolvers = [resolveMcpListEffectiveServers, resolveMcpExportEffectiveServers, resolveMcpValidateEffectiveServers];
    for (const resolveDirect of directResolvers) {
      hasMemoryServer({ servers: resolveDirect(global, undefined, builtIns) });
    }

    const probe = await resolveMcpServersForMcpProbe({
      globalSettings: { mcpServers: global },
      projectSettings: null,
      secrets: secretReader,
      projectRoot: "/fixture",
      memoryMcpEntry: fixtureEntry,
    });
    hasMemoryServer(probe);
  });

  it("drives executor and heartbeat wrappers with a root and validates heartbeat degradation", async () => {
    process.env.FUSION_MEMORY_MCP_ENTRY = fixtureEntry;
    const store = rootStore as unknown as TaskStore;
    const executor = await resolveMcpServers({ store });
    expect(executor).toContainEqual(expect.objectContaining({ name: "fusion-memory" }));
    const heartbeat = await resolveHeartbeatMcpForAgent(store, "agent");
    expect(heartbeat.servers).toContainEqual(expect.objectContaining({ name: "fusion-memory" }));
    const noRoot = { ...rootStore, getRootDir: () => undefined } as unknown as TaskStore;
    await expect(resolveHeartbeatMcpForAgent(noRoot, "agent")).resolves.toMatchObject({ servers: [] });
  });
});
