# Fork task briefs

Batch 1 (T1–T3) is the foundation; batches 2–4 below build on it in order.
A task lists the tasks it depends on; start it only after those are merged.

Each task runs in its own agent session (an Amp thread or a Claude Code cloud
session) on its own branch, and ends with a PR against main. Start a session
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

---

# Batch 2: first usable version

Goal: the user types one sentence in the web app and gets a checked research
report or a pull request back. Every task below keeps the batch 1 rules: fakes
in tests, live modes gated behind env vars that you never set.

## T4: cloud server

Depends on: T2.

- Package: `packages/cloud-server` (`@maka-cloud/server`).
- HTTP API: create a conversation, post a user message, list tasks, and an SSE
  stream of conversation and task events with resume from the last event id.
- Hosts the T2 orchestrator MCP server and persists its `TaskStore` with a
  SQLite implementation (append-only event log, replay on start).
- Auth for now: single tenant, invite tokens checked on every route.
  Accounts come in T17.
- First write a short design note in `docs/fork/design/cloud-server.md`: how
  the server embeds the Maka runtime (look at `packages/runtime-host` before
  writing new hosting code) and why.
- Check: package typecheck and tests, including SSE resume and replay after a
  restart.

## T5: conductor

Depends on: T2, T3 (read its findings first), T4.

- Package: `packages/cloud-conductor`.
- A Maka runtime agent on Claude Opus 5.5 that turns one user message into a
  playbook run: classify intent, pick a playbook (research, coding, or free
  plan for the long tail), delegate through the T2 tools, verify, deliver.
- Model access by API key with a configurable base URL, so it can go through
  the model gateway. Effort `medium` by default, `high` for planning.
- Tools besides T2's: `ask_user` (structured question with options and a
  recommended answer; ask only for taste, budget overruns or irreversible
  actions) and `notify`.
- Every task has a dollar budget; the conductor stops and asks when a step
  would exceed it.
- History is append-only (apply what T3 found).
- Tests: a scripted fake model that checks routing, budget stops, and that
  `ask_user` is used only in the three allowed cases.

## T6: real runners

Depends on: T1, T2.

- Package: `packages/cloud-runners`.
- `Runner` implementations for the Claude Agent SDK and Codex, running inside
  an instabox sandbox: install the CLI in the sandbox image or setup step,
  inject the T2 MCP server with a session-scoped token, point the model base
  URL at the gateway with a per-task key, snapshot after each turn, resume by
  session id.
- Never offer or use a claude.ai or ChatGPT subscription login; API keys only.
- Tests with fake sandbox and fake CLIs; a live smoke test gated on
  `INSTABOX_API_KEY`, `ANTHROPIC_API_KEY` and `MAKA_CLOUD_LIVE=1`.

## T7: research playbook

Depends on: T5.

- Package: `packages/cloud-playbooks` (`research/`).
- Steps: plan questions, search and fetch, draft, then verify every citation:
  each claim is checked against the fetched source text, and unsupported claims
  are fixed or removed. Optionally a reviewer on another vendor's model.
- Output: a report artifact (Markdown and HTML) with its sources and a
  manifest of what was and was not verified.
- Tests: fixture pages and claims; unit tests for the citation checker,
  including a claim the source does not support.

## T8: coding playbook

Depends on: T5, T6.

- Package: `packages/cloud-playbooks` (`coding/`).
- Steps: plan, implement with one runner, run the repo's tests and the
  agent's own reproduction test, and deliver a PR.
- Escalation: after two failed test runs or a loop (the same file edited many
  times without progress), write `failure_brief.json` and hand the task to the
  other vendor's runner once. No blind best-of-N.
- Never read or use a benchmark's hidden tests.
- Tests with fake runners and a fake GitHub API.

## T9: web app

Depends on: T4.

- Package: `packages/cloud-web`. React, reusing `packages/ui` components where
  they fit.
- One conversation view: messages, a live task tree with the current step,
  artifacts (report, diff, PR link), `ask_user` cards with the recommended
  option first, pause and cancel on running tasks, and the task's cost so far.
- Web push when a background task finishes.
- Never show model or vendor names to the user.
- Tests: component tests and Playwright against a mocked T4 API, including a
  phone-width layout.

## T10: benchmark harness

Depends on: T6, T8.

- Package: `packages/cloud-evals`. Build on `packages/eval` (it already has a
  Harbor-based harness) instead of a new runner.
- Subjects: Claude Agent SDK alone, Codex alone, and our coding playbook.
  Suites: a 50-task SWE-bench Verified subset and a Terminal-Bench subset.
- Output: per-task cost and resolve rate, and a cost-versus-resolve-rate chart
  (Pareto curve) for the three subjects.
- Hidden tests only grade; agents never see them.
- Dry-run with a fake subject. Live runs need an approved budget; do not run.

## T20: supervisor and "needs you" inbox

Depends on: T4, T5.

Why: a user running dozens of agent sessions cannot watch them all, and an
agent's own report of success is not proof. A supervisor watches every
conversation, checks results independently, and asks the human only when it
matters. Pulled forward from batch 4 because users ask for it first.

- Package: `packages/cloud-supervisor`. It runs beside the conductor, not
  inside it, and reads the T4 event stream for all of the user's
  conversations and tasks.
- Attention items: kind (decision, approval, blocked, verification failed,
  budget, finished), the conversation and task, a one-line ask, options with
  the recommended one first, and evidence links (manifest, test output, PR,
  citations).
- Escalation policy, deterministic rules first: interrupt the human for a
  conductor `ask_user`, a step that would exceed its budget, an irreversible
  action waiting, the same step failing twice, a failed verification, a task
  with no progress for a configurable time, or a manifest with low confidence.
  Everything else goes into a digest. A model (Claude Haiku 5.5) may only
  summarize and rank items; it never decides to skip a rule.
- Independent verification: when a task ends, check the manifest's claims
  against the evidence (tests and CI for code, every citation for research)
  with a model other than the one that did the work. A mismatch becomes a
  "verification failed" item instead of a finished one.
- Delivery: interrupts at once (through the conductor's `notify`, and web push
  once T9 has it); the digest on a schedule or on request. Noise limits:
  one open item per task and kind, an hourly cap on interrupts, quiet hours,
  and per-kind mute.
- Answers: approve, reject or a free-text reply goes back to the right
  conversation exactly once (idempotent). Each item stores a precondition hash
  of the state it was based on; if the state changed, refresh the item instead
  of acting (same rule as T16).
- API on the T4 server: list items, answer an item, mute a kind, and an SSE
  event for new items. If T9 is merged, add an inbox view to `cloud-web`;
  otherwise ship the API only and note the view as a follow-up.
- Tests with fake event streams and a scripted fake model: every escalation
  rule fires and nothing else interrupts; duplicates are suppressed; the
  hourly cap and quiet hours hold; an answer reaches its conversation exactly
  once; a stale item refreshes; a manifest that claims passing tests while
  the evidence shows failures becomes "verification failed".
- Check: package typecheck and tests, plus the T4 server tests for the new
  routes.

---

# Batch 3: personal assistant feel

## T11: memory

Depends on: T5, T9.

- Package: `packages/cloud-memory`.
- A user profile of facts the user can see, edit and delete in the web app,
  plus short summaries of past tasks.
- Memory reaches the conductor as appended context at a stable position, never
  by rewriting the system prompt or earlier turns (keeps the cache and
  preserved thinking).
- Tests: retrieval, edits and deletes take effect on the next turn, and a
  deleted fact never comes back.

## T12: schedules and background work

Depends on: T5, T9.

- Recurring and delayed tasks ("every Monday, summarize X"). Check Maka's
  existing automation scheduler first and reuse it if it fits.
- Each run has a budget, ends with a push notification, and shows in history.
- Tests: schedule parsing, missed runs after downtime, budget stop.

## T13: panels

Depends on: T5, T9.

- Generative UI cards: a JSON schema for a small set of components (table,
  checklist, timeline, comparison, form), a `render_panel` conductor tool that
  validates against it, and a renderer in the web app.
- Invalid panels are rejected with a reason the model can fix, never rendered
  half-broken.
- Tests: schema validation and rendering of each component, phone width
  included.

## T14: cloud computer handoff

Depends on: T1, T9.

- Show the task's sandbox desktop and terminal live in the web app (instabox
  desktop and terminal routes). The user can take over; the agent pauses
  while the user has control and resumes when control is handed back.
- Every handoff is logged.
- Tests with a fake stream; no real sandbox.

## T15: prompt-injection guard

Depends on: T5.

- Content from outside the user (web pages, fetched files, third-party
  messages, tool output from external sources) marks the task context as
  tainted.
- While tainted, tools that write outside the sandbox, send anything, spend
  money or are irreversible require a user approval card. Enforce this in the
  tool gate in code, never by prompt.
- Tests: injection fixtures (hidden instructions in a fetched page) that try
  to trigger each guarded tool, and the clean path that needs no approval.

---

# Batch 4: towards Hark

Gmail is out of scope for now (Google restricted-scope review). Do not add
Gmail scopes.

## T16: proactive suggestion cards

Depends on: T11, T12, T13, T20 (cards reuse its item store, delivery and
noise limits).

- A background job on Claude Haiku 5.5 scans the user's own signals (task
  history, schedules, memory, GitHub notifications through the GitHub App) and
  proposes suggestion cards with one-tap actions that the conductor executes.
- Each card stores a precondition hash of the state it was based on. On tap,
  re-check it; if the state changed, refresh the card instead of acting.
- Track accept and dismiss per card type. After three ignored cards of a type,
  lower its frequency and offer to turn it off. Daily cap on cards.
- Tests: stale-card refresh, backoff, daily cap.

## T17: accounts, limits and cost

Depends on: T4.

- Sign-in (GitHub and Google identity only, no Gmail scopes), per-user plans
  with monthly and per-task spend limits, and a usage ledger fed by the model
  gateway's per-key usage.
- Concurrent tasks reserve budget before each model request and stop at the
  cap mid-stream.
- Write `docs/fork/design/billing.md` first: payment provider and plan shape
  are a product decision; leave the payment integration as an interface.
- Tests: concurrent tasks cannot overrun a budget.

## T18: iOS app

Depends on: T9, T17.

- `packages/cloud-ios`: a SwiftUI shell around the web app in a WKWebView,
  with native sign-in, APNs push and a share-sheet entry that starts a task.
- Signing, App Store Connect and TestFlight are human steps; prepare them and
  list what a person must do.
- Check: the project builds for the simulator in CI on macOS.

## T19: voice

Depends on: T5, T9.

- Talk to the assistant: speech in, the conductor's reply spoken back,
  push-to-talk in the web app (and later iOS).
- Write `docs/fork/design/voice.md` first comparing realtime voice providers
  on latency, price and interruption handling; implement behind an interface.
- Tests with recorded audio fixtures and a fake provider.
