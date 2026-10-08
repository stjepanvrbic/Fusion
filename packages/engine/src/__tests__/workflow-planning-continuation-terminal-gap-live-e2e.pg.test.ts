/*
FNXC:WorkflowScheduling 2026-07-30-07:10 (E2E evidence — the optional-role-parameter class, third instance):

Third measured instance of the pattern from #2795 and #2798, and the sharpest form of it: the
converted and unconverted call sites are in the SAME FILE, and one is nested inside the other's call
tree.

`in-process-runtime.ts` resolves terminal columns through an optional parameter defaulting to the
legacy pair (`done` + `archived`). Three internal call sites:

  drainDuePlanningContinuations:386        passes { terminalColumns }              CONVERTED
  selectActionablePlanningContinuations:413 passes NOTHING                         unconverted
  resolvePlanningContinuationCandidate      threads its resolved set into the inner
                                            dispatchable predicate                 CONVERTED (2026-08-02)

WHAT BREAKS. `selectActionablePlanningContinuations` documents its own purpose as excluding
"soft-deleted / archived / done tasks so archive-fallback rows returned by getTask cannot re-enter
plan-review after the card left the board". On a renamed board its terminal check is against ids that
board does not have, so a card sitting in its COMPLETE column is classified `actionable` and re-enters
plan-review — precisely the thing the function exists to prevent, silently, on every custom board.

The third site WAS the subtler one — `resolvePlanningContinuationCandidate` applied the caller's
resolved set to its own terminal test and then delegated to `isPlanningContinuationTaskDispatchable`
without passing it. That half has since been fixed, and this suite is how it was noticed: the audit
case turned red on the arity change.

What did NOT change is the outcome. `selectActionablePlanningContinuations` still passes nothing, so
the CHARACTERIZATION case below is untouched — a card in a renamed COMPLETE lane still comes back
`actionable`. That is the useful shape of a partial conversion: the code reads more converted than
before and the operator-visible defect is exactly where it was.

WHY THE CENSUS CANNOT SEE ANY OF IT. There is no column literal at the unconverted call sites — the
literal is `LEGACY_TERMINAL_PAIR`, one function away, where it is correct for an unconverted caller
and correctly annotated. Same mechanism as #2795 and #2798; this file adds the intra-file variant.

SCOPE, STATED HONESTLY. The behavioural cases are driven end to end with real persisted rows from a
live PostgreSQL store and the real exported functions. The call-site split is asserted against the
runtime module's SYNTAX (parsed, not string-matched — see the note on that case) because driving the
drain needs the runtime's full dependency set, which I did not build; the audit case says so rather
than dressing it up.

FNXC:WorkflowResolvedColumns 2026-07-30-01:40 (follow-up — one severity correction and one site closed):

TWO REFINEMENTS to the above, both measured rather than argued.

1. `selectActionablePlanningContinuations` has NO PRODUCTION CALLER. Grepped across the repo excluding
   node_modules and dist: the only references are this file and
   `workflow-continuation-selection.test.ts`. The live drain is `drainDuePlanningContinuations:386`,
   which IS converted. So the stated consequence — a completed card re-entering plan-review "silently,
   on every custom board" — is NOT reachable today. The finding is real but LATENT: the helper is
   exported, so the first production caller inherits the bug. Worth keeping, worth not over-stating.

2. The THIRD site is closed. `resolvePlanningContinuationCandidate` now threads its own resolved
   `terminal` into `isPlanningContinuationTaskDispatchable`. Its reachable case is a board that declares
   `done` as a NON-terminal column id: the outer check passes, the inner one calls it terminal per the
   legacy pair, and the card is skipped as "paused" — stalled by a lane name. Pinned by two cases in
   `workflow-continuation-selection.test.ts`, revert-measured.

The first site is deliberately left: wiring a parameter into a function nothing calls would be an
unwired parameter, which is the anti-pattern the caller audit (#2803) removed five of.

FNXC:WorkflowScheduling 2026-10-08-13:51:
The call-site table above is historical. A third classifier caller now exists: the production continuation admission provider `listContinuationAdmissionCandidates` (628231a55), which threads resolved terminal columns like the drain. The AUDIT case pins all three sites by enclosing function.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import "@fusion/core"; // registers the built-in column traits
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import {
  resolvePlanningContinuationCandidate,
  selectActionablePlanningContinuations,
} from "../runtimes/in-process-runtime.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

/** A due planning continuation for a task. Only the fields the classifier reads matter. */
function planningItem(taskId: string): WorkflowWorkItem {
  return {
    id: `WI-${taskId}`,
    runId: "RUN-1",
    taskId,
    nodeId: "plan",
    kind: "node",
    state: "pending",
    attempt: 0,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: null,
    continuationSequence: 1,
    waitReason: "planning",
    sourceColumn: null,
    targetColumn: null,
    irHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as WorkflowWorkItem;
}

pgDescribe("planning-continuation terminal columns, measured on a live store", () => {
  /*
  FNXC:PatchnodeProjectScope 2026-09-22-03:44:
  Recovery rehomes can complete a task and record project-owned delivery history. Bind this live
  harness so that Patchnode transaction receives the store's non-empty project partition.
  */
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_plan_cont",
    projectId: "fusion-planning-continuation-e2e",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A real persisted card parked in its workflow's COMPLETE column — a card that has left the board. */
  async function completedCard(store: TaskStore, v: Vocabulary, key: string): Promise<Task> {
    const created = await store.createWorkflowDefinition({
      name: `Cont ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `continuation probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, v.complete as never, { recoveryRehome: true } as never);

    store.taskCache.delete(task.id);
    const row = await store.getTask(task.id);
    if (!row) throw new Error("fixture: card not persisted");
    return row;
  }

  it("CONTROL — on the DEFAULT board a completed card is correctly excluded", async () => {
    /* The legacy default is right here, which is why the omission went unnoticed. */
    const store = h.store();
    const card = await completedCard(store, DEFAULT_VOCAB, "wf-default-cont");

    expect(card.column).toBe(DEFAULT_VOCAB.complete); // ...which is literally "done"
    expect(selectActionablePlanningContinuations([{ item: planningItem(card.id), task: card }])).toEqual([]);
  });

  it("CHARACTERIZATION — on a RENAMED board a completed card re-enters plan-review", async () => {
    /*
    The card has left the board: it sits in its workflow's COMPLETE column. The function whose stated
    job is to stop exactly this returns it as actionable, because its terminal test is against ids
    this board does not contain.
    */
    const store = h.store();
    const card = await completedCard(store, RENAMED_VOCAB, "wf-renamed-cont");

    expect(card.column).toBe(RENAMED_VOCAB.complete);
    const actionable = selectActionablePlanningContinuations([{ item: planningItem(card.id), task: card }]);

    expect(actionable).toHaveLength(1);
    expect(actionable[0]?.task.id).toBe(card.id);
  });

  it("BOUND — the SAME card is an orphan once the resolved terminal columns are passed", async () => {
    /* Attributes the failure above to the call shape and nothing else: identical card, identical
       classifier, one extra argument — what the drain's converted call site does. */
    const store = h.store();
    const card = await completedCard(store, RENAMED_VOCAB, "wf-renamed-resolved");

    const resolved = resolvePlanningContinuationCandidate(planningItem(card.id), card, {
      terminalColumns: new Set([RENAMED_VOCAB.complete]),
    });

    expect(resolved.kind).toBe("orphan");
    expect(resolved.kind === "orphan" ? resolved.reason : null).toBe("task-terminal");
  });

  it("AUDIT — both direct predicate call sites and both production classifier calls receive resolved terminal columns; the unwired helper still does not", async () => {
    /*
    NOT driven: reaching the drain needs the runtime's full dependency set. Asserted against the
    module's SYNTAX and labelled as such.

    FNXC:WorkflowScheduling 2026-07-30-10:15 (PR #2799 review — greptile P2):
    AST, not string splitting. The first version found call sites by splitting on the callee name and
    then reasoning about the text that followed — whitespace, the next `;`, whether the slice started
    with a parameter name. A formatting-only change to the runtime could fail this suite or, worse,
    silently misclassify a site, which is the failure mode this whole series is about. Matching the
    repo's existing precedent for the same problem (`core/.../sync-workflow-ir-callsite-allowlist.test.ts`),
    the check now parses the module and inspects real call expressions and their argument lists, so
    it depends on the code's structure rather than its layout.

    An alarm in both directions, like #2798's: converting the remaining site fails this case, which
    is the moment to read the three behavioural cases above and update it deliberately.
    */
    const file = join(__dirname, "..", "runtimes", "in-process-runtime.ts");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    /** Every call of `name`, as its argument-expression list. Declarations are not call expressions,
     *  so they are excluded structurally rather than by guessing at their text. */
    function callArguments(name: string): ts.NodeArray<ts.Expression>[] {
      return callSites(name).map((site) => site.args);
    }

    /** Every call of `name` with the name of the top-level function declaration that contains it. */
    function callSites(name: string): Array<{ enclosing: string | undefined; args: ts.NodeArray<ts.Expression> }> {
      const found: Array<{ enclosing: string | undefined; args: ts.NodeArray<ts.Expression> }> = [];
      const visit = (node: ts.Node, enclosing: string | undefined) => {
        const owner = ts.isFunctionDeclaration(node) && node.name ? node.name.text : enclosing;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
          found.push({ enclosing: owner, args: node.arguments });
        }
        ts.forEachChild(node, (child) => visit(child, owner));
      };
      ts.forEachChild(sf, (child) => visit(child, undefined));
      return found;
    }

    /** Does this call pass a resolved terminal-column set? Checked by looking for the property in the
     *  options-object argument, or an identifier of that name, rather than by substring. */
    const passesTerminalColumns = (args: ts.NodeArray<ts.Expression>): boolean =>
      args.some((arg) => {
        if (ts.isObjectLiteralExpression(arg)) {
          return arg.properties.some((prop) => prop.name && ts.isIdentifier(prop.name)
            && prop.name.text === "terminalColumns");
        }
        return ts.isIdentifier(arg) && arg.text === "terminalColumns";
      });

    /*
    FNXC:ConcurrencyAdmission 2026-10-08-09:16:
    The continuation admission provider (`listContinuationAdmissionCandidates`) is the THIRD classifier call site and a production one: every project admission pass consults it.
    It passes terminal columns resolved from the task's own workflow, derived exactly like the drain's (`resolveLifecycleColumns` over the task's resolved IR, through the shared `continuationTerminalColumns` helper, with the same legacy-pair fallback when the workflow cannot be read).
    A legacy-only call here would offer a renamed board's completed card for admission, so the census pins each site by its enclosing function rather than by a bare count: both production sites must pass the resolved set, and only the unwired `selectActionablePlanningContinuations` helper may not.
    The provider's renamed-board behaviour is pinned in `continuation-admission-provider.test.ts`.
    */
    const classifierSites = callSites("resolvePlanningContinuationCandidate");
    expect(classifierSites).toHaveLength(3);
    expect(Object.fromEntries(classifierSites.map((site) => [site.enclosing, passesTerminalColumns(site.args)]))).toEqual({
      drainDuePlanningContinuations: true,
      listContinuationAdmissionCandidates: true,
      selectActionablePlanningContinuations: false,
    });

    /*
    FNXC:WorkflowScheduling 2026-10-04-15:18:
    Both direct predicate call sites receive terminal columns resolved from the live workflow.
    The separate classifier census above deliberately retains the remaining unthreaded drain call.
    A legacy-only predicate call would make a renamed completed lane dispatchable again, so retain
    this structural census alongside the live behavioral cases.

    FNXC:WorkflowScheduling 2026-10-08-13:51:
    Correction to the note above: the drain is threaded, not unthreaded.
    The classifier census pins three sites by enclosing function: `drainDuePlanningContinuations` and the continuation admission provider `listContinuationAdmissionCandidates` (added in 628231a55) both pass resolved terminal columns.
    The only unthreaded classifier call is the unwired `selectActionablePlanningContinuations` helper, which is what CONTROL and CHARACTERIZATION exercise.
    */
    const innerCalls = callArguments("isPlanningContinuationTaskDispatchable");
    expect(innerCalls).toHaveLength(2);
    expect(innerCalls.every((args) => args.length === 2)).toBe(true);
  });
});
