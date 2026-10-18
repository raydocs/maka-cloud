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
| `delegate_task {runner, brief, title?, mode?, timeoutMs?}` | Writes the brief file, creates a child task, starts the runner. `mode: "async"` (default) returns the task; `"wait"` blocks until it ends or the timeout passes. |
| `task_status {taskId}` | State, progress notes, and the result manifest once finished. |
| `task_wait {taskId, timeoutMs?}` | Blocks until the task ends. Default 60 s, at most 10 min. A timeout returns `waitTimedOut: true` and does not cancel the task. |
| `task_cancel {taskId}` | Cancels the task and every descendant, children first. A task that already ended keeps its state. |

Errors are tool results with `isError` and a code: `not_found`,
`invalid_request`, `unknown_runner`, `depth_exceeded`.

## State is a log

`TaskStore` is append-only: `append(event, at)` assigns `seq` 1, 2, 3, ... and
`read(afterSeq?)` returns entries in order. `reduce(events)` is the only code
that computes task state, for live updates and for replay. The first terminal
event for a task wins, so a runner that finishes after a cancel cannot undo it.

`Orchestrator.create` restores from the log. Nothing is running after a
restart, so every task still `queued` or `running` gets an event appended:
`task_failed` ("orphaned"), or `task_cancelled` when a cancel was already
requested. History is never edited. T4 supplies the SQLite `TaskStore`.

## Sessions and tokens

Each agent session holds a bearer token. The server keeps only its SHA-256 and
never writes it to the log. A session sees a task if it created it or an
ancestor of it, so a parent sees its whole subtree, and a child sees only what
it started. An id outside that scope returns the same `not_found` as an id that
does not exist.

When a task starts, the orchestrator issues an executor session for it and
passes `{url, token}` to the runner in `RunSpec.mcp`. Tasks that executor
delegates become its children. The session is revoked when the task ends.

## Handoff

Per task, under `handoffRoot/<taskId>/`: `brief.md` (written before the runner
starts, 256 KiB at most) and `result.json`, which the runner writes before it
reports `finished`. The manifest is `{summary, done[], notDone[], confidence,
knownIssues[], artifacts?}`, validated with zod. A missing, oversized or
invalid manifest fails the task with the reason. No transcript crosses a task
boundary.

## Runners

`Runner.start(spec)` returns a `RunHandle` with an `events` stream (`progress`,
`finished`, `failed`) and `cancel()`. A stream that ends without `finished` or
`failed` fails the task. Once a cancel is requested, whatever the runner does
next is ignored. `FakeRunner` is scriptable for tests. `claudeAgentSdkRunner`
and `codexRunner` are stubs that fail the task with "not implemented yet"; T6
replaces them.

## Cancel

`task_cancel` first records a cancel request on every live task in the subtree,
which stops any of them from delegating further, then cancels runners deepest
first and records `task_cancelled`. It repeats until nothing in the subtree is
live. A runner whose `cancel()` throws is still recorded as cancelled, with the
error kept as a progress note.

## Transport

Streamable HTTP, stateless: each request is authenticated, then served by a
fresh MCP server bound to that session. Missing, unknown or revoked tokens get
401 before any MCP handling. Bodies over 320 KiB get 413.

## Limits and choices

- Delegation depth is capped (`maxDepth`, default 5) so a runaway agent cannot
  recurse without bound.
- `task_wait` cannot hold a request longer than 10 minutes.
- Not here: real runners (T6), SQLite store and hosting (T4), the conductor
  (T5), and T3 Code's thread-management tools.
