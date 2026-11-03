# Super-agent /goal progress

Survives compaction and restarts. Read this first, then continue from **Next step**.

- **Goal:** take Super-agent from "all parts present" to "really runs" (owner's /goal, 2026-11-03):
  Droid harness analysis, multi-turn coder tool loop, Script tool, on-demand tool loading,
  live real-loop, shared-daemon measurement; 2–3 PRs to raydocs/maka-cloud, Linux CI green,
  not merged; morning report in `CHANGELOG.md` and the terminal.
- **Started:** 2026-11-03 02:23 MST. **Updated:** 2026-11-03 02:40 MST.

## Stages

| Stage | Owner | State |
|---|---|---|
| 1 Droid analysis (`droid-harness-analysis.md`) | subagent A, worktree `worktree-agent-a1dc533b854c9beb8` | running (resumed after restart) |
| 2 multi-turn coder loop (`MAKA_CLOUD_CODER_LOOP=1`) | main session, branch `superagent/coder-tool-loop` | in progress |
| 3 Script tool (`MAKA_CLOUD_SCRIPT_TOOL=1`) | main session | not started |
| 4 on-demand tool loading (`tool-loading.ts`) | subagent B | done, in `superagent/harness-analysis` @ `b54de2302` |
| 5 live real-loop | main session | skipped: `INSTABOX_API_KEY`, `ANTHROPIC_API_KEY`, `MAKA_GITHUB_TOKEN` all missing |
| 6 daemon bench (`daemon-bench.ts`) | subagent C | done, in `superagent/harness-analysis` @ `b54de2302`; Linux numbers in CHANGELOG |

## Branches and PRs

- `superagent/harness-analysis` (PR 1: analysis + tool loading + bench), from `main`. Worktree:
  scratchpad `pr1`. A's doc still to be added. No PR yet.
- `superagent/coder-tool-loop` (PR 2), fast-forwarded onto PR 1; PR 3 (Script) will stack on it.
  CI runs only for PRs into `main`, so every PR targets `main` and says which commits are its own.

## Decisions

- Tool loading uses Anthropic GA `defer_loading` + client-side `load_tools` returning
  `tool_reference` blocks (works on Haiku 5.5; `tools[]` bytes never change).
- CHANGELOG entries are written only by the main session, one per commit that touches
  `packages/cloud-superagent`; the previous heading gets its SHA in the next entry's commit.
- Compaction (16k summary) starts a fresh conversation from the summary instead of editing the
  old one (AGENTS.md: Claude history is append-only).

## Next step

Finish stage 2 on `superagent/coder-tool-loop`: `coder-model.ts` (streaming Messages client with
silence detection, same-provider retry, pricing), `coder-loop.ts` (tools read_file / list_files /
search / apply_patch / write_file / run, autonomy + prompt-cache wiring, optional tool catalog),
`loop.ts` passes a workspace to the coder, env switch in `loop-coder.ts`, tests with FakeSandbox
and a scripted model.
