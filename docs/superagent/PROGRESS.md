# Super-agent /goal progress

Survives compaction and restarts. Read this first, then continue from **Next step**.

- **Goal (owner's /goal, 2026-11-03, second run):** carry out `executor-decision.md` and
  `efficiency.md`. Super-agent only schedules, authorizes and keeps work reliable; Claude Code
  and Codex are the executors; no more growth of our own harness. New features default off
  behind env switches; never weaken tests; no force-push, no merge to main, no branch deletion;
  secrets only from env; Linux CI is the bar; morning report in `docs/superagent/CHANGELOG.md`.
- **Started:** 2026-11-03 02:50 MST. **Updated:** see the last commit touching this file.

## Phases

| Phase | Branch / PR | State |
|---|---|---|
| 0 old branches | `superagent/harness-analysis` #482, `superagent/coder-tool-loop` #483 (drafts, default off, frozen) | CI was running at 02:58; `superagent/script-tool` has no commits of its own (same tip as #483), so no separate PR |
| 0 decision docs | `superagent/executor-decision` #484 (docs + AGENTS.md) | open, draft |
| 1 Executor interface + FakeExecutor | `superagent/executor` #485, commit `4f9f76001` | done |
| 2 ClaudeCodeExecutor + budgets | `superagent/claude-code-executor` (stacks on #485) | next |
| 3a persisted outbox | `superagent/outbox` `78a5d4e8b` (subagent; stacks on #484) | done, PR not opened yet |
| 3b restart recovery note, follow-up hand-back, `dsh-gap.md` | stacks on phase 2 | not started |
| 4 layered workspace | `superagent/layered-workspace` (subagent) | running |
| 5 CodexExecutor + cross-vendor review | stacks on phase 3b | not started |
| 6 benchmark | — | check for keys first |

Worktrees (scratchpad of this session): `decision`, `exec`, `outbox`, `layered`; each has a
`node_modules` symlink to the main checkout.

## Decisions

- Every PR targets `main` (CI only runs there) and names its own commits; stacked branches
  merge their parent, never rebase.
- CHANGELOG: newest entry may omit its SHA; heading time within 5 minutes of the commit.
- `FakeCoder` = `ExecutorCoder(new FakeExecutor(files))`.
- Executor outcome `needs-person` / `blocked` → loop waits on a human (`review-wait`, waiting
  `human`), no tests, no push. `failed` → `progress: false`.

## Next step

Phase 2 on `superagent/claude-code-executor`: `executor-budget.ts` (tokens/USD/wall/turns from
`mandate.budgets` minus `worker.usage`; 80% → `send` wrap-up, 100% → `stop` + needs-person),
`claude-code-executor.ts` (`claude -p --bare --output-format stream-json --input-format
stream-json --session-id`, JSONL parse, process runner port for tests), `MAKA_CLOUD_EXECUTOR`
selection in `loop-coder.ts`.
