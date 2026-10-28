# PR follow-up: the job ends when the checks have spoken

Before this, a coding task stopped at its pull request: whether CI passed was the owner's to find
out. The only CI follow-up was the opt-in standing-duty triggers (`ci_failed_own_pr`,
`review_comment_own_pr`), with no per-task watch and no bound on fixing. This is the CI half of
T26's Ship ("follow that commit's CI and report; a CI failure on the employee's own PR wakes the
task to fix it once, then escalates"). Merging is not part of it.

## What happens

```
open_pull_request opens a reviewed change
        │  onPublished
        ▼
   ┌──────────┐  green              ┌──────────────────────────────┐
   │ watching │ ──────────────────▶ │ quiet: notice + finished item │
   └────┬─────┘                     └──────────────────────────────┘
        │ red, no fix yet                       ▲ green
        ▼                                       │
   ┌──────────┐  fix verified and reviewed ┌────┴─────┐  red again
   │  fixing  │ ─────── pushed onto ──────▶ │ watching │ ───────────┐
   └────┬─────┘     the same PR branch      │ (round 1)│            │
        │ failed, kept, unreviewed,         └──────────┘            ▼
        │ head moved, push refused                     ┌───────────────────────┐
        └─────────────────────────────────────────────▶│ one "needs you" item   │
                                                       └───────────────────────┘
merged / closed / time limit while watching: quiet notice, done
```

- **Green**: the conversation gets "Checks passed on pull request #N in owner/repo." and the
  inbox a `finished` item (never interrupts). The item names no task, so the task's own result
  card keeps its verdict; the line sits in the chat right under the card.
- **Red, first time**: one fix run of the same task (`ci-fix:<taskId>`, idempotent): a coding
  task in the same conversation, on its root session, with the first task's budget, the same
  repository, test command and first vendor, and `baseRef` set to the pull request's branch. The
  coding runner does to it what it did to the first change: reproduction test, the repository's
  tests, the cross-vendor review and its fix rounds. The brief carries the end of the first
  failing check's log, scrubbed (`scrubbedTail`) and fenced as data.
- **The push**: only a fix whose record says `reviewed` and is not `kept`, whose change still
  hashes as recorded, onto a pull request that is still open and whose head is still the commit
  the fix was made on (`GitHubPublisher.update`, not forced). A retry after the push finds the
  same commit. Anything else is the "needs you" item, and nothing is pushed.
- **Red after the fix, or no fix possible**: one `decision` item on the task, with "Ask the
  agent to fix the checks" (a message into the conversation, built by code) and "I'll take it from
  here". It is never tried again.
- **A check waiting for approval on GitHub** (`action_required`): one `decision` item per head.
- **Stops**: merged or closed (quiet), or after 6 hours of waiting for checks (quiet). A fix run
  still running after 3 hours raises one item; the watch keeps waiting for it.

## How it learns about CI

The state is always read from GitHub with `MAKA_GITHUB_TOKEN` (`GitHubChecks`): the pull request,
then the check runs of its head. A token GitHub refuses check runs to (403) falls back to the
workflow runs of the commit and their jobs. Logs are the Actions job logs. Every 2 minutes; with
the webhook (`MAKA_GITHUB_WEBHOOK_SECRET`) every 10, and each signed `workflow_run` completion of
a registered project wakes the follow-up for that branch at once (`EngineOptions.onWorkflowRun`).
The webhook is a wake-up only, so a lost or reordered delivery changes nothing.

## The inbox

The supervisor's rules were read against this flow:

| Event | Before | Now |
| --- | --- | --- |
| Checks pass | nothing | quiet `finished` item |
| Automatic fix passes | — | quiet `finished` item |
| The fix task ends (either way) | top-level task: independent check (could end "could not check" for budget, an interrupt), `finished`, failed twice | nothing from the supervisor: `followedTask` keeps it to the projection; the follow-up reports |
| The fix task is slow or queued behind the one task per invite | stall item (interrupt) | none; the follow-up raises one item after 3 hours |
| Fix used up, or not possible | — | one `decision` item (interrupt) |
| Approval needed (the PR tool, a check on GitHub) | approval item | unchanged; GitHub's adds one `decision` item |
| A spending limit stops the fix | budget item | unchanged (cap reporter); the follow-up adds its "not pushed" item |

The first task keeps its independent check and its `finished` item as before.

## State and limits

- Watches are one JSON file, `pr-follow-ups.json` in the data directory, in the backup.
- One fix per pull request, ever. One open item per key.
- Nothing merges, and nothing is pushed except the one verified fix, onto the branch the owner
  approved opening.

## Open decisions for the owner

1. **The fix push is not approved card by card.** The owner approved opening the pull request;
   the one fix commit onto its branch goes without a new card, because the point is that nobody
   watches. It is gated on the same checks and cross-vendor review. `MAKA_CLOUD_PR_AUTOFIX=0`
   turns it off (red is then a "needs you" item at once).
2. **The fix run is not a conductor run.** It is started on the conversation's orchestrator
   session, with the first task's budget as its tree cap; it counts against the invite's and the
   server's caps through the gateway, but not against a conductor run budget.
3. **The token's permissions.** Check runs need "Checks: read", which GitHub may not offer
   fine-grained tokens; the fallback needs "Actions: read" (as do logs).
4. **Overlap with the opt-in `ci_failed_own_pr` duty.** A project with that duty on gets both on
   a red `maka/` branch. Turn one off, or decide that the duty stands down for followed PRs.
5. **The inbox words are English only** (no ask template), like the duty notices.
