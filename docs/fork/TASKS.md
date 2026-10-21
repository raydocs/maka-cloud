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

Product direction (2026-10-20): an AI employee for software work, starting
with coding: a programmer's assistant, not an email or errands assistant. No
Gmail or mail integration; research stays as support for coding work.
Users want someone they hand work to, not a tool they have to
drive. Amp's harness and Puck still wait to be dispatched ("promising to keep
an eye on it alone does nothing"), and Hark is proactive and simple but does
not code. We combine the two:

- Employee: given a goal once, it plans, does, verifies and delivers on its
  own; it owns standing duties on each project and wakes on events and
  schedules to do them; it stays inside a budget and an authority level the
  user set; it interrupts only for real decisions; it reports in a short
  brief.
- Harness, learned from Amp: the user picks a mode, never a model; each mode
  maps roles (conductor, implementer, reviewer, helpers) to models, and the
  reviewer is always another vendor than the implementer; cheap models do
  search, summaries and titles; sandboxes sleep when idle and wake on the next
  message; delivery is one "Ship" action.
- Interface, learned from Hark: four places only (Home, Chat, Projects,
  Settings); Home leads with verb-first one-tap cards ("Merge PR #12"); one
  chat with the employee; a project shows its duties and every task in
  detail (plan, steps, diff, tests, review, cost); minimal and phone first.

Order after batch 2: T21 and T22 (internal beta), then T15, T23, T24, T25,
T28, T26, T27, T14b, then T11 and T14, then T13 and batch 4. T12 and T16 are folded into
T23 and T24.

Borrow before building (2026-10-20). The owner wants to start testing as
soon as possible, so a task takes a working piece from these projects before
writing its own. Copy only from the licences listed, keep the original
licence header and add the source to `docs/fork/THIRD_PARTY.md` (Apache-2.0
code also needs its NOTICE). Say in the PR what was taken and from where.

| Source | Licence | Take | For |
|---|---|---|---|
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Anthropic terms | `query()` with `spawnClaudeCodeProcess` (run the unmodified `claude` binary on the box over our exec channel), `sessionStore` (the transcript mirror), hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) for the step log, streaming input for steering | T28, T27 |
| Codex app-server (`codex app-server`, JSON-RPC) | Apache-2.0 | `thread/start`, `thread/resume` by id, `thread/inject_items` for cut-off calls, dynamic tools, `chatgptAuthTokens` | T27, T28 |
| vercel-labs/durable-harness | Apache-2.0 | step log and fencing design; `harness-process/src/tail.ts` (file tail), `recovery.ts` (recovery note), `harness-claude-code/src/env.ts` and `spawn.ts` (env allowlist, path rewrite of mirrored lines, upload of `projects/**` only), `harness-codex/src/config.ts` (gateway provider, `shell_environment_policy` excluding token variables), `rollout.ts` (rollout path checks); `sandbox-host/src/wake.ts` (wake probe), `harness-sandbox/src/base.ts` (base snapshot keyed by recipe hash), `cleanup.ts` (idle cleanup), `relay/relay.ts` (fence kept on the box); `cli-check/src/known.ts` and `scenarios/` (known gaps as expected failures, the kill-inside-a-`never`-step drill, the scripted fake CLI); `bench/src/stats.ts` (overhead method) | T28, T26, T27 |
| Vercel docs, "Agent harnesses" (`vercel.com/docs/agent-harnesses`: claude-code, security, observability) | docs | the box holds no secret, tools off until listed, per-task spend and box-time budgets, egress allowlist, the `restart` stream event, owner recorded before the first message, no remote images from model output, a trace per task with content off by default | T28, T27, T24, T15 |
| CopilotKit/OpenBot | MIT | `agent-claude-sdk` (setup-token handling: refuse both a token and an API key), routines limits, approvals pages, the component gallery, the per-tool-call policy check with an audit row first | T27, T23, T20, T13, T15 |
| CopilotKit/openmuse | MIT | rich thread cards (`docs/RICH-THREADS.md`) and the browser "Take control" flow; the headless mobile client for later | T24, T14b, T18 |
| CopilotKit/OpenDots | MIT | approval cards ("Approve & run" for write tools), interrupted scheduled-run recovery | T20, T23 |
| trycua/cua (libraries, not the Spaces app) | MIT | `cua-driver` on the box: open what the agent built, click through it, take the screenshot that the delivery card shows and the reviewer checks | T24, T25, T14b |
| reason-machines/reason-network | MIT or Apache-2.0 | `src/files.rs` rules for files an agent sends out (no hidden files, no `~/.ssh`, `~/.aws` and similar, size caps), the loop guard; `src/doing.rs` (what a session is doing, from its own title and todo list); `src/render.rs` `defang` and `util::printable` (outside text cannot open or close a frame, and loses control, direction and look-alike characters); `src/hook.rs` (messages shown to a running agent at its next step through its hooks); the install rule that never puts an unverified build over a verified one | T15, T20, T23, T24, T27, T28 |

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

# Batch 2.5: internal beta

Goal: a few invited users run real coding and research tasks safely. Live
runs still need the owner's budget approval; build and test with fakes.

## T21: per-invite spend limits and a kill switch

Depends on: T4, the model gateway.

- Per-invite daily and monthly caps in USD, set with
  `cloud-server invite limits --invites <file> <inviteId> --daily <usd> --monthly <usd>`
  (defaults from the environment). The gateway checks them at reservation
  time across all of the invite's task trees, together with the existing
  per-task budgets, so concurrent tasks cannot overrun them.
- A server-wide daily cap, and a kill switch (`maka-cloud pause` and
  `maka-cloud resume`, persisted under the data directory): while paused, new
  reservations are refused and running tasks are cancelled through the
  normal stop path, so owed stops and settlement rules still hold.
- Hitting a cap ends the task's spending and raises a T20 "budget" item; it
  is never a silent failure.
- Counters survive a restart (reuse the gateway spend journal).
- Tests: concurrent tasks of one invite cannot exceed its cap; one invite's
  spend never counts against another's; pause refuses the next reservation
  and cancels running tasks; restart keeps the counters.

## T22: deployment and operations for the beta

Depends on: T21.

- `docs/fork/deploy.md`: one-host runbook (service unit or compose file), TLS
  proxy settings that keep SSE streaming, `MAKA_CLOUD_MCP_PUBLIC_URL`, how the
  web app is served, every environment variable, `MAKA_CLOUD_SANDBOXES` setup
  for each new invite, and file permissions for secrets.
- Daily SQLite backups with the online backup API (keep 7) and a restore
  command; a health endpoint; structured logs that never contain keys,
  tokens or vendor names (scrub test).
- A spend alert: when the day's spend passes a configured amount, notify the
  owner by push.
- `maka-cloud smoke`, gated on `MAKA_CLOUD_LIVE=1`: one research task, one
  coding task that opens a PR on a scratch repo, a cancel mid-run, a budget
  stop and a restart, then print the ledger next to the gateway journal.
  Do not run it; the owner runs it after approving a budget.
- Tests: backup and restore round trip, log scrubbing, health endpoint, and
  the smoke script's dry run against fakes.

---

# Batch 3a: the employee (before the rest of batch 3)

## T23: projects, standing duties and event triggers

Depends on: T5, T15, T20, T21. Replaces T12.

- Package: `packages/cloud-duties`.
- A project is a repository plus its duties. A duty is: a trigger (CI failed
  on the default branch or on the employee's own PR, a new issue, a review
  comment on the employee's PR, or a schedule), an instruction in plain
  language, an authority level (`read-only`, `open-pr`, `merge-when-green`),
  a per-run budget and a daily cap.
- GitHub App webhooks: verify every signature, dedupe by delivery id, and
  stay correct under at-least-once, unordered delivery. Event content from
  outside the user (issue and comment text) is tainted under T15.
- When a project is added, the conductor inspects the repository (CI config,
  open issues, recent failures) and proposes two to four duties as one T20
  item with the recommended set first. Nothing runs until the user approves.
- Each trigger starts a conductor run with the duty's brief and limits. The
  authority level is enforced in code at the tool gate (an `open-pr` duty can
  never merge). Results go to the Home brief (T24); escalations go through
  T20.
- Schedules: missed runs after downtime run once, never once per missed slot.
- Limits borrowed from OpenBot's routines and Reason Network's loop guard:
  a schedule runs at most every 15 minutes, an invite has at most 20 enabled
  duties, a duty that fails 10 times in a row turns itself off and tells the
  user, and one duty's output can trigger another at most 3 times in a row
  before it needs the user.
- Tests: bad signatures rejected, duplicate deliveries ignored, authority
  enforced, budget and daily cap stop a run, schedule catch-up, a proposal
  runs nothing until approved, injected instructions in an issue cannot
  trigger a guarded tool.

## T24: Home, Chat and Projects in the Hark style

Depends on: T9, T20, T23. Replaces T16 (suggestions come from duty
proposals and T20 items).

- `packages/cloud-web`: navigation is Home, Chat, Projects and Settings only.
- Home: first the decisions waiting on the user, as verb-first one-tap cards
  built on T20 items ("Merge PR #12: tests passed, review passed"; "Allow $3
  more for this task"), with the precondition-hash refresh; then what was
  done since the last visit, one line each with its cost; then what runs
  next (scheduled duties).
- Brief: a morning and an evening message in Chat summarising the same, also
  kept on Home; it replaces the T20 digest delivery.
- Chat: one conversation with the employee. The conductor decides whether to
  answer directly or start a task. A running task shows one updating line
  that expands to its steps; terminal output is collapsed by default.
- Delivery, the part users notice most in Hark: a finished task arrives as one
  result card in Chat, not a wall of text. The card has a one-sentence outcome
  in plain words ("The login page no longer loops; tests pass"), one visual
  proof (a screenshot of the running app, the PR page or the test summary,
  taken in the box), a short caption, and at most two one-tap actions ("Merge
  PR #12", "Open preview"). Tapping the visual opens it large over a blurred,
  dimmed Chat: close at top left, collapse at bottom right, a small status
  pill with the result beside it, and a swipe or Escape to go back. A diff
  opens the same way. Running tasks show a live thumbnail of the box's screen
  when it has one (T14b) and fall back to the step line. The step line is
  read from what the agent records anyway, as Reason Network's `doing.rs`
  does: the session's own title and the item in progress on its todo list
  (Claude Code's tasks or TodoWrite, Codex's `update_plan`), from the
  mirrored transcript (T28). Agents never spend tokens reporting progress.
- Sources and links, as Hark shows a search answer: a short answer first
  (the pick, then one alternative per need, ending in one plain-text offer
  such as "Want me to set one up?"), then the sources as a small fanned stack
  of up to three cards below it, slightly rotated and overlapping (about -5,
  0 and +4 degrees), the middle one on top with the deepest shadow. Each card
  is about 215 by 190 px with a 12 px radius: a preview image on the top 60
  percent, then a title (14 px, medium, two lines at most) and a grey meta
  line (12 px: site, a dot, and a short label saying why it is there, such as
  "the docs" or "an alternative"). On a phone the stack becomes a horizontal
  swipe. A coding task uses the same stack for its PR, its preview and its
  test report. Preview images are fetched by the server through a proxy that
  refuses private and local addresses, caps size and time, and caches; the
  browser never loads them from the source site, and a page without one gets
  a plain card with the site's initial. The proxy fetches only pages the task
  actually opened (from its tool results), never a URL the model wrote, and
  an image inside model output (a markdown image) is never loaded until the
  user taps it: a URL fetched without a click is a way to send data out.
- Briefs end with one offer ("Want me to update the two failing
  dependencies?") and say the offer is also saved on Home.
- Projects: the list, and per project its duties (on or off, authority,
  budget) and tasks. A task page shows the plan, steps, diff, test evidence,
  review verdict, cost and the PR link.
- Look, as Hark actually renders it: Home and Chat sit on a soft full-bleed
  background (light: a sky-blue gradient or photo; dark: navy to slate), with
  frosted translucent cards on it (white at about 45 percent with a backdrop
  blur, 14 to 20 px radius, no tails on chat bubbles, user messages as small
  right-aligned pills). Verb-first cards put the verb in a small chip. Stat
  panels use a three-tile grid (small grey label, large bold value). Controls
  are pills and 44 px round icon buttons; the top navigation is a segmented
  pill with the active item solid; the composer is a floating pill with a
  round send button. Thin line icons, a sans-serif system font with hierarchy
  by weight, one restrained accent colour, generous whitespace, phone first.
  Never show model or vendor names.
- Density by page: Home and Chat are airy; a task page (diff, test output,
  terminal) is dense, on an opaque surface, and uses a monospace font for
  code, because that is where a programmer reads. Never blur or tint behind
  code or diffs.
- Native Liquid Glass waits for the iOS app (T18), which gets it from the
  system; the web uses plain CSS backdrop blur only.
- Light and dark themes both, dark by default; check contrast on both.
- Tests: Playwright at desktop and phone width for Home, a project and a task
  page; a stale card refreshes instead of acting; one tap answers exactly
  once.

## T25: modes and cross-vendor review

Depends on: T5, T8, the model gateway.

- Replace model choice with modes: `quick`, `standard` and `deep`. The user
  may pick one; otherwise the conductor picks from the task's size and
  budget. One versioned config maps each mode's roles (conductor,
  implementer runner, reviewer, helpers) to models and effort, so a mode
  keeps its meaning when models change.
- The reviewer is always a different vendor from the implementer. Before a
  coding task is shown as done, the reviewer checks the diff against the
  brief and the repo's invariants; P1 findings go back to the implementer
  once, and whatever remains is shown on the task page. In `deep`, research
  claims get the same cross-vendor review (the optional reviewer in T7).
- Helpers (search, summaries, titles, briefs) use the cheapest adequate model.
- Every call goes through the gateway with its reservation.
- Tests: the mode-to-role mapping, the reviewer's vendor always differs, the
  per-mode budget holds, and the fix loop runs at most once.

## T28: durable tasks (design borrowed from Vercel's durable-harness)

Depends on: T6, T8, T21. Comes before T26 and T27, which need it.

Today a server restart fails every running task ("orphaned") and a box that
dies loses the agent's session, because the transcript lives only on the box.
Borrow the design of github.com/vercel-labs/durable-harness (Apache-2.0; read
its `packages/harness-world`, `harness-claude-code`, `harness-codex` and
`harness-process`), not its code or its dependencies: no Workflow SDK, no
Vercel Sandbox. Keep our SQLite stores, our gateway and instabox.

- Step log per task, in the orchestrator's existing event store: before any
  model call, tool call with a side effect, push, PR, message or box action,
  record its intent with a memo key and a replay class; after it, record the
  outcome. First writer wins per memo key, and an outcome applies only to a
  step still running. A completed step is never run again: its recorded
  output is reused.
- Replay classes: `safe` (reading, tests, building, a model call) reruns
  after a crash; `never` (push, open or merge a PR, send, pay) is not rerun.
  An interrupted `never` step is recorded as "may or may not have taken
  effect", and the agent is told so and checks before trying again. Before a
  `never` step runs, its intent must be durably written (a barrier).
- Fencing: each attempt to drive a task gets an epoch. Every write carries the
  epoch and the log sequence it read; a stale writer (an old process, a late
  handle, an old box) is refused at its first write, starts nothing, and
  stops. This replaces the case-by-case late-handle and stop-pending fixes.
- Build the Claude Code side on the Claude Agent SDK instead of `claude -p`:
  `query()` with `spawnClaudeCodeProcess` runs the unmodified `claude` binary
  on the box through our exec channel, `sessionStore` gives the transcript
  mirror below without tailing files, its hooks give the step log for tool
  calls, and its streaming input gives steering. Codex uses the app-server
  for the same (T27 moves to it anyway).
- Transcript mirroring: copy every line the CLI appends to its session file
  into the server as it is written (Claude Code: the session JSONL under
  `CLAUDE_CONFIG_DIR/projects/`; Codex: the rollout JSONL under
  `CODEX_HOME`), tracking file size and inode, deduplicated by entry id, with
  paths rewritten to the server's. A line that cannot be mapped stops the turn
  with an error and keeps the task (fail closed). The server's copy is the
  source of truth.
- Resume instead of fail: after a restart, a lost box, or a box that slept
  (T26) or moved (T27), start a fresh box, wipe the CLI's config directory,
  upload only the mirrored session files, and resume the same session by id
  (`claude --resume`; Codex `thread/resume`). Never reuse an old CLI home. If
  the last turn never ended, first send a recovery note listing the steps that
  completed, the `never` steps that were interrupted, and the `safe` steps
  that will rerun. Give up after 3 resumes in a row and mark the task for the
  user. Workspace files come from the box's disk or its snapshot; they are
  not transactional, so the recovery note says what to re-check.
- Spend: a model call the transcript shows as completed is not repeated, so
  it is not billed twice; a call a crash cut off is billed once more and that
  is recorded. Reservations follow the step log (intent reserves, outcome
  settles), and a fenced writer can never settle.
- Steering: a message the user sends while a task runs goes into the running
  session at the next safe point instead of waiting or restarting (Claude
  Code stream-json input; Codex app-server, which T27 moves to). A withdrawn
  message that was not yet delivered is dropped. Until a runner moves to
  those, its hooks carry the message instead (Reason Network's `hook.rs`):
  the hook after each tool call prints waiting messages so the agent sees
  them at its next step, and a broken hook never breaks the agent.
- Catch-up: the task stream has a cursor; a page that reconnects (or a phone
  that wakes) resumes from its last cursor and sees what it missed, which T24
  needs for "close it and come back, the work kept going".
- Hardening from the same design: the CLI's environment is an explicit
  allowlist; Codex's `shell_environment_policy` excludes our token variables
  so tools the agent runs cannot read them; the model token in a box only
  works from the CLI's own process tree where the box can enforce it.
- The box holds no long-lived secret (Vercel's rule): the CLI's model calls
  go to our gateway with a token armed for this attach only, short-lived and
  refreshed by the server before it expires; a box's own secret is derived
  per box and boot (HMAC of a server key, the machine id and the boot id), so
  a copied value is useless on another box or after a reboot. The one
  exception is T27's Claude plan token, which Claude Code itself must hold;
  T27 limits it to the `claude` process. The box keeps
  the highest epoch it has seen on disk, so a restarted box helper still
  refuses a stale driver.
- Fence the live stream too, not only the log: after a takeover, events from
  the old driver never reach viewers (the durable-harness authors list this
  as their own open gap). The stream serves only events already written to
  the log, so a cursor is exact and a crash between write and send loses or
  repeats nothing.
- A box command with a side effect is settled only after the box confirms
  its process group is gone, and no driver deadline cuts a command that is
  running (their handover stops a long `npm install` mid-way; ours must not).
  A `never` step that calls an outside system passes it an idempotency key,
  or checks first (for GitHub: an existing branch or PR for this task).
- When a cut-off turn resumes, the stream sends a `restart` event with the
  text to show in place of the partial reply, so the user never sees the
  same answer twice.
- Steering during recovery: hold steers until the resumed turn's first step
  has finished; durable-harness leaves steers during replay undefined.
- Per-task budgets on top of the invite's caps: model spend per turn and per
  task, and box time per task (default 4 hours, as Vercel's), each stopping
  the task with a note for the user.
- Run timeline from the step log: one trace per task with turns, steps, model
  and tool calls, tokens (cached input too), cost from the gateway and
  timing; resumed calls are read back, not shown twice. It records only
  metadata unless the owner turns content on, and a tracing failure never
  fails a task. The web and phone views must agree with the step log exactly
  (their "agree" check).
- Tests with fakes: a crash after a `never` step is never rerun and the
  recovery note lists it; a crash mid-`safe` step reruns it once; two
  processes driving one task, the stale one refused at its first write and the
  side effect happens once; a restart resumes a running task with its session
  instead of failing it; a lost box resumes on a fresh box from the mirrored
  transcript; an unmappable transcript line stops the turn and keeps the task;
  a resent user message is applied once; a reconnecting viewer gets every
  event after its cursor exactly once; no completed model call is billed
  twice; a drill that kills the driver inside a `never` step while its child
  process lives on in its own process group (the step is reported
  interrupted and never rerun, the child's late writes are refused); a stale
  driver's live events never reach a viewer. Use a scripted fake CLI
  (`call <tool> <json>` makes one tool call, anything else is echoed), and
  keep each known gap as an expected-failure test with an owner, so fixing
  it fails the test until the entry is removed.
- Measure the cost of durability once against plain runs, the way their
  `bench` does (median of per-round differences, warm-up and recovery rounds
  left out), and keep gates: first token within 150 ms of a plain run, and a
  killed driver's task running again within 12 seconds.

## T26: sandbox sleep and wake, and Ship

Depends on: T6, T8, T23, T28.

- An invite's sandbox machine pauses after a configurable idle time (no task
  running, no live terminal or desktop view) and resumes on the next task or
  message with its state intact. The web app shows it as asleep.
- Ship, one action on a coding task: commit, rebase onto the base branch, run
  the tests, push, open the PR, then follow that commit's CI and report. A CI
  failure on the employee's own PR wakes the task to fix it once, then
  escalates. Merging happens only when the duty or the user grants
  `merge-when-green`.
- Tests with a fake instabox and a fake GitHub: idle pause, no pause while a
  task runs, resume on a message, the ship path, and the bounded CI fix loop.

## T27: the user's own Claude and ChatGPT plans, on many boxes

Depends on: T6, T21, T25, T26.

Like Amp: the user links their own Claude and ChatGPT plans once in Settings,
and from then on every coding task can run the real `claude` and `codex` CLIs
on that plan, many tasks at once, each on its own instabox. That is the
cheapest way for the user: model use is billed to plans they already pay
for, and we pay only for boxes.

- Connections in Settings, per invite: Claude plan, ChatGPT plan, and the
  existing API-key path through the gateway. Each shows linked or not, when it
  was linked, when it expires, and Unlink. The conductor, planner, verifier
  and helpers keep using the gateway with its reservations; only the coding
  runners use a linked plan.
- Claude plan: the user runs `claude setup-token` on their own computer
  (Anthropic's own sign-in) and pastes the one-year token, the way
  Anthropic's devcontainer docs describe for a Codespaces secret. Store it
  encrypted at rest per invite, never log it, never send it to the browser
  again. Inject it as `CLAUDE_CODE_OAUTH_TOKEN` only into the `claude`
  process's environment on that invite's boxes, never into a shell profile or
  a file. The token has no refresh, so any number of boxes can use it at once.
  Warn 30 days before it expires. Run the unmodified Claude Code binary.
- ChatGPT plan: run Codex through the Codex app-server, not `codex exec`, in
  host-token mode (`account/login/start` with `chatgptAuthTokens`). The
  server is the only owner of the refresh token: it hands each box a
  short-lived access token and answers `account/chatgptAuthTokens/refresh`
  itself, with one refresh at a time per invite. The refresh token never
  enters a box, so many boxes never race on a refresh (OpenAI's docs say one
  `auth.json` per machine, never shared). The user links through the device
  code flow (`codex login --device-auth`) run by the server, never by
  pasting `auth.json`. When OpenAI approves us for "Sign in with ChatGPT",
  replace the device flow with it.
- The runner guards in `cloud-runners/src/vendors.ts` that refuse a
  subscription login stay for the API-key path. The plan path is a separate,
  explicit runner mode chosen per task from the invite's connections; a box
  never holds both a plan credential and a gateway key for the same vendor.
- Many boxes per invite: a pool of instabox machines per invite with a
  maximum (default 3), one task per box, boxes from T26 that sleep when idle.
  Boxes of different invites never share a machine, a credential or a
  checkout. Box time is counted by T21 per invite.
- The CLIs installed on a box are pinned and checked against a known
  checksum; a box never replaces a checked build with an unchecked one or an
  older one (Reason Network's install rule).
- Set up once, like Amp's project snapshot: per repository, run its setup
  (install the CLIs and the dependencies) once, save an instabox snapshot
  keyed by the setup's hash, and start new pool boxes from it; a changed
  setup builds a new one, two builders racing end with one snapshot, and old
  ones expire. A resume script runs after every wake. A box is found again
  by its labels (invite and pool slot), and a box whose labels or settings
  do not match is refused, not used (OpenMuse's rule).
- Sleep like Amp: a box sleeps only when its agent has done nothing for 5
  minutes and the user has not looked at it for 20. A wake that times out is
  retried once with a longer limit before the box counts as lost ("slow, not
  dead"). Idle cleanup re-checks each box right before it deletes anything,
  and never touches a box with a running task or a recent write.
- Tools: each runner mode lists the built-in tools it allows instead of
  today's full access, and the egress of a box is an allowlist (GitHub, the
  package registries, our two public names) when instabox can enforce one;
  check that with a probe first.
- Probes: small scripts, run by hand behind `MAKA_CLOUD_LIVE=1`, that check
  what we assume about instabox (wake time, a snapshot restores files, exec
  after sleep, one box cannot reach another, the egress rule, the plan's box
  limit learned from a refusal). Rerun them when instabox changes.
- Spend: plan use costs us nothing per token, so a plan task reserves box
  time, not model money. When the plan says its usage limit is reached, the
  task pauses and tells the user (with the reset time when the CLI gives
  one); it falls back to the API-key path only if the user turned that on.
- Unlink deletes the stored credential, stops injecting it, and tells the
  user to also revoke it at claude.ai or ChatGPT. A 401 from either CLI marks
  the connection broken and asks the user to link again; it never retries
  with another invite's credential.
- Internal beta only with the owner's own plans. Before other people link
  plans: confirm the setup with Anthropic (their terms forbid platforms to
  "collect, store, or intermediate" claude.ai credentials, while their
  devcontainer docs show a stored setup token) and apply to OpenAI's "Sign in
  with ChatGPT" partner programme. This is a launch gate, not a coding task.
- Tests with fakes: the token reaches only the `claude` process of that
  invite's box and never logs, files, events or the browser; concurrent boxes
  share one Claude token; Codex boxes get access tokens only, and concurrent
  401s cause one refresh; unlink stops new tasks at once; a usage-limit
  message pauses the task; another invite's task never sees the credential;
  the pool never exceeds its maximum.

## T14b: live computer handoff on real runners

Depends on: T14 (the web and server seam from PR #99, routes off by
default), T26.

- Give the active `RunHandle` of `SandboxCliRunner` (and the coding runner)
  real pause and resume: the agent CLI stops taking actions while the user
  holds control and continues the same session afterwards. A session restart
  is not a pause.
- A trusted adapter from the invite's instabox machine (desktop and terminal
  routes, VNC and PTY) to T14's `ComputerSource`, wired in the host from the
  task to its invite's machine. Never expose provider URLs or sandbox
  credentials to the browser.
- Turn the T14 routes on only when this adapter is configured. T14's
  isolation, revoke and abort contracts must still hold: another invite gets
  404, revoke closes the stream and aborts held input, and a failed handback
  keeps the task paused.
- Tests with a fake instabox desktop and PTY and a fake CLI that records
  actions: no agent action while the user holds control, resume continues the
  same session, and isolation and revoke on the real host wiring.
- The sandbox provider stays instabox. Before writing the adapter, read Cua
  (github.com/trycua/cua) and borrow what fits: the cua-driver desktop layer
  (screen, input and terminal for an agent, MCP and SDKs) and the Cua Spaces
  handoff model, where the human and the agent share one desktop with
  separate cursors, the human steps in and hands back. Prefer that model if
  it maps onto instabox's desktop; otherwise keep pause and resume. Check the
  licence of each piece before copying or depending on it: the libraries are
  MIT, the Spaces app is FSL-1.1-MIT. Say in the PR what was borrowed.

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

Folded into T23 (a schedule is one kind of duty trigger). Do not start it
separately.

Depends on: T5, T9.

- Recurring and delayed tasks ("every Monday, summarize X"). Check Maka's
  existing automation scheduler first and reuse it if it fits.
- Each run has a budget, ends with a push notification, and shows in history.
- Tests: schedule parsing, missed runs after downtime, budget stop.

## T13: panels

Depends on: T5, T9, T24 (panels live on Home).

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

Depends on: T5. Do it before T23: duties act on issue and comment text
written by other people.

- Content from outside the user (web pages, fetched files, third-party
  messages, tool output from external sources) marks the task context as
  tainted.
- While tainted, tools that write outside the sandbox, send anything, spend
  money or are irreversible require a user approval card. Enforce this in the
  tool gate in code, never by prompt.
- Outside text cannot pass itself off as ours (Reason Network's `defang`):
  wherever issue, comment, web or memory text reaches the model next to our
  own framing, it cannot open or close a frame of ours, even split across
  fields printed side by side (`repo` then `branch`) or written with
  look-alike brackets. Text from outside shown to the owner (approval cards,
  inbox items, Home cards) loses control, direction-override and invisible
  characters first, so a card cannot show something other than what it is;
  the approval stores the exact text the owner saw, and approves only that.
  Tests: a frame-closing string in an issue body, split across two fields,
  and with a direction override in an approval card.
- Tests: injection fixtures (hidden instructions in a fetched page) that try
  to trigger each guarded tool, and the clean path that needs no approval.

---

# Batch 4: towards Hark

Gmail is out of scope for now (Google restricted-scope review). Do not add
Gmail scopes.

## T16: proactive suggestion cards

Folded into T23 (duty proposals) and T24 (Home cards). Do not start it
separately; what is left (accept and dismiss tracking, backoff after three
ignored cards, a daily cap) goes into T24.

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
