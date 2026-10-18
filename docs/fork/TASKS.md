# Fork task briefs

Each task runs in its own Claude Code cloud session and branch. Start a session
with: "Do task T<n> from docs/fork/TASKS.md. Follow AGENTS.md." Read AGENTS.md
first; its rules apply to every task.

Product context: a cloud personal agent. The user states a goal; a conductor
(Maka runtime, Claude Opus 5.5) plans it and delegates work to native agent
harnesses (Claude Agent SDK, Codex) running in instabox cloud sandboxes, with
automatic verification of every step. The first deliverables are heavy tasks:
coding (delivered as a PR) and deep research (every citation checked).

Rules for all tasks:

- No live model or sandbox calls and no spend. Tests use fakes. A live smoke
  test may exist, but it must skip unless its env vars are set, and you must
  not set them or run it live.
- New code goes in the package the task names. Any upstream file you have to
  touch (for example the root `package.json` workspaces list) is a minimal
  change recorded in the AGENTS.md fork delta table.
- Done means: the task's check command passes, the full CI planner tests pass
  (`node --test --test-concurrency=1 scripts/ci-test-plan.test.mjs scripts/ci-workflow-policy.test.mjs`),
  and the PR description lists what was verified and what was not.

## T1: instabox workspace executor

Objective: let Maka's built-in tools (bash, read, write, edit, glob, grep) run
inside an instabox sandbox instead of on the host.

- Package: `packages/cloud-instabox` (npm name `@maka-cloud/instabox`).
- Implement the `WorkspaceExecutor` interface from
  `packages/runtime/src/workspace-executor.ts` (interface near the
  `export interface WorkspaceExecutor` line; the local implementation in the
  same file is the reference for semantics such as path containment, bounded
  output and timeouts). Find how `builtin-tools.ts` takes `options.executor`
  and wire nothing else.
- instabox API: `https://api.instabox.sh/v1/openapi.json` (public, no auth).
  Key facts: `POST /v1/machines/{id}/exec` runs `bash -lc` and returns
  collected output, not a stream; long or interactive work goes over SSH
  (`POST /v1/machines/{id}/ssh-tokens`). Mutating calls need an
  `Idempotency-Key`. Sandbox changes are async operations polled at
  `GET /v1/operations/{id}?wait=25s`. A paused sandbox resumes on exec.
  Auth: `X-API-Key: ibk_...` from `INSTABOX_API_KEY`.
- Report `WorkspaceExecutorFacts` honestly for a remote sandbox (isolation,
  write-back, network, secrets).
- Tests: a fake instabox HTTP server covering exec, file read and write,
  operation polling, idempotency-key reuse on retry, timeouts, and the error
  envelope `{"error": {"code", "message", "requestId", "retryable"}}`.
- Check: `npm run typecheck -w @maka-cloud/instabox` and the package's tests.

## T2: orchestrator MCP server

Objective: give every agent session (conductor and executors) the same small
set of orchestration tools, the way T3 Code and Amp inject theirs.

- Package: `packages/cloud-orchestrator` (npm name `@maka-cloud/orchestrator`).
- An MCP server over streamable HTTP with four tools: `delegate_task`
  (start a child task on a named runner with a brief; `mode: async | wait`),
  `task_status`, `task_wait` (block until done or a timeout), `task_cancel`.
- Each session gets its own bearer token scoped to the tasks it created and
  their children; a token never sees another session's tasks.
- A `Runner` interface (start, events, cancel) with a fake runner for tests.
  The real runners (Claude Agent SDK, Codex) come later; leave typed stubs.
- Task state is an append-only event log behind a `TaskStore` interface with an
  in-memory implementation. Restarting the server from the log restores every
  task's state.
- Handoff between tasks is a brief file plus a result manifest (what was done,
  what was not, confidence, known issues), never a chat transcript.
- Reference design: T3 Code `docs/orchestration-v2/orchestrator-mcp-server.md`
  at https://github.com/pingdotgg/t3code (MIT).
- Check: `npm run typecheck -w @maka-cloud/orchestrator` and the package's
  tests, including token scoping, cancel propagation to children, and replay
  from the log.

## T3: conductor history-integrity check

Objective: prove, before we spend money, whether Maka's model path keeps
Claude conversation history append-only. Claude Opus 5.5 checks preserved
thinking against the history; any rewrite drops reasoning and cache.

- Package: `packages/cloud-conductor-checks`.
- Drive a 30-turn, tool-using conversation through Maka's runtime and model
  adapter (`packages/runtime/src/model-factory.ts`, `model-adapter.ts`) against
  a fake Anthropic Messages endpoint that records every request body.
- Assert, for each turn after the first: the previous request's `messages`
  are a byte-identical prefix of the next one, thinking blocks and their
  signatures come back unchanged, and cache breakpoints stay on stable
  positions. Run it with and without Maka's history pruning and compaction
  enabled, and report which settings break the prefix and where.
- Add a live mode for later (real Opus 5.5, reports `cache_read_input_tokens`
  per turn and any 400) that runs only when `ANTHROPIC_API_KEY` and
  `MAKA_CLOUD_LIVE=1` are both set. Do not run it.
- Check: the package's tests. The PR description must state which pruning or
  compaction paths, if any, break the prefix, with file:line.
