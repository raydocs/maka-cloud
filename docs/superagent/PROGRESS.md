# Super-agent /goal progress

Survives compaction and restarts. Read this first, then continue from **Next step**.

- **Goal (owner's /goal, 2026-11-03, second run):** carry out `executor-decision.md` and
  `efficiency.md`. Super-agent only schedules, authorizes and keeps work reliable; Claude Code
  and Codex are the executors; no more growth of our own harness. New features default off
  behind env switches; never weaken tests; no force-push, no merge to main, no branch deletion;
  secrets only from env; Linux CI is the bar; morning report in `docs/superagent/CHANGELOG.md`.
- **Started:** 2026-11-03 02:50 MST. **Updated:** 2026-11-03 05:03 MST (about 2 h 20 min in). All phases done; morning report written.

## Phases

| Phase | Branch / PR | State |
|---|---|---|
| 0 old branches | `superagent/harness-analysis` #482, `superagent/coder-tool-loop` #483 | done; drafts, default off, frozen; Linux green |
| 0 decision docs | `superagent/executor-decision` #484 | done; draft; green |
| 1 Executor interface + FakeExecutor | `superagent/executor` #485 (`4f9f76001`) | done; green |
| 2 ClaudeCodeExecutor + budgets | `superagent/claude-code-executor` #486 (`3e4609985`, `06f9a50f4`) | done; green |
| 3a persisted outbox | `superagent/outbox` #487 (`78a5d4e8b`) | done, not wired (see `dsh-gap.md`); green |
| 3b restart recovery, follow-ups, `dsh-gap.md` | `superagent/executor-recovery` #490 (`3f9c2cc71`) | done; green |
| 4 layered workspace | `superagent/layered-workspace` #488 (`3e13d9ddd`) | done; green |
| 5 CodexExecutor + cross-vendor review | `superagent/codex-executor` #491 (`002a86565`, review fixes `317d07325`, `537906f74`) | done; two independent review rounds; Linux green at `537906f74` |
| 6 benchmark | `superagent/executor-bench` #489 (`5ac5bd249`), extended in #491 | done: claude-code 3/3, codex (Magpie) 3/3 live after the review fixes; maka skipped |

Stack: #485 → #486 → #489 → #490 → #491 (each PR targets `main` and names its own commits).
Worktrees (scratchpad of this session): `decision`, `exec`, `outbox`, `layered`.

## Decisions

- Every PR targets `main` and names its own commits; stacked branches merge their parent.
- Auth (owner, 2026-11-03): the box's own CLI login first (Instabox org Secret selected at
  create time, e.g. `CLAUDE_TOKEN_1`), checked once per box; Magpie only where the CLI is not
  signed in (`MAKA_CLOUD_MAGPIE_URL` / `MAKA_CLOUD_MAGPIE_KEY`), or always with
  `MAKA_CLOUD_EXECUTOR_GATEWAY=magpie`.
- Instabox exec drops `env`: box env goes over stdin (0600 file, sourced and deleted).
- No invented prices: models without a list price show `unpriced` in the bench.

## Blocked on the owner

- `MAKA_GITHUB_TOKEN` (fine-grained PAT) gets 403 on `POST git/blobs` in
  raydocs/maka-loop-scratch: it needs Contents and Pull requests read/write there. Until then
  the live bench cannot open PRs, so the merge gate is only exercised offline.
- AGENTS.md says "Models are reached with API keys only… never offer a claude.ai login", while
  the box route runs Claude Code on an org Secret OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`).
  Needs the owner's call.
- The owner's "Magpie gateway, tested 2026-11-03" section is an uncommitted edit of
  `docs/superagent/executor-decision.md` in the main checkout; #484 does not have it yet.

## Next step

1. Owner: grant the PAT Contents and Pull requests read/write in raydocs/maka-loop-scratch, then
   run `MAKA_CLOUD_BENCH_PUBLISH=1 MAKA_CLOUD_BENCH_REVIEW=cross npm run executor-bench` in
   `packages/cloud-superagent` (stops at the held merge).
2. Owner: decide the box OAuth Secret vs the AGENTS.md API-key-only rule; commit the Magpie
   section of `executor-decision.md` (#484).
3. `dsh-gap.md` next steps, smallest first: wire the outbox (#487), host coder with
   `StoreExecutorSessionStore`, `handback` status, policy-version notice, failure hold.
4. #491 residual risk (in its PR body) has not been reviewed after `537906f74`.
