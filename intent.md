# Intent: Linear-backed projects and the Private PR review pipeline

Status: draft for operator review — 2026-10-07. Nothing is implemented until this is approved.

Two independent features, built in parallel:

- **A. Linear** — Linear in the main import surface, and *Linear-backed projects* where Linear is the system of record and Fusion two-way syncs with it.
- **B. Private PR** — agents never post to a public PR. Everything they produce lands in a private, operator-only PR. Only the operator's **Sync** reflects it on the real PR. The same surface becomes the operator's PR workstation (own PRs, teammates' PRs, GitHub and Bitbucket Cloud), plus a parallel upstream-promotion mode for integration-branch projects.

---

## Glossary

| Term | Meaning |
|---|---|
| Linear-backed project | A Fusion project bound to one Linear Project. Linear is the record; Fusion mirrors and executes. |
| Base snapshot | Per synced field, the last value both sides agreed on. The three-way merge reference. |
| Public PR | The real PR on GitHub / Bitbucket Cloud. |
| Private PR | The operator-only overlay on a public PR (which may not exist yet). Agents read and write only here. |
| Staged item | An outbound action held in a Private PR until Sync: push commits, set title/description, post a comment/reply, resolve a thread, submit a review verdict. |
| Private comment | Operator↔agent discussion on a Private PR. Never leaves Fusion. |
| Sync | Operator action that applies all staged items to the public PR. Labelled **Open PR** when no public PR exists. |
| Lane | In integration-branch projects: a branch that becomes exactly one upstream PR. |
| Upstream target | Where PRs are opened: provider + repo + base branch (e.g. `workproj` / `develop`). |
| Head remote | Where PR branches are pushed (e.g. fork `sv_workproj`, or the upstream repo itself). |

---

## A. Linear

### A1. Linear in the main Import view

- Linear becomes a third provider tab in **Import Tasks**, next to GitHub and GitLab, contributed by the existing `fusion-plugin-linear-import` plugin through a new plugin import-provider slot.
- In a non-Linear-backed project, import stays one-shot and read-only towards Linear (today's behaviour, plus duplicate detection).
- In a Linear-backed project the tab pulls an issue from outside the bound Linear Project into it — the issue moves into the bound Project and from then on syncs like any other.
- The standalone "Linear Import" view under *More* is removed once the tab exists.

### A2. Where it lives

- Linear stays plugin-owned (preserves FN-7443): the existing plugin grows into the sync plugin.
- The plugin SDK gains what the sync needs, generically:
  - `onTaskUpdated` / `onTaskDeleted` hooks (today only created/moved/completed exist),
  - an import-provider slot in the Import view,
  - a task-card badge slot,
  - project-scoped secrets access.
- A project cannot be Linear-backed while the plugin is disabled for it. If that happens anyway, the board shows a persistent "Linear sync stopped" banner. It never silently drifts.

### A3. Identity and binding

- Fusion authenticates to Linear as **agent-svrbic**, with a personal API key held in Fusion's encrypted secrets store, project-scoped. The plain-text plugin `apiKey` setting goes away; an existing value is migrated into the secrets store.
- One Fusion project binds to **one Linear Project** inside its team. Today that is team **STJ**. A Linear Project named **Fusion** is created in STJ for this repo.
- Membership:
  - Issues in the bound Linear Project are in sync scope.
  - Moving an issue out of the Project archives the Fusion card. Moving one in creates a card.
  - Polling is filtered by team, so moves out of the Project are seen.

### A4. The sync loop

Every 30 s per Linear-backed project, plus an immediate debounced run after a local change:

1. **Pull.** Fetch issues updated since the cursor (team filter, include archived), ordered by `updatedAt`, paginated.
2. **Merge.** For each issue/card pair, three-way merge per field against the base snapshot (rules below).
3. **Push.** Write Fusion-side changes to Linear. Store Linear's re-read value as the new base, so Linear's markdown normalisation is never mistaken for an edit.

Merge rules:

| Field kind | Fields | Rule |
|---|---|---|
| Scalar | title, priority, state, assignee | Changed on one side only → take it. Changed on both → **Linear wins**. |
| Set | labels | Union of both sides' add/remove deltas. |
| Text | description | diff3 three-way merge. Unmergeable conflict → Linear wins, and the Fusion version is kept as a card note. |
| Comments | — | Append-only both ways, deduplicated by stored remote id. |

Not CRDTs: Linear exposes snapshots and whole-field writes, not CRDT operations. A stored base plus per-field rules gives the same "edit anywhere" outcome without echo loops or interleaved rewrites.

Other loop rules:

- **Crash-safe create.** Fusion generates the Linear issue UUID, persists it locally, then creates. After a crash it checks `issue(id)` before retrying, so there are no duplicates.
- **Rate.** Well inside Linear's 2,500 requests/hour API-key limit. Webhooks are not used: they need a public URL and the daemon is localhost.
- **Visibility.** Sync failures show on the card and in a per-project sync status, and are retried with backoff. A Fusion create never fails because Linear is down; the card shows "not yet in Linear" until it lands.

### A5. Field and state mapping

**Synced:** title, description, priority, labels, state, assignee, comments.

**Fusion-only:** spec (PROMPT.md), steps, logs, worktree, branch, workflow internals.

**Agent comments** on the card appear in Linear as agent-svrbic. The operator's Linear comments reach the agent exactly like card comments.

**State mapping**, by column *role*, not column id, so custom workflows work. Auto-detected from the team's states and editable in project settings.

| Fusion role | Linear state (default) |
|---|---|
| intake | Triage (or Backlog if the team has no Triage) |
| hold | Todo |
| wip | In Progress |
| review | In Review (a `started`-type state) |
| complete | Done |
| — (Linear Canceled) | card archived, running work aborted |

How state changes flow:

- A state change made in Linear is applied as an **operator move**. It may move backward, like any operator move. Moving to In Progress dispatches an agent unless the card is paused.
- Engine moves are pushed to Linear.
- Fusion archive does not change Linear.
- Deleting a card in a Linear-backed project cancels the Linear issue.

**Assignee is an output signal, never a dispatch gate.**
- Fusion assigns agent-svrbic while agents own the work.
- Fusion assigns the operator when it needs them: Private PR ready for review, blocked, failed, or awaiting approval. That puts it in the operator's Linear inbox.

### A6. Links and IDs

- Fusion keeps its own task IDs. The card shows the Linear identifier (e.g. `STJ-123`) prominently.
- Branch names and public PR titles include the Linear identifier, so Linear's GitHub integration auto-links them. Linear's own state automation may stay on; its moves are consistent with Fusion's and are treated like any Linear-side change.
- Fusion attaches every public PR link to the Linear issue itself (`attachmentCreate`, upsert by URL). This is mandatory for Bitbucket, which Linear does not integrate with.

### A7. Enabling and disabling

- **Enable**, via a project settings dialog: choose the API key secret and the Linear Project; review the auto-detected state mapping.
- **Initial reconcile on enable:**
  - open Fusion cards are created in Linear (checkbox, default on);
  - done and archived cards stay local;
  - open Linear issues in the Project are pulled in.
- **Disable** stops syncing and leaves both sides as they are. Links are kept so re-enabling resumes without duplicates.

---

## B. Private PR pipeline

### B1. Merge modes (per project, per-task override)

| Mode | Behaviour |
|---|---|
| `direct` | No PR. The task lands on its target without asking. Target is the default branch (merged locally, optionally pushed) or an **integration branch** (see B7). |
| `pull-request` | Standard: a public PR opens directly, as today. |
| `private-pr` | A Private PR is produced. Nothing public happens until the operator presses Open PR / Sync. |

- **Auto-merge of the public PR** (once approved and green) is a separate per-project switch, off by default. A **Merge** button is always available on the Private PR.
- **Repository setup**, flexible per project and overridable per task:
  - upstream target: provider + repo + base branch;
  - head remote (fork or same repo);
  - branch naming.

  Covers same-repo PRs, fork → upstream PRs (`sv_workproj:branch` → `workproj/develop`), and GitHub or Bitbucket Cloud.

### B2. One gate for public writes

Every write to a PR host goes through one gate. Covered writes:
- branch push,
- PR create and edit,
- comment, reply, resolve,
- review submit,
- merge.

In `private-pr` mode, and for any PR the operator has adopted, the gate **stages** instead of posting. No code path can post around it. That includes today's `pr-respond` reply/resolve loop, PR metadata generation, and branch pushes.

**No AI attribution, anywhere.** Posts go out as the operator's own account (`gh` auth / Bitbucket token). No visible or hidden markers: the existing `<!-- fusion:pr-entity -->` reply marker is removed, and dedupe uses stored remote comment IDs.

### B3. What a Private PR holds

**Head:** the private branch tip. It may be ahead of the public branch.

**Mirror of the public PR:** title, description, comment threads (with authors), review state, checks, merge state. Refreshed by polling.

**Staged items:**

| Staged item | What it contains |
|---|---|
| commits | Commits not yet pushed (diff "since last sync"). |
| title / description | Proposed new values. |
| replies | Draft replies to public threads. |
| comments | New top-level comments. |
| resolves | Thread resolutions. |
| review verdict | Reviewer-role PRs only: approve / request changes. |

The operator can edit or drop any staged item. Agent-drafted and operator-written items are equal; both post as the operator.

**Private review:** inline diff comments and general comments, threaded. Drafts until the operator presses **Send to agent**, like GitHub's "request changes".

### B4. The loop

1. **Task completes** in `private-pr` mode (after the existing code-review gates) → a Private PR is created → one inbox item, and the Linear issue (if Linear-backed) is assigned to the operator.
2. **Operator reviews.**
   - Diff views: full vs base, since last sync, since your last review.
   - The operator can edit staged items, comment privately, reply to teammates, and discuss with the agent in private threads.
3. **Send to agent** → the agent addresses the private comments: code changes, replies in the private threads, updated staged items → the Private PR returns to the inbox.
4. **Open PR / Sync.**
   - Pushes commits, then sets title/description, posts replies/comments, resolves threads.
   - Each item reports success or failure and failed items can be retried.
   - The first Sync opens the public PR (ready by default, "open as draft" toggle).
5. **Teammate activity on the public PR** is mirrored in. The agent automatically drafts replies and code fixes as staged items (configurable). Nothing posts.
6. **Accumulation.** Feedback from teammate A and then teammate B accumulates in the **same** Private PR. The operator sees one inbox item per Private PR ("has updates, needs review"), updated in place and re-marked unread on change, never one item per event.
7. **Merged / closed** public PR → card done / closed; the Linear issue follows.

### B5. PR workstation

The Pull Requests view becomes the Private PR workstation.

**Roles:**
- **Author** — Fusion's own PRs, or PRs the operator opened manually and adopts. The agent may change code. Backed by a board card; in a Linear-backed project that card has a Linear issue.
- **Reviewer** — teammates' PRs. The agent never pushes code. It helps analyse and drafts review comments. Sync submits the operator's review: comments plus verdict. No board card; an agent chat is attached to the PR.

**Discovery:** automatic, for every open PR in the registered projects' repos where the operator is author or requested reviewer, on GitHub and Bitbucket Cloud. Any other PR can be adopted by URL.

**Filters:**
- author,
- repo / project,
- branch,
- provider (GitHub / Bitbucket),
- role (author / reviewer),
- visibility: private-only (not yet public) / public,
- needs-my-review / has unsynced changes.

**Babysitting own PRs:** an adopted author PR gets the same treatment. CI failures and new comments make the agent draft fixes and replies into the Private PR.

### B6. Providers

- **GitHub:** `gh` CLI first, REST/GraphQL fallback (existing client).
- **Bitbucket Cloud:** Atlassian `twg` CLI where it covers the operation, otherwise the Bitbucket Cloud REST 2.0 API, behind the same provider interface. Auth is a scoped Bitbucket API token in the secrets store (app passwords stopped working 2026-07-28).
- **Provider-neutral model:**
  - threads identified by provider thread id (GitHub) or root comment id (Bitbucket);
  - Fusion stores the reviewed commit for every anchor, because Bitbucket Cloud has no outdated flag;
  - review submit is non-atomic on Bitbucket, so it is made idempotent.
- **Polling budget:** Bitbucket Cloud allows 1,000 PR-endpoint requests/hour per user, so polling uses filtered, delta (`updated_on`) and `fields=`-trimmed queries.
- **Out of scope:** GitLab MRs, Bitbucket Data Center.

### B7. Integration-branch promotion (parallel upstream PRs)

Goal: agents land fast on an integration branch while upstream review runs **in parallel as much as the code allows**. Fusion automates the manual pattern "carve the independent part out onto its own branch off `develop`, PR it, rebase the integration branch onto it".

**Model.** The model follows GitButler's parallel/stacked branches, with Sapling/jj-style automatic restacking.

- Fusion keeps a **lane forest** over the upstream base `U` (e.g. `workproj/develop`).
  - A **root lane** branches off `U` and becomes its own upstream PR immediately.
  - A **child lane** stacks on the lane it depends on.
- The integration branch `I` is **derived**: `U` plus all lane tips merged, regenerated whenever a lane or `U` changes. Agents keep working on `I`, so they always see everything.
- Fusion's local state need not mirror any remote. Lanes and `I` are local; lane branches are pushed to the head remote only on Sync.

**Placement when a task lands** (automatic, operator can override):
1. **Declared dependencies** — the Fusion task's dependencies.
2. **Textual independence** — does the task's change apply cleanly on `U` alone (`git merge-tree`)? Yes → candidate root lane. No → the lanes it conflicts with are its parents.
3. **Semantic check** — the task's verification runs on `U` + the change alone. This catches "uses a function another lane adds" with no textual overlap. Failure → it stacks behind the lane it most recently depended on in landing order. That fallback is always correct, just less parallel.

The operator can move tasks between lanes, bundle several tasks into one lane (one PR), split lanes, and reorder.

**Opening PRs:**
- **Root lanes** open in parallel. In `private-pr` promotion mode each is a Private PR awaiting Sync.
- **Child lanes:**
  - Fork setups cannot target a parent lane's branch (the base must be in the upstream repo). Children therefore **wait** by default and open the moment their parent merges.
  - Opt-in: open early as a PR to `U` that includes the parent's commits, marked "depends on #N".
  - Same-repo setups may stack natively (base = parent lane branch).
- **A child with several parents** waits for all of them.

**Keeping it consistent:**
- Upstream merges a lane (any merge style, including squash) → children are rebased with `--onto` (dropping the parent's commits) → they become roots → their PRs open or retarget → `I` is regenerated.
- Review fixes on a lane PR go onto the lane branch (via its Private PR) → `I` is regenerated → children are restacked automatically.
- Restack conflicts are resolved by an agent and staged in the affected Private PR. Never pushed unseen.

**Your example.** `develop` = 1,2,3; `I` = 4,5,6,7; a new independent change C1 that `I` needs:
- C1 becomes a root lane off `develop` and its PR opens at once.
- 4,5, if independent of 6,7, get their own root lane — or join C1 if you bundle them.
- 6,7 stack as a child lane.
- `I` = `develop` + all lanes, so it already contains C1.
- Further independent changes C2 and C3 each become another root lane with its own parallel PR.
- When C1 merges upstream, its children restack onto the new `develop` and open.

### B8. Review UI

- **`@pierre/diffs`** (Apache-2.0, React 19), pinned to an exact version:
  - one virtualised scroller for all files,
  - Shiki highlighting in a worker,
  - split / unified views,
  - word-level diff,
  - inline threads rendered as our own React components via line annotations,
  - theming through its CSS variables mapped to Fusion design tokens.
- **`@pierre/trees`** for the file tree. Its reference review app `diffshub` (Apache-2.0) is used as a pattern source.
- **Built by us:** thread storage, multi-line anchors (the library anchors to one line; we store the range), outdated/moved-anchor remapping, and the since-last-sync / since-last-review diffs.

---

## Cross-cutting

- New run-audit events follow the bounded-emit seams, with metadata limited to ids, counts and fixed outcomes. Never comment text, descriptions or tokens.
- Secrets (Linear key, Bitbucket token) live only in the secrets store, never in settings JSON, logs, route responses or task documents.
- Changesets for `@runfusion/fusion` with the required labeled body. FNXC requirement comments as AGENTS.md specifies.
- Tests: test-first, narrow seams, in-memory fakes for the Linear / GitHub / Bitbucket clients. No real network in tests.
- Every behaviour change updates the tests that encoded the old behaviour, in the same change.

## Out of scope (v1)

- Linear webhooks.
- Linear OAuth app / delegate model (agent-svrbic API key instead).
- GitLab MR support in the PR pipeline.
- Bitbucket Data Center.
- Mirroring the Fusion spec into Linear.
- Syncing Linear fields not listed in A5 (estimate, cycle, due date, parent/sub-issues).

## Delivery

Two tracks run in parallel, each in its own worktree with subagents per slice. Each slice lands as a PR to `stjepanvrbic/Fusion`, squash-merged once PR Checks are green. Before restarting the :4050 daemon to deploy a usable slice, I notify the audit session.

| # | Slice | Usable result |
|---|---|---|
| L1 | Plugin SDK: update/delete hooks, import-provider slot, card badge slot, project secrets access | — |
| L2 | Linear tab in Import Tasks | Import from Linear in the main view |
| L3 | Linear-backed binding, initial reconcile, sync loop, state map, assignee signal, comments, crash-safe create | Fusion project bound to Linear Project "Fusion" |
| L4 | Linear UI: settings dialog, card badge, sync status | — |
| P1 | Provider interface + public-write gate + Private PR data model (GitHub) + `private-pr` mode | Tasks stop opening public PRs |
| P2 | Private PR review page (`@pierre/diffs`), private inline comments, Send to agent, inbox item | Review and iterate privately |
| P3 | Sync / Open PR, public mirroring, agent drafting on teammate comments, Merge button, auto-merge switch | Full private → public loop |
| P4 | Workstation: discovery, filters, adopt by URL, reviewer role | All PR review in Fusion |
| P5 | Bitbucket Cloud provider (`twg` + REST) | Work repos |
| P6 | Repository-setup config + integration-branch lane forest and parallel promotion | Fast-lane projects |

## Verified at plan time (not decisions)

- Exact `twg` Bitbucket command coverage for the write operations, which decides `twg` vs REST per operation.
- Linear behaviours not yet confirmed: whether comments bump `updatedAt`, trashed-issue visibility, the error on a duplicate-id create, and markdown normalisation details.
- Whether a plugin may subscribe to store events in `onLoad` safely across hot reloads, or whether the new hooks must be bridged by the host.
