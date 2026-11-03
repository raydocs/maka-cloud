# Efficiency: shared layered images, tokens and memory

Status: accepted 2026-11-03. Companion to `executor-decision.md`.

Rule of thumb: every decision is judged by **merged, CI-green PRs per dollar
and per hour**, not by tokens or memory alone. Saving tokens that causes a
failed PR is a loss.

## 1. Layered workspaces replace git worktrees

Worktrees share `.git` but every worktree still needs its own `node_modules`,
build output and caches, they leak on crashes, and two worktrees cannot hold
the same branch. Instead:

- **Base layer (read-only, shared):** repo checkout at a pinned main SHA plus
  installed dependencies, toolchains and warm build caches. Built once per
  (repo, lockfile hash) and reused by every Assignment on that box.
- **Assignment layer (writable, per task):** a copy-on-write layer (overlayfs
  on Linux / Instabox; a snapshot or clone-on-write dir elsewhere) mounted on
  top of the base. The executor (Claude Code / Codex) works only here, on its
  own worker branch.
- **Phase snapshots:** freeze the writable layer at each phase end. Restart
  recovery resumes from the latest snapshot; a bad attempt is dropped by
  discarding its layer. Speculative runs and cross-review copies are just
  extra layers on the same base.

What it saves: disk (one copy of deps instead of N), start time (seconds
instead of a fresh install), and memory, because read-only lower files are
served from one shared page cache across all Assignments. Process memory of
the executors themselves is saved by the shared box daemon (measured: 16
workers at 47.3 MiB vs 739.8 MiB as separate processes).

Fallback: when overlay mounts are not available, use a plain `git clone
--shared` plus a hard-linked deps cache. Worktrees are no longer the default.
Behind `MAKA_CLOUD_WORKSPACE=layered|clone` (default `clone` until the
layered path passes the maka-loop-scratch benchmark).

## 2. Saving tokens without losing results

- **Route by difficulty.** Cheap model for intake, gate, triage and summaries;
  strong model (Opus / GPT-5-class via Claude Code or Codex) only for the
  coding Assignment and for hard reviews. Escalate after a failure, never
  start high by default.
- **Stable prompt prefix.** Mandate, team rules and tool list go first and
  never change inside a session, so the provider prompt cache hits; new
  context is appended at the end only.
- **Give the executor less, better context.** Pass the Ticket, the relevant
  file paths and the failing CI log excerpt, not the whole thread. Long logs
  go to files the executor can read on demand.
- **Deterministic first.** Lint, type check, unit tests and the eval gate run
  before any model review; a model only sees what the machines could not
  decide.
- **Reuse sessions for follow-ups.** CI results and review comments go to the
  same executor session via `send`, instead of starting a fresh one that must
  re-read the repo.
- **Stop waste early.** Bounded autonomy (identical-call and empty-turn
  limits, silence watchdog) ends stuck sessions before they burn budget.

## 3. Budgets per Assignment

Each Assignment carries a budget in its Mandate: max tokens or USD, max wall
time, max turns. At 80% the executor is told to wrap up; at 100% it stops
and the Ticket goes to `needs-person` with a short report. Usage events from
every executor feed the ledger.

## 4. Measuring benefit

Per executor and model, on the maka-loop-scratch task set, record: pass rate,
USD per merged-ready PR, tokens per PR, time to green, peak RSS and disk per
Assignment, and workspace start time. Defaults (executor, model, workspace
mode) change only when these numbers say so, and the numbers go into
`CHANGELOG.md`.
