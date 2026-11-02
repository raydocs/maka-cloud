# Super-agent changelog

Append-only. Newest first. Times are America/Denver, taken from the
first listed SHA's committer date (`git show -s --format=%cI`).
Every behavior change under `packages/cloud-superagent` must add an entry
in the same commit. `changelog.test.ts` fails the package suite when this
file is missing from the branch diff, when a later Super-agent commit
omits it, when uncommitted Super-agent edits leave it unchanged, or when
a heading time is more than five minutes off that SHA's committer date.

## 2026-11-02 12:15 MST — cursor/superagent-shared-box-51be — 285bcb971

- **PR:** [#472](https://github.com/raydocs/maka-cloud/pull/472)
- **What:** `biome format` on `box-pool.ts` and `box-pool.test.ts`. Merged #471 W2 two-tick host test and #466 `.setup-*` cleanup.
- **Why:** CI `test` on #472 runs 41502228088 and 41506056381 failed `format:check` (`Found 2 errors`) before workspace tests ran. Same assertions.
- **Tests:** format check of those two files; host stuck-card and cancel-install come from the merge
- **Live:** n/a
- **Migrations / risk:** none. Format only.

## 2026-11-02 12:13 MST — cursor/superagent-real-loop-51be — b87e48b09

- **PR:** [#471](https://github.com/raydocs/maka-cloud/pull/471)
- **What:** Host stack test ticks twice for W2 (nudge, then escalate → stuck card), matching `stuck.test.ts` / `watchdog.test.ts`. Forwarded from #466: harness cleanup kills `.setup-*` install dirs and retries `fs.rm` on ENOTEMPTY.
- **Why:** CI `test` on #471 run 41497463473: `the stack always starts Super-agent in process and a stalled worker is a stuck card` expected a card after one tick (`0 !== 1`). Real, deterministic — 3fd50604e made first stall a nudge. CI `test` on #466 run 41415227391: `cancel while the CLI is being installed releases everything` after-hook `ENOTEMPTY` on `work/.setup-claude`. Flake in a test we own; assertions unchanged. #464 run 41415226108 `drains a retraction started before /new re-keys` is an upstream `packages/cli` TUI flake (1453/1457 passed; prior host SHA green). iOS on #464–#466 cancelled at 45m after `simctl install` printed `Authorization is required to install the packages` — self-hosted Mac, no Maestro assertion, needs a human.
- **Tests:** cloud-host stack stuck-card; cloud-runners cancel-while-install
- **Live:** n/a
- **Migrations / risk:** none. Test-only.

## 2026-11-02 12:01 MST — cursor/superagent-shared-box-51be — 4e52438a1

- **PR:** [#472](https://github.com/raydocs/maka-cloud/pull/472)
- **What:** One host process per tenant box (`BoxDaemon`). Each worker is a lightweight in-process session (git worktree cwd, own env, own AbortController) instead of one maka process per worker. Isolation and cancel stay per worker. RSS measured here: idle `node` **43 MiB**; eight daemon sessions added **<1 MiB** total (~0.5 KiB/session at the noise floor). Owner-measured idle maka process is **232–278 MiB**, so N workers in one daemon pay that once instead of N times.
- **Why:** Factory Droid 1.0: several sessions used to mean several ~350 MB processes; they now share the daemon. User request to fold that into BoxPool.
- **Tests:** 143 passed in `@maka-cloud/superagent` (`test:dist`). FakeSandbox — two sessions, isolated cwd/env, cancel one leaves the other; per-session RSS is far below a per-process baseline.
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 11:35 MST — cursor/superagent-shared-box-51be — 59924d4af

- **PR:** [#472](https://github.com/raydocs/maka-cloud/pull/472)
- **What:** One long-lived Instabox box per tenant (`BoxPool`). Mandate size default 4/8192, up to 4 concurrent workers, git worktrees at `/work/<workerId>` from a cached base clone, shared npm cache, host-side secrets. Activity lease while anyone is active; idle 5 min then suspend; `deleteAfterSeconds` is a 7-day backstop only. Wake reports phase `waking` with measured time. Gone box rebuilds from the base snapshot, else a fresh create. Box JSON in the store (no migration). W-rule `box_stuck` for stuck suspend/resume or a leftover lease. Ledger records create/wake/restore wallMs. LayerFS stays off.
- **Why:** User request: one box per tenant, many workers, no 30-min kill.
- **Tests:** 141 passed in `@maka-cloud/superagent` (`test:dist`). FakeSandbox parity — concurrent workers, idle suspend then wake, snapshot rebuild — plus sqlite JSON persist, admission `worker_cap`, watchdog `box_stuck`. Host typecheck clean.
- **Live:** n/a (Instabox timings separately)
- **Migrations / risk:** none. JSON fields only. No sqlite `user_version` bump.

## 2026-11-02 11:06 MST — cursor/superagent-real-loop-51be — 4b2c813e3

- **PR:** [#471](https://github.com/raydocs/maka-cloud/pull/471)
- **What:** cloud-web progress tests typecheck: mock `request` takes the path so `calls[0][0]` is a string, and look/aria attributes use `getAttribute` (vitest has no jest-dom `toHaveAttribute`). Same assertions.
- **Why:** `cloud-web`, `rehearsal`, and `real-accounts` failed on #471 head `0356d514b` because `tsc --noEmit` includes tests.
- **Tests:** `packages/cloud-web` typecheck of `tests/work-status.test.tsx`
- **Live:** n/a
- **Migrations / risk:** none. Test-only.

## 2026-11-02 03:00 MST — cursor/superagent-real-loop-51be — 6f2e26320

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** First-class worker progress: named phases, persisted `worker.progress`, ETA from phase samples / usage ledger / defaults, last activity + heartbeat. Lead speaks on phase change, every 5 minutes on a long phase, and once when past ETA+margin (W1/W2); waiting on CI/review/human is not stuck. CLI `npm run status`; JSON/SSE `GET /v1/superagent/progress`; cloud-web `WorkerProgressBar` in the conversation work panel.
- **Why:** Top user pain from Amp Puck and Grok Bot: a 40–50 min silent run looks stuck.
- **Tests:** 133 passed in `@maka-cloud/superagent` (`test:dist`). cloud-server progress route tests passed. cloud-web `WorkerProgressBar` unit test added (vitest deps not installed in this environment).
- **Live:** n/a
- **Migrations / risk:** none. Progress is worker JSON. No sqlite `user_version` bump.

## 2026-11-02 02:47 MST — cursor/superagent-real-loop-51be — 8766e7a14

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Derive each CHANGELOG heading time from the first listed SHA's committer date in America/Denver. Corrected the backfill (e9680184a, 749221aa8, 001094a1a, and the rest). Test: heading vs `git show -s --format=%cI` within 5 minutes.
- **Why:** User request: timestamps did not match reality (e9680184a was listed 01:50 MST, requested ~02:10 MST).
- **Tests:** 122 passed in `@maka-cloud/superagent` (`test:dist`)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 02:45 MST — cursor/superagent-real-loop-51be — 50bd4c80c

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** `GitCloneStore.exportPatch` stages with `git add -A` then `git diff --cached HEAD` so new untracked files are in the patch. `snapshot` writes a worktree tree id (`write-tree` on a temp index) instead of `rev-parse HEAD`.
- **Why:** Review bug: `git diff HEAD` and HEAD-only snapshots miss untracked files and working-tree edits.
- **Tests:** 121 passed in `@maka-cloud/superagent` (`test:dist`)
- **Live:** n/a
- **Migrations / risk:** none. Snapshot `id` is now a tree SHA, not a commit SHA. No sqlite change.

## 2026-11-02 02:43 MST — cursor/superagent-real-loop-51be — e5d421ae1

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Same-commit changelog check (after this file exists, every `packages/cloud-superagent` commit and dirty tree must also touch CHANGELOG). Filled SHAs on the backfill. Standing user requirement.
- **Why:** User request: single append-only Super-agent changelog for traceability; fail CI if Super-agent changes without a CHANGELOG change.
- **Tests:** 119 passed in `@maka-cloud/superagent` (`test:dist`)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 02:41 MST — cursor/superagent-real-loop-51be — 3145ce8ca

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Lessons from dori: Done-signal contract + unpushed check (PR, issue, conversation); review receipts (`VERDICT: CLEAR\|BLOCK`) pinned to head SHA as a merge-approval precondition; owner `paused` state with verified stop, no W2 nudge, explicit resume; lead reports re-read live PR/CI and flag STALE; workers have no outbound user channel (`LeadPort` only). Architecture §18.
- **Why:** User request after the merge-gate task; study of [dori-superagent](https://github.com/sisyphuslabs/dori-superagent) README / harness / store / prompts / done-protocol / sessions / done-flow / pause / freshness / host-guard / heavy-slot.
- **Tests:** 117 passed in `@maka-cloud/superagent` (`test:dist`)
- **Live:** not run in this environment
- **Migrations / risk:** none. No sqlite `user_version` bump. New fields are worker JSON. `paused` is a new value of the existing `state` column.

## 2026-11-02 02:29 MST — cursor/superagent-real-loop-51be — d36e45e52

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Introduced this append-only changelog and the first branch-diff check. Backfilled #461/#462/#464/#465/#466, usable, real-loop, boxed loop, push-from-box diff, and timings.
- **Why:** Standing user requirement for traceability (do this first).
- **Tests:** changelog.test.ts on the branch
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 02:25 MST — cursor/superagent-real-loop-51be — 3fd50604e, 8aaaaaf8a

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Merge approval binds the PR head SHA; `PUT /pulls/N/merge` sends it; Checks/Statuses refuse failed, pending, all-skipped, or empty unless `mandate.allowNoCi`. W2 nudges once before escalate (`waiting` exempt). Drain coalesces a backlog into one handler call. Spawn admission caps live Instabox boxes and tenant spend.
- **Why:** User request after comparing [dori `mergeGate`](https://github.com/sisyphuslabs/dori-superagent/blob/main/src/harness.ts) and the W2/drain/admission follow-up.
- **Tests:** 97 passed in `@maka-cloud/superagent` (`test:dist`)
- **Live:** not run in this environment
- **Migrations / risk:** none (JSON fields only)

## 2026-11-02 02:15 MST — cursor/superagent-real-loop-51be — e9680184a

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Messages API input/output tokens and estimated USD on the in-memory usage object and the sqlite ledger. Empty GitHub scratch repos seed `main` when `MAKA_CLOUD_LOOP_SEED=1`.
- **Why:** User request: surface usage and support `raydocs/maka-loop-scratch`.
- **Tests:** package suite green (90+)
- **Live:** not run here. Earlier owner runs: Instabox-only boxed run ok ~14s; real model `claude-haiku-5-5` fixed `add.js`, in-box test ok ~18s, box destroyed (2026-11-02).
- **Migrations / risk:** none. Ledger rows stay `{tokens, usdMicros, wallMs}`.

## 2026-11-02 02:09 MST — cursor/superagent-real-loop-51be — 749221aa8

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Publish the box `git diff --cached` onto a clean host checkout. Per-phase timings and box exec stdout/stderr/exit on the CLI report.
- **Why:** User request: stop publishing host-written files; ship the tree that ran tests.
- **Tests:** package suite green
- **Live:** owner-verified on Instabox (2026-11-02)
- **Migrations / risk:** none

## 2026-11-02 02:02 MST — cursor/superagent-real-loop-51be — 001094a1a

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Clone / apply coder files / install / test run inside the sandbox. Host keeps tokens. FakeSandbox local-exec parity.
- **Why:** User request: the box must do the untrusted work, not `echo loop-verify`.
- **Tests:** package suite green
- **Live:** owner-verified on Instabox (2026-11-02)
- **Migrations / risk:** none

## 2026-11-02 01:52 MST — cursor/superagent-real-loop-51be — b958e7aea, 5741d451c

- **PR:** none (usable + real-loop compare URLs; ManagePullRequest was unavailable)
- **What:** Real loop, metrics harness, ModelJudge prefilter, live `HttpCoder` / `HttpGitHost`.
- **Why:** P0 real loop and P1 judge from the Super-agent architecture ([DSH article](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md) + `docs/fork/architecture/superagent.md`).
- **Tests:** package suite green
- **Live:** 22fdef92 Instabox smoke passed earlier on the usable line
- **Migrations / risk:** none

## 2026-11-02 01:32 MST — cursor/superagent-core-51be — 59135b688 — #462 (merged)

- **PR:** https://github.com/raydocs/maka-cloud/pull/462
- **What:** Super-agent core: event intake, subscription pass-through, Router, workers, watchdog, safety.
- **Why:** T34 implementation of the architecture ([DSH 000-philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md), `docs/fork/architecture/superagent.md`).
- **Tests:** CI on #462
- **Live:** n/a
- **Migrations / risk:** package-local sqlite `superagent.db` (not a cloud-server migration)

## 2026-11-02 01:31 MST — cursor/superagent-architecture-51be — afa38b76e — #461 (merged)

- **PR:** https://github.com/raydocs/maka-cloud/pull/461
- **What:** Super-agent architecture document (`docs/fork/architecture/superagent.md`).
- **Why:** T34 design.
- **Tests:** docs / policy
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 00:51 MST — cursor/superagent-usable-51be — 2236473bd, e15f1ceb7, d4650dca5, 22fdef92a, 520f204b8

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-usable-51be))
- **What:** Local loop, Instabox HTTP sandbox, EnvOrgSecrets, live-smoke (always destroy), smallest 2 vCPU / 4096 MiB, long-poll + DELETE 409 retry. Merged #461/#462.
- **Why:** P0 usable employee on one machine.
- **Tests:** local-loop + live-smoke (mocked HTTP) green
- **Live:** 22fdef92 Instabox smoke passed (2026-11-02)
- **Migrations / risk:** none

## 2026-11-01 21:44 MST — cursor/superagent-ledger-51be — 433fa0494, 913e22be5 — #466 (open)

- **PR:** https://github.com/raydocs/maka-cloud/pull/466
- **What:** Tenant usage ledger, evidence blocks, Org Secrets interface (T34 P4).
- **Why:** Architecture metering + evidence.
- **Tests:** ledger tests on that branch
- **Live:** n/a
- **Migrations / risk:** package-local `usage_events` (schema 2). Not a cloud-server migration.

## 2026-11-01 21:39 MST — cursor/superagent-workspaces-51be — 75be1ab11 — #465 (open)

- **PR:** https://github.com/raydocs/maka-cloud/pull/465
- **What:** Runners `WorkspaceStore` default and LayerFS four-gate harness (T34 P3).
- **Why:** Architecture workspace store.
- **Tests:** runners / superagent suites on that branch
- **Live:** n/a
- **Migrations / risk:** LayerFS live mount still throws

## 2026-11-01 21:35 MST — cursor/superagent-host-51be — 1132472ed — #464 (open)

- **PR:** https://github.com/raydocs/maka-cloud/pull/464
- **What:** In-process Super-agent on the host, duties Source, T33 stuck cards (T34 P2).
- **Why:** Architecture § host wiring.
- **Tests:** host / superagent suites on that branch
- **Live:** n/a
- **Migrations / risk:** none
