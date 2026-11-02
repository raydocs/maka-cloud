# Super-agent changelog

Append-only. Newest first. Times are America/Denver.
Every behavior change under `packages/cloud-superagent` must add an entry
in the same commit. `changelog.test.ts` fails the package suite when this
file is missing from the branch diff.

## 2026-11-02 02:26 MST — cursor/superagent-real-loop-51be — 3fd50604e, 8aaaaaf8a

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Merge approval binds the PR head SHA; `PUT /pulls/N/merge` sends it; Checks/Statuses refuse failed, pending, all-skipped, or empty unless `mandate.allowNoCi`. W2 nudges once before escalate (`waiting` exempt). Drain coalesces a backlog into one handler call. Spawn admission caps live Instabox boxes and tenant spend.
- **Why:** User request after comparing [dori `mergeGate`](https://github.com/sisyphuslabs/dori-superagent/blob/main/src/harness.ts) and the W2/drain/admission follow-up.
- **Tests:** 97 passed in `@maka-cloud/superagent` (`test:dist`)
- **Live:** not run in this environment
- **Migrations / risk:** none (JSON fields only)

## 2026-11-02 01:50 MST — cursor/superagent-real-loop-51be — e9680184a

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Messages API input/output tokens and estimated USD on the in-memory usage object and the sqlite ledger. Empty GitHub scratch repos seed `main` when `MAKA_CLOUD_LOOP_SEED=1`.
- **Why:** User request: surface usage and support `raydocs/maka-loop-scratch`.
- **Tests:** package suite green (90+)
- **Live:** not run here. Earlier owner runs: Instabox-only boxed run ok ~14s; real model `claude-haiku-5-5` fixed `add.js`, in-box test ok ~18s, box destroyed (2026-11-02).
- **Migrations / risk:** none. Ledger rows stay `{tokens, usdMicros, wallMs}`.

## 2026-11-02 01:40 MST — cursor/superagent-real-loop-51be — 749221aa8

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Publish the box `git diff --cached` onto a clean host checkout. Per-phase timings and box exec stdout/stderr/exit on the CLI report.
- **Why:** User request: stop publishing host-written files; ship the tree that ran tests.
- **Tests:** package suite green
- **Live:** owner-verified on Instabox (2026-11-02)
- **Migrations / risk:** none

## 2026-11-02 01:20 MST — cursor/superagent-real-loop-51be — 001094a1a

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-real-loop-51be))
- **What:** Clone / apply coder files / install / test run inside the sandbox. Host keeps tokens. FakeSandbox local-exec parity.
- **Why:** User request: the box must do the untrusted work, not `echo loop-verify`.
- **Tests:** package suite green
- **Live:** owner-verified on Instabox (2026-11-02)
- **Migrations / risk:** none

## 2026-11-02 00:50 MST — cursor/superagent-real-loop-51be — b958e7aea, 5741d451c

- **PR:** none (usable + real-loop compare URLs; ManagePullRequest was unavailable)
- **What:** Real loop, metrics harness, ModelJudge prefilter, live `HttpCoder` / `HttpGitHost`.
- **Why:** P0 real loop and P1 judge from the Super-agent architecture ([DSH article](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md) + `docs/fork/architecture/superagent.md`).
- **Tests:** package suite green
- **Live:** 22fdef92 Instabox smoke passed earlier on the usable line
- **Migrations / risk:** none

## 2026-11-02 01:32 MST — cursor/superagent-core-51be — #462 (merged)

- **PR:** https://github.com/raydocs/maka-cloud/pull/462
- **What:** Super-agent core: event intake, subscription pass-through, Router, workers, watchdog, safety.
- **Why:** T34 implementation of the architecture.
- **Tests:** CI on #462
- **Live:** n/a
- **Migrations / risk:** package-local sqlite `superagent.db` (not a cloud-server migration)

## 2026-11-02 01:31 MST — cursor/superagent-architecture-51be — #461 (merged)

- **PR:** https://github.com/raydocs/maka-cloud/pull/461
- **What:** Super-agent architecture document (`docs/fork/architecture/superagent.md`).
- **Why:** T34 design.
- **Tests:** docs / policy
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 — cursor/superagent-host-51be — #464 (open)

- **PR:** https://github.com/raydocs/maka-cloud/pull/464
- **What:** In-process Super-agent on the host, duties Source, T33 stuck cards (T34 P2).
- **Why:** Architecture § host wiring.
- **Tests:** host / superagent suites on that branch
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 — cursor/superagent-workspaces-51be — #465 (open)

- **PR:** https://github.com/raydocs/maka-cloud/pull/465
- **What:** Runners `WorkspaceStore` default and LayerFS four-gate harness (T34 P3).
- **Why:** Architecture workspace store.
- **Tests:** runners / superagent suites on that branch
- **Live:** n/a
- **Migrations / risk:** LayerFS live mount still throws

## 2026-11-02 — cursor/superagent-ledger-51be — #466 (open)

- **PR:** https://github.com/raydocs/maka-cloud/pull/466
- **What:** Tenant usage ledger, evidence blocks, Org Secrets interface (T34 P4).
- **Why:** Architecture metering + evidence.
- **Tests:** ledger tests on that branch
- **Live:** n/a
- **Migrations / risk:** package-local `usage_events` (schema 2). Not a cloud-server migration.

## 2026-11-02 — cursor/superagent-usable-51be

- **PR:** none ([compare](https://github.com/raydocs/maka-cloud/compare/main...cursor/superagent-usable-51be))
- **What:** Local loop, Instabox HTTP sandbox, EnvOrgSecrets, live-smoke (always destroy), smallest 2 vCPU / 4096 MiB, long-poll + DELETE 409 retry. Merged #461/#462.
- **Why:** P0 usable employee on one machine.
- **Tests:** local-loop + live-smoke (mocked HTTP) green
- **Live:** 22fdef92 Instabox smoke passed (2026-11-02)
- **Migrations / risk:** none
