---
title: "GitHub stops creating Actions runs on a fork after heavy usage, while every settings API reads healthy"
date: "2026-10-11"
category: integration-issues
module: ".github/workflows (Full Suite, PR Checks) + post-merge-verification gate"
problem_type: integration_issue
component: tooling
symptoms:
  - "No GitHub Actions run of any workflow is created for pushes to main or for pull requests on the fork"
  - "A landed commit has check suites from other apps but no github-actions check suite"
  - "Post-merge verification waits indefinitely with run-not-started because no Full Suite run exists at or after the landed SHA"
root_cause: config_error
resolution_type: config_change
severity: high
last_updated: "2026-10-11"
related_components:
  - development_workflow
  - testing_framework
tags:
  - github-actions
  - fork
  - usage-limit
  - full-suite
  - post-merge-verification
  - ci-evidence
---

# GitHub stops creating Actions runs on a fork after heavy usage

## Symptom

The newest run on `stjepanvrbic/Fusion` was Full Suite #142 (run 37832714652, push of `28e7c1244`, created 2026-10-08T19:32:27Z). From then on, pushes to `main` and pull requests created no run of any workflow. Every card that landed afterwards sat in post-merge verification with `run-not-started`, because the gate needs the first Full Suite push-to-main run at or after the landed SHA (see [Required post-landing Full Suite evidence](../../testing.md#required-post-landing-full-suite-evidence)).

Reproduction:

```bash
gh api 'repos/stjepanvrbic/Fusion/actions/runs?created=>2026-10-08T19:33:00Z&per_page=5' --jq .total_count
# 0
gh api repos/stjepanvrbic/Fusion/commits/<landed-sha>/check-suites --jq '[.check_suites[].app.slug]'
# sonarqubecloud, claude, devin-ai-integration, mastra-platform; no "github-actions"
```

The `github-actions` check suite is the one the Actions app creates when a workflow is triggered. Other apps still created suites for the same commits, so GitHub received the pushes and the Actions app created nothing.

## Diagnosis

The logged-in `gh` token (scopes `repo`, `workflow`) can read repository Actions settings. Billing reads need the `user` scope. Each read below and what it showed:

| Query | Output | Conclusion |
|---|---|---|
| `gh api repos/<repo>/actions/permissions` | `enabled: true`, `allowed_actions: all` | Actions not disabled in repository settings |
| `gh api repos/<repo>/actions/workflows` | Full Suite, PR Checks and the other workflows that should run are `active` | Workflow state not the cause (the `disabled_manually` release workflows were disabled long before) |
| `gh api repos/<repo>/actions/permissions/workflow` and `.../fork-pr-contributor-approval` | read-only token, `first_time_contributors` | Approval policy does not apply to same-repository PR branches |
| `gh api repos/<repo>` | public, `fork: true`, not archived or disabled | Repository not disabled |
| `gh api 'repos/<repo>/actions/runs?status=queued'` (also `in_progress`, `waiting`, `pending`, `requested`) | 0 each | Runs were never created, not stuck in a queue |
| `git diff --stat <last-run-sha> origin/main -- .github` and a grep of commit bodies for `[skip ci]`-style markers and `skip-checks:` | empty, none | Workflow files and skip markers ruled out |
| `gh api repos/<repo>/events` | PushEvent and PullRequestEvent entries for every unserved push and PR | GitHub received the events |
| `gh api 'repos/<owner>/<private-repo>/actions/runs?per_page=3'` | runs created hours after the outage began | Account restriction and billing lock ruled out: they would stop private-repository runs first |
| `gh api 'repos/<parent>/actions/runs?per_page=3'` | runs created during the outage | No platform-wide failure to create runs |

None of the REST reads explained the outage. The cause was only visible on the repository's Actions page, `https://github.com/<repo>/actions`, which is public and readable without signing in. It showed:

> Workflows are not currently being run on this fork due to the scale of GitHub Actions usage. A repository maintainer can choose to re-enable these.

A `workflow_dispatch` call is the one API request that does expose the state. It fails before creating anything, so it is safe to use for detection:

```bash
gh workflow run verify-elevated-restricted.yml --ref main -R <repo>
# could not create workflow dispatch event: HTTP 422: Actions has been disabled for this repository.
```

The 422 contradicts `actions/permissions` (`enabled: true`). Treat the 422 as authoritative.

The githubstatus.com history page renders its incident list client-side, so a plain HTTP fetch returned no incidents. The page was not usable as evidence either way.

## Root cause

GitHub stopped running workflows on the fork because of its Actions usage. All 406 runs on the fork were created in about 31 hours (2026-10-07T12:52Z to 2026-10-08T19:32Z):

- 142 Full Suite runs, one per landing on `main`, with a per-SHA concurrency group, so no run was ever cancelled by a newer landing.
- 87 runs each of PR Checks, Desktop packaging, and threatcrush on pull requests.
- One Full Suite run took about 352 job-minutes across 20 jobs, about 223 of them on `windows-latest`. That puts the Full Suite load alone on the order of 50,000 job-minutes in 31 hours.

This state is separate from the repository's Actions settings. `actions/permissions` kept reporting `enabled: true` throughout, and only the dispatch 422 and the Actions page banner exposed it.

## Recovery

1. A maintainer signed in to the fork opens `https://github.com/<repo>/actions` and uses the banner's re-enable control. No REST endpoint for this was found, so an agent session cannot do this step. The task records the exact steps in its operator-actions document.
2. Prove that runs are created again with one low-cost dispatch, then check that the run exists. While the fork is disabled, the dispatch returns the 422 above. A successful dispatch response alone is not proof.

   ```bash
   gh workflow run verify-elevated-restricted.yml --ref main -R <repo>
   gh run list -R <repo> --workflow verify-elevated-restricted.yml --limit 3
   ```

3. Cover the gap with a new push to `main`, normally the next Fusion landing. `gh run rerun` re-executes a run at its original SHA, and no run exists for any gap SHA, so a re-run covers nothing. Full Suite has no `workflow_dispatch` trigger, and the gate accepts only a push-to-main run at or after the landed SHA. Every gap commit is an ancestor of the next push, so its Full Suite run is the evidence for all of them.
4. Reduce usage, or expect the limit to trip again. Full Suite runs to completion for every landing, so a burst of landings multiplies Windows minutes. Cancelling superseded `main` runs, batching landings, or moving the Windows lanes to a schedule are the available levers. Each one is a workflow change and needs its own task.

## Gap cards (2026-10-08T19:32Z outage)

Cards and commits that landed after `28e7c1244` and before workflows were re-enabled. Each one needs the first Full Suite push run created after re-enabling.

- Fusion cards in review, waiting on that evidence: KB-096 (`d6b27e143`), KB-057 (`769f91ab8`), KB-097 (`9b9a59b76`), KB-080 (`62be9959e`), KB-076 (`6daac6638`), KB-101 (`b26849240`), KB-095 (`0d5e2feac`), KB-105 (`078f95dd3`), KB-099 (`698665b55`), KB-104 (`7f51dd69a`), KB-106 (`47a16eb95`).
- Operator PRs with no Fusion card: #69 (`84f5dec92`), #70 (`aa7ddae67`), #71 (`db50f0e69`), #72 (`d5b7f7826`), #73 (`5b97f2e6c`), #74 (`2917f8f29`), #75 (`555bb2995`), #76 (`3175b1e2e`), #77 (`0c65a0ba6`), #78 (`46f97bc79`).
- Direct commits with no card: `0f3bdf72f`, `238f99951`, `5b29a8920`.
