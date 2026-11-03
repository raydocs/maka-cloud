# Decision: Claude Code and Codex are the executors

Status: **accepted** (owner, 2026-11-03). This overrides earlier plans to grow
`loop-coder.ts` into our own full coding harness.

## Decision

Super-agent is split into two layers.

1. **Super-agent layer (ours, the product).** Intake of Source events, the
   deterministic gate, the model assessment, Tickets with their Mandate,
   Assignments, Subscriptions and follow-ups, stored work (outbox) with
   retries, restart recovery, structured "needs a person" questions, the
   watchdog, the ledger and spend caps, and the merge gate. It does not write
   code and does not run a tool loop.
2. **Executor layer (not ours).** Each Assignment runs one **Claude Code** or
   **Codex** session inside the tenant's Instabox, with its own directory and
   worker branch, driven headless (Claude Code: `claude -p` / Agent SDK;
   Codex: `codex exec` / SDK; ACP where it fits). Prompt cache, bounded
   autonomy, compaction, subagents and programmatic tool calling come from the
   executor and improve when it upgrades.

The maka engine (`packages/cloud-maka-engine`) stays as an **optional third
executor** behind the same interface. It becomes the default only after it beats
Claude Code / Codex on the same maka-loop-scratch task set (pass rate, $/PR,
time-to-green).

## Executor interface (the only seam)

- `start(ticket, mandate, workdir, model)` returns a session id.
- `send(sessionId, input)` delivers follow-ups, CI results and review comments.
- `resume(sessionId)` after a restart, with a recovery note: check the
  directory, git history and GitHub before repeating any outside action.
- `stop(sessionId)`.
- An event stream normalised to: `progress`, `needs-person` (structured
  question), `ready` (with PR), `blocked`, `failed`, plus usage (tokens, USD).

The Mandate and the team rules go into the session's system prompt. Tokens
stay on the host; the box gets only the scoped credentials the Mandate allows.
Routing may pick the executor per task (e.g. Opus for hard work, Codex for
cross-vendor review).

## Consequences

- Hand-written coder loop work (multi-turn `loop-coder`, Script tool, on-demand
  tool loading) is **frozen** as a fallback path, default off. No new effort
  goes there unless it is for the maka executor.
- Effort moves to the Super-agent layer's reliability, following
  deepseek-ai/dsh-superagent-prototype docs 001–003: stored work, follow-up
  hand-back, structured attention, Policy-version notices, restart recovery.
- `FakeCoder` becomes a fake executor behind the same interface so CI stays
  offline.
- Keep concepts few: a new need becomes an attribute of an existing concept or
  prompt text before it becomes a new module.

## Workspaces and efficiency

See `efficiency.md`: Assignments run in a writable copy-on-write layer over a
shared read-only base image instead of git worktrees, with per-Assignment
budgets and difficulty-based model routing.

## Auth and model access (2026-11-03)

Instabox boxes ship with Claude Code and Codex installed and already signed in
(login is configured in Instabox, not in maka-cloud). Executors use that login
by default; maka-cloud never handles or stores those credentials. Fallback
route: the Magpie gateway (`MAKA_CLOUD_EXECUTOR_GATEWAY=magpie`, default off),
used when the built-in login is unavailable or rate-limited. The executor
reports which route it used in its `usage` events.
