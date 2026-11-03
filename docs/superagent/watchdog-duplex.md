# Conversational watchdog and full-duplex workers

Additive on the Super-agent core. The watchdog stays a **timer-driven
control loop** (`Superagent.tick`); the Router is not in that path. The
duplex loop is an optional `WorkerHandler`. Existing drain / coalesce /
RecordingHandler tests keep their old shape.

## Conversational watchdog

The user can query the watchdog like a session, through the existing
progress surface:

- CLI: `npm run status -w @maka-cloud/superagent -- --ask "why is worker wrk_… stuck"`
- CLI commands (explicit only): `--nudge wrk_…`, `--pause`, `--resume`,
  `--cancel`, `--stuck-check`, or `--instruct "cancel wrk_…"`
- HTTP: `GET /v1/superagent/progress?ask=…` (read-only)
- HTTP: `POST /v1/superagent/progress` `{ "ask": "…" }` or `{ "instruct": "…" }`

Answers are assembled from the usage ledger, stored watchdog incidents
(`tick()` findings), worker rows, audits, and the trigger → subject →
worker chain (`evt_…` → `issue:…#N` / `pr:…#N` → `wrk_…`). Every answer
ends with `ids:` and lists those citations.

A cheap model is used only when `MAKA_CLOUD_WATCHDOG_MODEL` is set and a
key is present (`MAKA_CLOUD_WATCHDOG_API_KEY` or the existing judge /
Anthropic keys). Tests and the default path use a deterministic
non-LLM fallback. The model may describe; it cannot take actions.

Safe corrective actions run only on an **instruct** (CLI flag or POST
`instruct`), never on `ask` or a question: `nudge`, `pause`, `resume`,
`cancel` (retire), `stuck-check` (one extra `tick()`). Pause still
requires a verified stop.

## Full-duplex workers

`DuplexLoop` is an async ReAct handler. While `handle()` is mid-run:

1. A later comment / user reply is enqueued as usual.
2. If that worker is already draining, Superagent does **not** start a
   second handle. It writes the progress ack `received, will apply at
   next step` and returns.
3. At the next step boundary the loop `pollInbox()`s, applies events in
   arrival order, and consumes them (`ackInbox` + `seenEventIds`).
4. Cancel / correction events (`user_cancel`, `watchdog_cancel`,
   `user_correct`, or text `cancel` / `correction:`) jump the queue.
   Cancel stops the loop; correction folds in and continues.

Long tools call `FakeSandbox.start()` (or any sandbox with `start()`).
`start()` returns `{ status: 'started', jobId }`. The result is stored
on `sandbox.jobs` and harvested as a later event; the loop does not
block on `exec()`. Tests set `holdStarts` and call `finish(jobId)`.

Idempotency is the event id: consumed inbox rows plus `seenEventIds` on
the worker JSON (no sqlite schema bump). Resume / a new Superagent on
the same store will not re-apply those ids.

## What this does not change

- `tick()` still owns W1–W6. Ask is read-only.
- `coalesceInbox` prefers a preempt event, then `approval_granted`, then
  the latest row. Drain of a sleeping worker is unchanged.
- CodingLoopHandler runs through DuplexLoop (inbox at the step boundary, cancel preempts before the coding step). Pause still refuses until the box is verified stopped.
- No BoxPool / scheduler / prompt-cache work. Those land on other
  branches.
