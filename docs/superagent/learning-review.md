# Super-agent learning, review, release verify, and weekly sweep

Optional, **off by default**. The Superagent constructor never reads
environment variables. The host passes `learning`, `peerReview`,
`releaseVerify`, and `sweep` on `SuperagentOptions` when it wants those
features.

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

The reviewer runs in an isolated read-only contract:

- It may read the **diff** and the **repo** only.
- `REVIEW_CAPABILITIES` forces `write: false`, `network: false`,
  `secrets: false`.
- Superagent never copies `process.env`. The host may pass a
  `reviewEnv` bag; `sealReviewEnv` strips secret-shaped keys
  (`API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, …) before
  `client.complete` sees them. Tests assert those keys do not reach
  `FakePeerReviewClient`.

The prompt asks only for problems that would actually break
production: correctness, security, data loss, or regressions. Style,
naming, formatting, comments, and nits are forbidden. `parsePeerReview`
keeps the raw model text (a `nit` finding stays `advise` at parse
time). `runPeerReview` then discards style-only findings; a
style-only `block` / `advise` is downgraded to `clear`.

- Reviewer model must differ from the worker model. Same model → skip
  (allow push, audit `peer_review_skipped`).
- Findings are `block` or `advise` (or `clear`).
- `block` returns to the worker to fix. After more than `maxRounds`
  (default **3**) blocking rounds, the worker waits on a human
  (`waiting.kind = human`).
- Blocking findings are also written to the mistake book.
- Review tokens / USD / wall time are appended to the usage ledger the
  same way handler usage is. The audit row also records duration,
  review-token share of the task, issues reported, and issues fixed
  before merge (`worker.peerReviewStats`).

Tests use `FakePeerReviewClient`. No live API.

## 3. Post-deploy verify

After a worker's Done claim is verified (PR merged and/or package
published), Super-agent can probe a configurable live version
endpoint (for example `GET /version` returning a commit SHA).

- Default **off**. Missing `versionUrl` or `probe` → skip, retire as
  usual, and write the reason on `worker.progress.lastActivity`
  (`release-verify skipped: no version endpoint`). When the flag is
  off, the skip is silent so existing Done tests stay the same.
- When enabled, Super-agent waits (poll + timeout, both host-tunable)
  then checks that the live SHA contains the merge commit
  (`liveContainsCommit` accepts a prefix).
- Confirmed → retire, audit `release_verify`, charge probe wall time
  to the ledger, note progress.
- Timeout or SHA mismatch → do **not** mark Done. The worker is
  `stuck`, a T33 stuck card is raised, and the watchdog / host
  escalate path takes over.
- Conversation / file Done claims with no merge or publish signal are
  skipped (`no release to verify`).

Tests use `FakeVersionProbe`. No live HTTP.

## 4. Weekly sweep

An optional scheduled cleanup. Default **off**. Timer ingest stays
unowned (`subject: null`); the host calls `Superagent.runSweep(tenantId)`
when a weekly timer fires.

`analyzeSweep` looks at this week's merged commits for:

- duplicate implementations (same basename or same function name)
- temporary patches (`HACK` / `FIXME` / `TEMP` / workaround)
- leftover dead code (`.bak` / `.old` / `deprecated/` / `// unused`)
- diary-style docs (`today i` / `wip notes` / `what i did`)

Findings become one cleanup PR on `maka/sa-sweep-<week>`, base
`main`. File deletes stay on that branch and go through normal review
and CI. Super-agent never pushes `main` / `master` and never merges
the sweep PR itself.

Tests use `FakeSweepSource` + `FakeGitHost`.

## 5. Host wiring

```ts
new Superagent({
  learning: learningSettingsFrom({ enabled: true }), // host only
  peerReview: peerReviewSettingsFrom({
    enabled: true,
    model: 'reviewer-model',
    workerModel: 'worker-model',
    maxRounds: 3,
    client, // injectable; tests pass FakePeerReviewClient
    reviewEnv: { REPO: 'acme/app' }, // optional; secrets are stripped
  }),
  releaseVerify: releaseVerifySettingsFrom({
    enabled: true,
    versionUrl: 'https://app.example/version',
    probe, // injectable; tests pass FakeVersionProbe
  }),
  sweep: sweepSettingsFrom({
    enabled: true,
    source, // FakeSweepSource in tests
    git, // FakeGitHost in tests
    repo: 'acme/app',
  }),
});

await agent.runSweep('tenant', 'acme/app');
```

`startHostSuperagent` already forwards `SuperagentOptions`. This PR
does not change host config, server, deploy, or billing. All flags
stay false until a host passes them.

## 6. What this work does not do

- No sqlite schema / `user_version` change
- No cloud-server migration
- No automatic skill, prompt, or permission edits
- No constructor `process.env` reads
- No live model calls or live version HTTP in tests
- No direct push to trunk from the weekly sweep
