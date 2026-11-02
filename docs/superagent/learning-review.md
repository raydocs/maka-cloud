# Super-agent learning and cross-model review

Optional, **off by default**. The Superagent constructor never reads
environment variables. The host passes `learning` and `peerReview` on
`SuperagentOptions` when it wants either feature.

This is a small hook on the existing worker loop. Parallel scheduler /
watchdog / BYOM / shared-box work should keep landing without a merge
from this branch.

## 1. Mistake book (lessons)

When a worker's work is bounced, Super-agent records one lesson:

| Bounce | Cause |
|---|---|
| GitHub review `changes_requested` | `review_changes` |
| GitHub review `rejected` / `dismissed`, or a `VERDICT: BLOCK` receipt | `review_rejected` |
| `ci_failed` after this worker pushed, then `ci_passed` | `ci_failed_then_fixed` |
| Owner denies a held action | `approval_denied` |
| Watchdog nudge / escalate / restart / stop | `watchdog_correct` |
| Cross-model review `SEVERITY: block` | `peer_review` |

Each row stores the trigger event id, what went wrong, the correct
approach, and a scope (usually `owner/repo`). Text is scrubbed with
`@maka-cloud/orchestrator` `scrubSecretText` before it is stored. Keys
and tokens do not enter the book.

The book is an in-memory `LessonBook`. Persistence is the existing
append-only **audit** log (`lesson_recorded`, `lesson_proposed`,
`lesson_accepted`, `lesson_rejected`). There is **no sqlite
`user_version` bump**. A new Superagent rebuilds the book from audit.

### Distill and suggestions

`distillLessons(tenantId, repo)` merges similar recorded/accepted rows
into a repo-level markdown document and emits skill / prompt
**suggestions** as unified diffs.

Those diffs are reviewable drafts. `applySkillProposal` always returns
`{ ok: false, reason: 'never_auto_apply' }`. Accepting a proposal marks
it accepted and audits `applied: false`. Super-agent never writes a
skill file, never rewrites a system prompt, and never changes
permissions.

### Injection at spawn

Only **accepted** lessons are injected, and only when a **new** worker
starts. The prefix is append-only:

```
## lessons
- [les_0001] short summary
```

It lives on `worker.lessonPrefix` / `worker.lessonRefs` (worker JSON,
no schema change). `recall()` prepends the prefix to the existing
spill/recall chain. Handler `memory` updates go through
`stripLessonPrefix` so the prefix is not rewritten (Claude cache /
append-only history).

When the prefix would exceed `injectBudget` (default
`INLINE_MEMORY_CHARS`), only the ids stay in the prefix. Full text is
read back with `recallLesson(id)`.

Running workers keep the prefix they were spawned with. A later accept
does not scramble an in-flight prompt.

## 2. Cross-model review

Before `CodingLoopHandler` pushes or opens a PR, if the host enabled
peer review, the worker calls `ctx.peerReview({ diff })`.

- Reviewer model must differ from the worker model. Same model → skip
  (allow push, audit `peer_review_skipped`).
- Findings are `block` or `advise` (or `clear`).
- `block` returns to the worker to fix. After more than `maxRounds`
  (default 2) blocking rounds, the worker waits on a human
  (`waiting.kind = human`).
- Blocking findings are also written to the mistake book.
- Review tokens / USD are appended to the usage ledger the same way
  handler usage is.

Tests use `FakePeerReviewClient`. No live API.

## 3. Host wiring

```ts
new Superagent({
  learning: learningSettingsFrom({ enabled: true }), // host only
  peerReview: peerReviewSettingsFrom({
    enabled: true,
    model: 'reviewer-model',
    workerModel: 'worker-model',
    maxRounds: 2,
    client, // injectable; tests pass FakePeerReviewClient
  }),
});
```

`startHostSuperagent` already forwards `SuperagentOptions`. This PR
does not change host config, server, deploy, or billing. Both flags
stay false until a host passes them.

## 4. What this PR does not do

- No sqlite schema / `user_version` change
- No cloud-server migration
- No automatic skill, prompt, or permission edits
- No constructor `process.env` reads
- No live model calls in tests
