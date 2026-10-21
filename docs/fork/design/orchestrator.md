# Orchestrator MCP server (`@maka-cloud/orchestrator`)

Task T2. One small set of orchestration tools for every agent session, the
conductor and the executors it starts. Reference design: T3 Code's
`docs/orchestration-v2/orchestrator-mcp-server.md` (MIT), cut down to the four
tools this product needs.

The package depends only on the MCP server SDK and zod. It has no `@maka/*`
dependency, so upstream changes cannot break it, and T4 hosts it without
pulling in the runtime.

## Tools

| Tool | Behavior |
|---|---|
| `delegate_task {runner, brief, title?, mode?, timeoutMs?, budgetUsd?, idempotencyKey?}` | Writes the brief file, creates a child task, starts the runner. `mode: "async"` (default) returns the task; `"wait"` blocks until it ends or the timeout passes. `budgetUsd` caps the tree (see Budgets). With `idempotencyKey` the task id is derived from the session and the key, so a repeat returns the same task. |
| `task_status {taskId}` | State, progress notes, and the result manifest once finished. |
| `task_wait {taskId, timeoutMs?}` | Blocks until the task ends. Default 60 s, at most 10 min. A timeout returns `waitTimedOut: true` and does not cancel the task. |
| `task_cancel {taskId}` or `{idempotencyKey}` | Cancels the task and every descendant, children first. A task that already ended keeps its state. By key, when no task exists yet, the key is remembered (in memory, last 10k) so a delegation still on its way is refused with `cancelled`, and the result is `{created: false}`. |

Errors are tool results with `isError` and a code: `not_found`,
`invalid_request`, `unknown_runner`, `depth_exceeded`, `unauthorized`,
`quota_exceeded`, `budget_exceeded`, `cancelled`.

## Budgets

A top-level task delegated with `budgetUsd` caps what its whole tree spends;
a child cannot set its own cap. Each runner gets what is left of the cap in
`RunSpec.budgetUsd`, meters its CLI's reported usage, and pushes cumulative
`usage` events. The orchestrator records them as `task_cost` on the top-level
task, in the write chain, and cancels the tree once the total reaches the cap.
The same guards that refuse creates and starts under a stopped ancestor
refuse them in a tree whose recorded spend reached its cap. Views carry
`costUsd`, `budgetUsd` and `budgetExceeded` for the tree.

This is a soft cap: spend is known only as the CLI reports it, so a run can
overshoot by what one model call costs. A hard cap at the model gateway comes
with T17.

## State is a log

`TaskStore` is append-only: `append(event, at)` assigns `seq` 1, 2, 3, ... and
`read(afterSeq?)` returns entries in order. `reduce(events)` is the only code
that computes task state, for live updates and for replay. The first terminal
event for a task wins, so a runner that finishes after a cancel cannot undo it.
The write chain enforces the same rule on the way in: a terminal event for a
task that already ended is dropped before it is appended, so the log holds
exactly one terminal event per task.

`Orchestrator.create` restores from the log. Nothing is running after a
restart, so every task still `queued` or `running` gets an event appended:
`task_failed` ("orphaned"), or `task_cancelled` when a cancel was already
requested. History is never edited. T4 supplies the SQLite `TaskStore`.

### Only unfinished tasks live in memory

The same store answers four synchronous index lookups (`readTask`,
`childrenOf`, `activeTaskIds`, `taskIds`) and one count
(`countCreatedSince`). The index is derived from the log and changes in the
same step as the append. A task leaves the in-memory map on its terminal event,
after its waiters were woken, and is read back from the store when someone asks
for it. A finished task never changes, so the small LRU in front of those reads
(512 entries, 4 MiB by default) needs no invalidation.

- `restore()` loads `activeTaskIds()` only, so a restart does not read the
  finished history. The ids it ended are in `orphanedTaskIds`.
- Anything that needs "has this ended?" treats "not in memory" as ended: a
  delegate under an ended ancestor is refused, a wait on a finished task
  returns at once, and `task_cancel` and the cascade walk `childrenOf` through
  ended tasks to reach running descendants.
- The lookups are synchronous because an indexed point read in an embedded
  database is, and `status` must stay synchronous.

Each task also has an epoch (1 from creation, raised by `task_attempt`) and a step log (`step_intent`, `step_outcome`,
`step_interrupted`); the store refuses a write fenced with an older epoch. See `durable-tasks.md`.

## Sessions and tokens

Each agent session holds a bearer token. The server keeps only its SHA-256 and
never writes it to the log. A session sees a task if it created it or an
ancestor of it, so a parent sees its whole subtree, and a child sees only what
it started. An id outside that scope returns the same `not_found` as an id that
does not exist.

When a task starts, the orchestrator issues an executor session for it and
passes `{url, token}` to the runner in `RunSpec.mcp`. Tasks that executor
delegates become its children. The session is revoked when the task ends.

Digests live in a `SessionStore` (memory by default; T4 supplies a SQLite one),
so a token survives a restart. A token reads `mko_<sessionId>.<secret>`; the id
picks the entry and the digest is compared with `timingSafeEqual`. A small LRU
sits in front of the store, and every revoke, rotate and task end evicts first,
so a cached entry cannot outlive a revocation. `rotateSession(sessionId)`
replaces the secret for a holder that lost its token; the session keeps its id,
so it still sees its tasks. After a restart, `restore()` revokes the sessions a
durable store still holds for the tasks it just ended.

## Handoff

Per task, under `handoffRoot/<taskId>/`: `brief.md` (written before the runner
starts, 256 KiB at most) and `result.json`, which the runner writes before it
reports `finished`. The manifest is `{summary, done[], notDone[], confidence,
knownIssues[], artifacts?}`, validated with zod. A missing, oversized or
invalid manifest fails the task with the reason. No transcript crosses a task
boundary.

The orchestrator creates each task dir itself, mode 0700, and refuses a path
that already exists, so it never writes through a symlink someone left there.
`O_NOFOLLOW` only covers the last component of `result.json`, so before reading
it the orchestrator also `lstat`s the task dir (it must be a real directory)
and checks that its `realpath` is `<realpath(root)>/<taskId>`. A check followed
by an open leaves a race. It is acceptable because runners never get write
access to the handoff root (T6 rule), so nothing running inside a task can swap
the directory; the checks are a second layer, not the access control. A runner
that runs as another user needs a task dir it can write `result.json` into,
which is T6's to arrange without giving it the root.

## Runners

`Runner.start(spec)` returns a `RunHandle` with an `events` stream (`progress`,
`finished`, `failed`) and `cancel()`. A stream that ends without `finished` or
`failed` fails the task. Once a cancel is requested, whatever the runner does
next is ignored. A handle that is still registered when its task ends (the
stream broke or ended without a result, or the runner came up late) is
cancelled, best effort, and a cancel that throws, even synchronously, does not
interrupt the rest of the cleanup; a runner that reported `finished` or
`failed` is not cancelled. `FakeRunner` is scriptable for tests. `claudeAgentSdkRunner`
and `codexRunner` are stubs that fail the task with "not implemented yet"; T6
replaces them.

## Cancel

`task_cancel` first records a cancel request on every live task in the subtree,
which stops any of them from delegating further, then cancels runners deepest
first and records `task_cancelled`. It repeats until nothing in the subtree is
live. A runner whose `cancel()` throws is still recorded as cancelled, with the
error kept as a progress note.

- **Session.** The caller's session is checked where the first cancel request
  is accepted in the write chain, so a token revoked while the call was queued
  changes nothing. Once accepted, the cleanup runs to the end on its own.
- **Concurrent cancels.** Cancels of one task share a single in-flight cancel,
  and a request for a task that is already stopping is not logged again.
- **Start in flight.** While `Runner.start` is pending there is no handle to
  stop. When it returns, a task that is stopping (cancel requested, ended, or an
  ancestor stopping) gets the new handle cancelled and is never recorded as
  started. `task_started` goes through the same check in the write chain.

## Pause and resume

A task is `paused` between `task_paused` and `task_resumed`. Events:
`task_pause_requested{by}`, `task_paused`, `task_pause_failed{reason}` and the
same three for resume. `RunHandle.pause()` and `resume()` are optional; a run
without them answers `unsupported` and nothing is recorded. A paused task is
unfinished: it holds its slots and counts against the quotas, and a restart ends
it as an orphan like a running one. `cancel` works on a paused task and wins over
any pause or resume that is still under way.

- **Check-then-act.** Authorization, visibility, "still running", "not already
  asked" and "the run has a handle" are one guard inside the write chain, in
  front of `task_pause_requested`. Asking twice records one request.
- **Runner call.** It happens after the request is recorded, with a timeout
  (`controlTimeoutMs`, 15 s). A throw or a timeout records `*_failed`, so the task
  reads as it did before, and can be asked again. A pause that fails or times out
  is undone with `resume()` (when the runner answers late, as soon as it does),
  so a run never stays held while the task says it runs. That late undo is not
  tracked by `settled()`: a runner that never answers must not hold up shutdown.
- **Racing a cancel.** `task_paused` and `task_resumed` are guarded by "the task
  is not stopping", so a cancel that landed first leaves the task cancelled.

`cancelAs`, `pauseAs` and `resumeAs` take an `OperatorAccess` instead of a
session: the server's public API acts for the root session of a conversation after
checking the user's invite. `authorize()` runs in the write chain with the other
guards, so an invite revoked while the request waits changes nothing. The
operator sees the tree its conversation session started and nothing else.

## Ending a task ends what is below it

When any task ends, whether `succeeded`, `failed` or `cancelled`, the
orchestrator cancels its non-terminal descendants the same way `task_cancel`
does (requests recorded as `by: "system"`, deepest first). A parent that
reports `finished` while a child is still running does not leave the child
behind. Delegation is refused under an ended or cancelling ancestor, and the
ancestors are checked again where a started runner is handed off, so a child
whose start was pending when its ancestor ended never runs. A restart appends
outcomes for everything still live and does not cascade.

`Orchestrator.settled()` resolves once the runner starts and cascades under way
have been handed off. It does not wait for running tasks.

## Transport

Streamable HTTP, stateless: each request is authenticated, then served by a
fresh MCP server bound to that session. Missing, unknown or revoked tokens get
401 before any MCP handling. Bodies over 320 KiB get 413.

## Quotas

One `QuotaLimits` object, all values configurable; exceeding one is
`quota_exceeded` (HTTP 429 with `Retry-After` at the MCP endpoint) and records
nothing.

| Quota | Counted per | Default |
|---|---|---|
| Unfinished tasks | the tree, keyed by the conductor session that started it | 32 |
| Tasks created | the same tree, rolling window | 200 per hour |
| Blocking waits (`task_wait`, wait-mode `delegate_task`) | session | 8 (executor 2) |
| Open MCP connections | session | 8 (executor 2) |
| Open MCP connections | whole server | 256 |

The task limits are checked once early, to fail before a brief is written, and
again inside the write chain right before `task_created` is appended. Counting
and appending are one step of the chain, so concurrent delegates at limit - 1
create exactly one task. A wait that finds the task already ended takes no slot.
Counters delete a key when it returns to zero.

## Limits and choices

- Delegation depth is capped (`maxDepth`, default 5) so a runaway agent cannot
  recurse without bound.
- `task_wait` cannot hold a request longer than 10 minutes.
- Not here: real runners (T6), SQLite store and hosting (T4), the conductor
  (T5), and T3 Code's thread-management tools.

## Backlog

Known gaps, deliberately not fixed yet.

- **Token rotation.** Rotating a session token does not invalidate a request
  already authenticated with the old one. Bind a credential generation to the
  auth context and check it where a tool runs.
- **Subtree walk.** `activeSubtree` follows the store's child index, so its
  cost grows with a tree's total history, not with its active tasks. It needs
  an index of active branches.
- **Archive test.** `archive.test.ts` ("a cached finished task is never served
  after the store says otherwise") does not check the underlying log, so it
  cannot tell a dropped late event from one that was never sent.
- **Missing test.** Handle registered, `task_started` still queued, an ancestor
  ends: not covered yet.
