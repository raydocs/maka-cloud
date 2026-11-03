# Super-agent changelog

Append-only. Newest first. Times are America/Denver, taken from the
first listed SHA's committer date (`git show -s --format=%cI`).
Every behavior change under `packages/cloud-superagent` must add an entry
in the same commit. `changelog.test.ts` fails the package suite when this
file is missing from the branch diff, when a later Super-agent commit
omits it, when uncommitted Super-agent edits leave it unchanged, or when
a heading time is more than five minutes off that SHA's committer date.

## 2026-11-03 02:47 MST — superagent/harness-analysis — 747470a90

- **What:** `tool-loading.test` reads the `load_tools` wire entry through a checked local instead of `tools[2]?.input_schema` cast to an object (biome `noUnsafeOptionalChaining`, which `npm run lint` in CI rejects). Correction to the entry below: its test split was `tool-loading.test` 14 and `prompt-cache.test` 5 (23 in all).
- **Why:** keep the Linux `checks` lint step green.
- **Tests:** `tool-loading.test` 14 passed; `biome lint` and `biome format` clean on `packages/cloud-superagent` and `docs/superagent`.
- **Live:** n/a
- **Migrations / risk:** none (test only).

## 2026-11-03 02:46 MST — superagent/coder-tool-loop — 311089c47

- **What:** multi-turn coder behind `MAKA_CLOUD_CODER_LOOP=1` (default off; needs `MAKA_CLOUD_LOOP_LIVE=1` and a key like the single-shot coder, which stays the default and the fallback when there is no box workspace). `ToolLoopCoder` (`coder-loop.ts`) gives the model `read_file`, `list_files`, `search`, `apply_patch` (unified diff through `git apply`), `write_file` and `run`, each a command in the box checkout (FakeSandbox or Instabox through `BoxWorkspace`), and loops read → edit → run until the configured test command exits 0 or a bound trips: 24 turns, 20 minutes, `autonomy.ts` rules (3 identical calls → nudge text after the tool results, 6 → stop; 3 turns with no visible output → stop; a stream silent for `streamSilenceMs` → dropped and the same body retried, 3 at most; a retryable provider error → same provider, same body, 1/2/4 s backoff). Over `compactAtTokens` the loop starts a fresh conversation from a 16k `compactHistory` summary instead of editing history. Every request is checked with `recordCacheBreak`; `toAnthropicLoopBody` keeps `tools` frozen, puts `cache_control` on the system block and top-level automatic caching on the tail, and passes content blocks (thinking included) back unchanged. `MAKA_CLOUD_TOOL_LOADING=1` starts with `read_file` + `run` + `load_tools` and loads the rest through `tool-loading.ts`. `AnthropicLoopModel` (`coder-model.ts`) streams `/v1/messages` with the key in the `x-api-key` header only and prices input, output, cache read and cache write per model. `CodingLoopHandler` passes the box workspace and test command to the coder, records a `coder-loop` evidence line, and hands a stopping incident and the autonomy counters to the runtime. `prompt-cache.ts` messages may carry content blocks; `BoxWorkspace.run` takes stdin. Also adds `docs/superagent/PROGRESS.md` (`34370de9b`).
- **Why:** the single request that returned file JSON could not read, run tests, or try again. The bounds and the append-only request were defined but not attached to a loop.
- **Tests:** `coder-loop.test` 15 passed: normal read/patch/test run, 3 identical calls nudge and 6 stop, 3 empty turns stop, tool loading keeps `tools` byte-identical, an unloaded tool is refused, silent stream retry, provider retry and stop, compaction into a fresh conversation, fallback without a box, SSE parsing, HTTP client headers, env switch, and a worker that pushes after the loop fixed its box. Every scripted run asserts each request body extends the previous one. Package suite on macOS: 323 of 325 passed; `box-daemon` RSS reads `/proc` (Linux only) and the uncommitted-CHANGELOG check fails until this commit.
- **Live:** n/a (no `ANTHROPIC_API_KEY` in this environment).
- **Migrations / risk:** none. Flag default off; no `user_version` bump; no server or deploy change.

## 2026-11-03 02:37 MST — superagent/harness-analysis — b54de2302

- **What:** on-demand tool loading and a shared-daemon bench. `tool-loading.ts`: a `ToolCatalog` (core tools plus a client-side `load_tools`), `firstTurnRequest` (turn one carries only core tools; the system prompt ends with a stable index of deferred tools), `toAnthropicTools` (every tool declared in `tools[]` from the first request, deferred ones with `defer_loading: true`, never `cache_control` on them), and `handleLoadTools` (exact names or a keyword query, at most 5; loaded tools go onto `appendedTools` through `loadTool`; the `tool_result` carries `tool_reference` blocks that the API expands inline). It throws if a load would break the cache prefix. `daemon-bench.ts` / `scripts/daemon-bench.mjs` (`npm run daemon-bench`): one `BoxDaemon` process hosting N worker sessions against N processes with one session each; RSS from `/proc` (macOS falls back to `ps -o rss`), cold start, attach, wake and wake-after-reap, p50/p95. Nothing calls either module yet; the coder loop wires the catalog in behind its own flag.
- **Why:** turn one should not pay for every tool schema, and a mid-session load must not rewrite the `tools` bytes (Anthropic renders tools → system → messages, so a changed tools array drops the whole cache). The bench checks the per-session cost the box daemon is built on.
- **Tests:** `tool-loading.test` 13, `daemon-bench.test` 4 and `prompt-cache.test` 6 passed (macOS, Node 26). The bench test asserts report shape only, no timing or memory thresholds.
- **Live:** bench on Linux (Docker Desktop VM, `node:22-bookworm-slim`, Node 22.23.4, kernel 7.0.14-linuxkit aarch64, 12 CPUs, 8 GB), 15 reps, FakeSandbox `exec` as the per-wake work. Total RSS shared vs per-process: N=1 46.2 vs 46.2 MiB, N=4 46.5 vs 185.0, N=8 46.8 vs 369.9, N=16 47.3 vs 739.8 MiB (about 0.07 MiB per extra shared session, about 46 MiB per extra process). Cold start p50 at N=16: shared 18.5 ms, per-process 31.5 ms (all 16 ready: 51.9 ms p50, 94.0 ms p95). Attach to a live daemon 0.1 ms. Wake of a live idle worker about 5 ms in both modes. Wake after reap: shared 1.1 ms p50 (detach, attach, wake), per-process 22.5 ms p50 (respawn). The work is a shell exec, not a model turn; sessions hold no runtime state, so real per-worker heap growth is not measured.
- **Migrations / risk:** none. No `user_version` bump, no flag turned on, no server or deploy change.

## 2026-11-02 18:37 MST — cursor/superagent-wiring-51be — 303d685eb

- **What:** merge the updated `cursor/superagent-decisions-policy-51be` tip (`3c7049b04`), which already contains scheduler, intake, BYOM, duplex, lessons, and review-verify. Kept decision-card wiring (`recordFromCardResolution`, must-ask rows on `statusSnapshot.decisions`), host flags default off, and `CodingLoopHandler` on `DuplexLoop`. Speculative still runs only after a cross-source merge misses. sqlite `user_version` stays 2.
- **Why:** The linearized tip moved after the first merge of #480. Bring that tip in with git merge only.
- **Tests:** `@maka-cloud/superagent` `test:dist` 292 passed. Host config, feature-flag, and stack suites passed.
- **Live:** n/a
- **Migrations / risk:** none. No `user_version` bump.

## 2026-11-02 18:28 MST — cursor/superagent-wiring-51be — 4212b2578

- **What:** Wire the second batch into one runtime. `resolveDecisionCard` calls `recordFromCardResolution` (`accept` → decided, `reject` → refused, `archive` leaves no standing row). Must-ask rows are copied onto `statusSnapshot.decisions` and still listed on `mustAskPending`. An exact ledger hit does not open another escalation card. Speculative outbound and a Safety hold still produce one card at most. Host `startStack` passes BYOM, the peer-review client, the `/version` probe (skipped when no endpoint is configured), the weekly sweep timer, and rules-file load plus hot reload, each behind its flag and default off. Constructors do not read env. `CodingLoopHandler` runs through `DuplexLoop`; pause still refuses until the box is verified stopped. sqlite `user_version` stays 2.
- **Why:** The feature branches stay default-off until this wiring turns them on together.
- **Tests:** `@maka-cloud/superagent` wiring suite and `@maka-cloud/host` feature-flag suite.
- **Live:** n/a
- **Migrations / risk:** none. No `user_version` bump. No server, deploy, secret, or billing change.

## 2026-11-02 18:15 MST — cursor/superagent-decisions-policy-51be — ef272e026

- **PR:** [#480](https://github.com/raydocs/maka-cloud/pull/480)
- **What:** merge: review-verify format-fix into Super-agent decisions-policy. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack without rebase/force-push.
- **Tests:** 288 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:15 MST — cursor/superagent-review-verify-51be — fd8e03e85

- **PR:** [#479](https://github.com/raydocs/maka-cloud/pull/479)
- **What:** merge: learning-review format-fix into Super-agent review-verify. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack without rebase/force-push.
- **Tests:** 263 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:15 MST — cursor/superagent-learning-review-51be — 352c8dd60

- **PR:** [#478](https://github.com/raydocs/maka-cloud/pull/478)
- **What:** merge: watchdog-duplex format-fix into Super-agent learning-review. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack without rebase/force-push.
- **Tests:** 245 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:15 MST — cursor/superagent-watchdog-duplex-51be — dc007def4

- **PR:** [#476](https://github.com/raydocs/maka-cloud/pull/476)
- **What:** merge: origin/cursor/superagent-watchdog-duplex-51be format-fix (`9adc07fd2`) into the linearized watchdog-duplex. Same biome output as the stack format-fix. Keep every CHANGELOG entry, newest first.
- **Why:** Remote landed a parallel format fix; git merge only, no rebase/force-push.
- **Tests:** format:check clean; 233 tests already passed on the parent
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:14 MST — cursor/superagent-watchdog-duplex-51be — 50f17de2c

- **PR:** [#476](https://github.com/raydocs/maka-cloud/pull/476)
- **What:** merge: byom-spec format-fix (including remote #474) into Super-agent watchdog-duplex. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack without rebase/force-push.
- **Tests:** 233 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:14 MST — cursor/superagent-byom-spec-51be — ff22aa7d3

- **PR:** [#475](https://github.com/raydocs/maka-cloud/pull/475)
- **What:** merge: intake-merge format-fix (including remote #474) into Super-agent byom-spec. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack without rebase/force-push.
- **Tests:** 223 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:14 MST — cursor/superagent-intake-merge-51be — 841f5bae1

- **PR:** [#477](https://github.com/raydocs/maka-cloud/pull/477)
- **What:** merge: scheduler-router format-fix (including remote #474) into Super-agent intake-merge. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack without rebase/force-push.
- **Tests:** 194 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:14 MST — cursor/superagent-scheduler-router-51be — 2b177c2d8

- **PR:** [#474](https://github.com/raydocs/maka-cloud/pull/474)
- **What:** merge: origin/cursor/superagent-scheduler-router-51be format-fix (`5e8282663`) with the local format-fix. Same biome output; both CHANGELOG entries kept.
- **Why:** Remote landed a parallel format fix; git merge only, no rebase/force-push.
- **Tests:** format:check clean
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:11 MST — cursor/superagent-decisions-policy-51be — e861d144e

- **PR:** [#480](https://github.com/raydocs/maka-cloud/pull/480)
- **What:** merge: cursor/superagent-review-verify-51be format fix into Super-agent decisions-policy. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack.
- **Tests:** 288 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:10 MST — cursor/superagent-review-verify-51be — 14619a92c

- **PR:** [#479](https://github.com/raydocs/maka-cloud/pull/479)
- **What:** merge: cursor/superagent-learning-review-51be format fix into Super-agent review-verify. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack.
- **Tests:** 263 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:10 MST — cursor/superagent-learning-review-51be — 25fb6cb27

- **PR:** [#478](https://github.com/raydocs/maka-cloud/pull/478)
- **What:** merge: cursor/superagent-watchdog-duplex-51be format fix into Super-agent learning-review. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack.
- **Tests:** 245 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:10 MST — cursor/superagent-watchdog-duplex-51be — 710908087

- **PR:** [#476](https://github.com/raydocs/maka-cloud/pull/476)
- **What:** merge: cursor/superagent-byom-spec-51be format fix into Super-agent watchdog-duplex. Kept applyWatchdogCommand and preempt coalesce. Biome format now clean. Keep every CHANGELOG entry, newest first.
- **Why:** Carry the Linux format:check fix through the linearized stack.
- **Tests:** 233 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:09 MST — cursor/superagent-wiring-51be — 6b5713fae

- **What:** merge `cursor/superagent-decisions-policy-51be` (#480) into the wiring branch. Decision ledger, must-ask, and routing rules sit beside the scheduler, escalation cards, BYOM, duplex, lessons, and release verify. One `applyAction` gates must-ask, Safety, and speculative outbound, so a speculative block does not open a second card. sqlite `user_version` stays 2.
- **Why:** Linearize batch 2 in order (#479 then #480).
- **Tests:** conflict resolution only; wiring tests follow in the next commit.
- **Live:** n/a
- **Migrations / risk:** none. No `user_version` bump.

## 2026-11-02 18:09 MST — cursor/superagent-byom-spec-51be — d6ada5292

- **PR:** [#475](https://github.com/raydocs/maka-cloud/pull/475)
- **What:** merge: cursor/superagent-intake-merge-51be format fix into Super-agent byom-spec. Biome format now clean. Keep every CHANGELOG entry, newest first. This branch is now a descendant of the formatted #477.
- **Why:** Carry the Linux format:check fix through the linearized stack.
- **Tests:** 223 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:09 MST — cursor/superagent-intake-merge-51be — 5f6a49fae

- **PR:** [#477](https://github.com/raydocs/maka-cloud/pull/477)
- **What:** merge: cursor/superagent-scheduler-router-51be format fix into Super-agent intake-merge. Biome format now clean. Keep every CHANGELOG entry, newest first. This branch is now a descendant of the formatted #474.
- **Why:** Carry the Linux format:check fix through the linearized stack.
- **Tests:** 194 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:09 MST — cursor/superagent-scheduler-router-51be — 5e8282663

- **PR:** [#474](https://github.com/raydocs/maka-cloud/pull/474)
- **What:** Biome format the scheduler / intake / recall / runtime / WorkStatus files so CI `format:check` passes after the main merge.
- **Why:** CI `test` on `227e6f9c6` failed at Check formatting (10 files).
- **Tests:** biome check clean on the 10 files
- **Live:** n/a
- **Migrations / risk:** none. Format only.

## 2026-11-02 18:09 MST — cursor/superagent-watchdog-duplex-51be — 9adc07fd2

- **PR:** [#476](https://github.com/raydocs/maka-cloud/pull/476)
- **What:** biome-format the linearized Super-agent files CI rejected after the #475 merge (intake/scheduler/judge-client/runtime and their tests). No behavior change.
- **Why:** `npm run format:check` failed on `88ffc5f36`; the merge brought long lines biome wraps.
- **Tests:** `biome format` on the 9 reported files; `format:check` clean
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:08 MST — cursor/superagent-scheduler-router-51be — 3524bb276

- **PR:** [#474](https://github.com/raydocs/maka-cloud/pull/474)
- **What:** biome format on scheduler/intake/recall/runtime/judge-client and the queue-row web line so Linux `format:check` passes. No behavior change.
- **Why:** CI `test` job failed on formatting after the main merge, not on tests.
- **Tests:** `@maka-cloud/superagent` suite re-run after format
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 18:00 MST — cursor/superagent-wiring-51be — d92ec7bfc

- **What:** merge `cursor/superagent-review-verify-51be` (#479) into the wiring branch. Release verify and the weekly sweep stay off unless the host passes them. Peer-review stats and release-verify records clone with the worker. sqlite `user_version` stays 2.
- **Why:** Linearize batch 2 in order (#478 then #479).
- **Tests:** conflict resolution only; suites run after the decisions tip merges.
- **Live:** n/a
- **Migrations / risk:** none. No `user_version` bump.

## 2026-11-02 17:59 MST — cursor/superagent-wiring-51be — e3c3de629

- **What:** merge `cursor/superagent-learning-review-51be` (#478) into the wiring branch. Mistake book and cross-model review stay off unless the host passes `learning` / `peerReview`. Scheduler, BYOM, duplex, and pause verification stay.
- **Why:** Linearize batch 2 in order. sqlite `user_version` stays 2.
- **Tests:** conflict resolution only; suites run after the remaining tips merge.
- **Live:** n/a
- **Migrations / risk:** none. No `user_version` bump.

## 2026-11-02 17:59 MST — cursor/superagent-decisions-policy-51be — 8df73c97e

- **PR:** [#480](https://github.com/raydocs/maka-cloud/pull/480)
- **What:** merge: cursor/superagent-review-verify-51be (#479) into Super-agent decisions-policy. Kept decisions book / must-ask / `superagent.rules.json` and every earlier stack hook. `statusSnapshot.decisions` stays escalate cards; must-ask uses `mustAskPending` / `decisionCitations`. Keep every CHANGELOG entry, newest first. This branch is now a descendant of #479 and below.
- **Why:** One-pass linearization so #474 → #477 → #475 → #476 → #478 → #479 → #480 can merge in order without re-conflicts.
- **Tests:** 288 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only. New features stay default-off.

## 2026-11-02 17:57 MST — cursor/superagent-wiring-51be — 859f44d78

- **What:** merge `cursor/superagent-watchdog-duplex-51be` (#476) into the wiring branch. Kept scheduler, intake, BYOM, and speculative fields next to duplex `seenEventIds` / conversational watchdog status. Pause still refuses until the box is verified stopped.
- **Why:** Linearize batch 2 onto the wiring branch in the agreed order. sqlite `user_version` stays 2.
- **Tests:** conflict resolution only; suites run after the remaining tips merge.
- **Live:** n/a
- **Migrations / risk:** none. No `user_version` bump.

## 2026-11-02 17:55 MST — cursor/superagent-wiring-51be — a8560951c

- **What:** merge `cursor/superagent-byom-spec-51be` (#475) into the wiring branch (already #477, which contains #474). Kept the scheduler queue and graded escalation, and kept BYOM / speculative spawn. Speculative runs only after a cross-source merge misses. `spawn` is async so a paired device can be chosen at admission. sqlite `user_version` stays 2.
- **Why:** #480 does not yet contain the other batch-2 branches. The wiring branch merges those tips in order and will merge newer tips later.
- **Tests:** conflict resolution only; suites run after the remaining tips merge.
- **Live:** n/a
- **Migrations / risk:** none. No `user_version` bump.
## 2026-11-02 17:53 MST — cursor/superagent-review-verify-51be — d2f66c8f1

- **PR:** [#479](https://github.com/raydocs/maka-cloud/pull/479)
- **What:** merge: cursor/superagent-learning-review-51be (#478) into Super-agent review-verify. Kept review hardening / release-verify / sweep (default off) and every earlier stack hook. Keep every CHANGELOG entry, newest first. This branch is now a descendant of #478 and below.
- **Why:** One-pass linearization so #474 → #477 → #475 → #476 → #478 → #479 → #480 can merge in order without re-conflicts.
- **Tests:** 263 `@maka-cloud/superagent` tests after dropping a leftover merge marker
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only. New features stay default-off.

## 2026-11-02 17:52 MST — cursor/superagent-learning-review-51be — 1fc322d53

- **PR:** [#478](https://github.com/raydocs/maka-cloud/pull/478)
- **What:** merge: cursor/superagent-watchdog-duplex-51be (#476) into Super-agent learning-review. Kept mistake-book/peer-review (default off) and watchdog/BYOM/scheduler/graph/BoxPool/autonomy. Keep every CHANGELOG entry, newest first. This branch is now a descendant of #476 and below.
- **Why:** One-pass linearization so #474 → #477 → #475 → #476 → #478 → #479 → #480 can merge in order without re-conflicts.
- **Tests:** 245 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only. Learning and peer review stay default-off.

## 2026-11-02 17:51 MST — cursor/superagent-watchdog-duplex-51be — 7f0174146

- **PR:** [#476](https://github.com/raydocs/maka-cloud/pull/476)
- **What:** merge: cursor/superagent-byom-spec-51be (#475) into Super-agent watchdog-duplex. Kept conversational watchdog/duplex and BYOM/scheduler/graph/BoxPool/autonomy. Keep every CHANGELOG entry, newest first. This branch is now a descendant of #475, #477, #474, and main.
- **Why:** One-pass linearization so #474 → #477 → #475 → #476 → #478 → #479 → #480 can merge in order without re-conflicts.
- **Tests:** 233 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only. New features stay default-off.

## 2026-11-02 17:49 MST — cursor/superagent-byom-spec-51be — 70bbaeba1

- **PR:** [#475](https://github.com/raydocs/maka-cloud/pull/475)
- **What:** merge: cursor/superagent-intake-merge-51be (#477) into Super-agent byom-spec. Kept BYOM/speculative (default off) and scheduler/graph/escalate/BoxPool/autonomy. Keep every CHANGELOG entry, newest first. This branch is now a descendant of #477, #474, and main.
- **Why:** One-pass linearization so #474 → #477 → #475 → #476 → #478 → #479 → #480 can merge in order without re-conflicts.
- **Tests:** 223 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only. BYOM and speculative stay default-off.

## 2026-11-02 17:46 MST — cursor/superagent-intake-merge-51be — ca10972ec

- **PR:** [#477](https://github.com/raydocs/maka-cloud/pull/477)
- **What:** merge: cursor/superagent-scheduler-router-51be (#474) into Super-agent intake-merge. Kept event-graph/escalate and BoxPool/autonomy. Keep every CHANGELOG entry, newest first. This branch is now a descendant of #474 and main.
- **Why:** One-pass linearization so #474 → #477 → #475 → #476 → #478 → #479 → #480 can merge in order without re-conflicts.
- **Tests:** 194 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only. Escalation stays opt-in; merge default observe.

## 2026-11-02 17:45 MST — cursor/superagent-scheduler-router-51be — 4c5cb40e3

- **PR:** [#474](https://github.com/raydocs/maka-cloud/pull/474)
- **What:** merge: origin/main (`7feb8b4cf`, #473) into Super-agent scheduler-router. Kept scheduler/intake documents and BoxPool/autonomy hooks. Shared-box `worker_cap` still ignores at ingest; `box_cap`/`spend_cap` still queue. Keep every CHANGELOG entry, newest first. This branch is now a descendant of main.
- **Why:** One-pass linearization so #474 → #477 → #475 → #476 → #478 → #479 → #480 can merge in order without re-conflicts.
- **Tests:** 177 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only. New features stay default-off.

## 2026-11-02 17:19 MST — cursor/superagent-bounded-autonomy-51be — db85c62a7

- **PR:** [#473](https://github.com/raydocs/maka-cloud/pull/473)
- **What:** merge: cursor/superagent-shared-box-51be (#472) into Super-agent bounded-autonomy. Kept BoxPool and bounded autonomy / prompt-cache. Keep every CHANGELOG entry, newest first. This branch is now a descendant of #472, #471, #470, and main.
- **Why:** Linearize the remaining stack so merging #470 → #471 → #472 → #473 cannot re-dirty the next PR. Linux-only gates.
- **Tests:** 156 `@maka-cloud/superagent` tests passed after the merge
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only.

## 2026-11-02 17:18 MST — cursor/superagent-shared-box-51be — 4bd2c5157

- **PR:** [#472](https://github.com/raydocs/maka-cloud/pull/472)
- **What:** merge: cursor/superagent-real-loop-51be (#471) into Super-agent shared-box. Keep every CHANGELOG entry, newest first. This branch is now a descendant of #471, #470, and main.
- **Why:** Linearize the remaining stack so merging #470 → #471 → #472 → #473 cannot re-dirty the next PR. Linux-only gates.
- **Tests:** conflict resolution only; prior head `46f778a32`
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 17:18 MST — cursor/superagent-real-loop-51be — 76fadef57

- **PR:** [#471](https://github.com/raydocs/maka-cloud/pull/471)
- **What:** merge: cursor/superagent-usable-51be (#470) into Super-agent real-loop Keep every CHANGELOG entry, newest first.
- **Why:** Linearize the remaining stack so merging #470 → #471 → #472 → #473 cannot re-dirty the next PR. Linux-only gates.
- **Tests:** conflict resolution only; prior head `1d535cfa0`
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 17:17 MST — cursor/superagent-usable-51be — 18afa3e03

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** merge: origin/main (#466 c7fc337d9) into Super-agent usable

Keep every CHANGELOG entry, newest first.
- **Why:** Linearize the remaining stack so merging #470 → #471 → #472 → #473 cannot re-dirty the next PR. Linux-only gates.
- **Tests:** conflict resolution only; prior head `e925c75a8`
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:53 MST — cursor/superagent-bounded-autonomy-51be — 1ab088ce2

- **PR:** [#473](https://github.com/raydocs/maka-cloud/pull/473)
- **What:** Merge `origin/main` `e83340599` (PR #465 Super-agent workspaces) into Super-agent bounded-autonomy. CHANGELOG conflicted; both sides kept, newest first.
- **Why:** #465 landed on main; remaining stack PRs needed main forwarded. Linux-only gates.
- **Tests:** conflict resolution only; prior head `f1b17ed26`
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:53 MST — cursor/superagent-shared-box-51be — fa630a965

- **PR:** [#472](https://github.com/raydocs/maka-cloud/pull/472)
- **What:** Merge `origin/main` `e83340599` (PR #465 Super-agent workspaces) into Super-agent shared-box. CHANGELOG conflicted; both sides kept, newest first.
- **Why:** #465 landed on main; remaining stack PRs needed main forwarded. Linux-only gates.
- **Tests:** conflict resolution only; prior head `e5ad77db4`
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:53 MST — cursor/superagent-real-loop-51be — b64fda3f6

- **PR:** [#471](https://github.com/raydocs/maka-cloud/pull/471)
- **What:** Merge `origin/main` `e83340599` (PR #465 Super-agent workspaces) into Super-agent real-loop. CHANGELOG conflicted; both sides kept, newest first.
- **Why:** #465 landed on main; remaining stack PRs needed main forwarded. Linux-only gates.
- **Tests:** conflict resolution only; prior head `393fc9b74`
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:53 MST — cursor/superagent-usable-51be — 9238f1d88

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Merge `origin/main` `e83340599` (PR #465 Super-agent workspaces) into Super-agent usable. CHANGELOG conflicted; both sides kept, newest first.
- **Why:** #465 landed on main; remaining stack PRs needed main forwarded. Linux-only gates.
- **Tests:** conflict resolution only; prior head `46c3b8579`
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:53 MST — cursor/superagent-ledger-51be — cdec5b8b5

- **PR:** [#466](https://github.com/raydocs/maka-cloud/pull/466)
- **What:** Merge `origin/main` `e83340599` (PR #465 Super-agent workspaces) into Super-agent ledger. CHANGELOG conflicted; both sides kept, newest first.
- **Why:** #465 landed on main; this PR was DIRTY. User asked to merge main forward and report Linux-green SHAs.
- **Tests:** conflict resolution only; prior head `9a9f8ba87` already had Linux CI green or in progress
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:02 MST — cursor/superagent-bounded-autonomy-51be — 3f45589ac

- **PR:** [#473](https://github.com/raydocs/maka-cloud/pull/473)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent bounded-autonomy. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus incoming entries kept.
- **Why:** #464 landed on main. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `6749c204b` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:02 MST — cursor/superagent-shared-box-51be — eda85c026

- **PR:** [#472](https://github.com/raydocs/maka-cloud/pull/472)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent shared-box. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus incoming entries kept.
- **Why:** #464 landed on main. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `64bf658ec` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:02 MST — cursor/superagent-real-loop-51be — f94757948

- **PR:** [#471](https://github.com/raydocs/maka-cloud/pull/471)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent real-loop. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus incoming entries kept.
- **Why:** #464 landed on main. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `f70f70d72` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:02 MST — cursor/superagent-usable-51be — 7ca1e8eca

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent usable. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus incoming entries kept.
- **Why:** #464 landed on main. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `ac67c930c` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:01 MST — cursor/superagent-ledger-51be — 56d1a02e4

- **PR:** [#466](https://github.com/raydocs/maka-cloud/pull/466)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent ledger. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus #464's changelog entry kept.
- **Why:** #464 landed on main. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `708b62670` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:00 MST — cursor/superagent-workspaces-51be — 3dc73baac

- **PR:** [#465](https://github.com/raydocs/maka-cloud/pull/465)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent workspaces. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus #464's changelog entry kept.
- **Why:** #464 landed on main; this PR was DIRTY. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `19bf5136f` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 14:54 MST — cursor/superagent-usable-51be — b792005a4

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** No code change. Retrigger CI after classifying the `android` failure on `c5f9465b4`.
- **Why:** Fork cloud-mobile `android` on run 41521663761 job 125538961097 failed at "Run the flows on an Android emulator" with no Maestro `e2e-output` (artifact was only `stack.log`). Annotation: `/usr/bin/sh` exit 1. Same wave: #466 and #471 `android` succeeded; this PR's `test` / `real-accounts` / `rehearsal` / `cloud-web` / `checks` succeeded. Emulator flake, not the usable build. Prior `test` on `e6234fce7` was upstream desktop e2e `workhub-layout` (`aria-haspopup` listbox vs dialog); later head green.
- **Tests:** none (docs / retrigger)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 14:53 MST — cursor/superagent-bounded-autonomy-51be — 2f921ab8d

- **PR:** [#473](https://github.com/raydocs/maka-cloud/pull/473)
- **What:** `checkAgentIsolation` retries an unfinished filecap or setid listing (`unchecked`) up to three probes. A `found` setuid/capability, a missing fact, or any other isolation problem still fails on the first probe. Same assertions.
- **Why:** CI `real-accounts` on #473 head `f64164fcd` run 41521670607: `the agent account reads and writes the nested files of a checkout, and of a base check` failed `agent_filecaps` (or they could not be listed). Same test on #471 `e174aff2e` failed `agent_setid` at the same minute. Isolation unit tests in the same job passed. Sibling #472 `real-accounts` succeeded. Walk of `/` under parallel real-account load, not MakaEngine.
- **Tests:** cloud-runners `agent-user` — unfinished listing recovers on retry; `found` and mixed problems do not retry; file-caps cases unchanged
- **Live:** n/a
- **Migrations / risk:** none. Retry only `unchecked` listings. Production boxes with a real privileged program still refuse immediately.

## 2026-11-02 14:53 MST — cursor/superagent-real-loop-51be — 033d5b5dd

- **PR:** [#471](https://github.com/raydocs/maka-cloud/pull/471)
- **What:** `checkAgentIsolation` retries an unfinished filecap or setid listing (`unchecked`) up to three probes. A `found` setuid/capability, a missing fact, or any other isolation problem still fails on the first probe. Same assertions.
- **Why:** CI `real-accounts` on #471 head `e174aff2e` run 41521663328: `the agent account reads and writes the nested files of a checkout, and of a base check` failed `agent_setid` (or they could not be listed). Same test on #473 `f64164fcd` failed `agent_filecaps` at the same minute. Isolation unit tests in the same job passed. Sibling #464–#466/#470/#472 `real-accounts` succeeded. Walk of `/` under parallel real-account load, not MakaEngine. #466 `7f900d01c` / #470 `e6234fce7` `test` failures were upstream desktop e2e flakes (later heads green). #470 android emulator flow failed with no Maestro output; #466/#471 android succeeded — self-hosted/emulator flake, not this change.
- **Tests:** cloud-runners `agent-user` — unfinished listing recovers on retry; `found` and mixed problems do not retry; file-caps cases unchanged
- **Live:** n/a
- **Migrations / risk:** none. Retry only `unchecked` listings. Production boxes with a real privileged program still refuse immediately.

## 2026-11-02 14:10 MST — cursor/superagent-decisions-policy-51be — dc4783aa1

- **PR:** none (base `cursor/superagent-real-loop-51be`)
- **What:** Decision ledger (human-only decided/refused, tenant+repo, exact match auto-applies, fuzzy hints only). Must-ask whitelist (delete/deploy/spend/outbound/direction/secrets/permissions/migration/force-push); tenant may tighten, never loosen; always-ask delete_data / rotate_secrets / spend. Declarative `superagent.rules.json` with schema, hot reload, event envelope; miss falls through to the existing Router. Progress cites ledger ids. #477 card adapters (`cardDraftFromMustAsk`, `recordFromCardResolution`) without taking `statusSnapshot.decisions`.
- **Why:** Paid cloud employee: ask once, remember, do not re-ask; irreversible actions always wait; routing rules as a file.
- **Tests:** `@maka-cloud/superagent` typecheck + `node --test` + biome on the package
- **Live:** n/a
- **Migrations / risk:** none. No sqlite `user_version` bump. Ledger is memory + optional JSON + existing audit rows.

## 2026-11-02 14:10 MST — cursor/superagent-review-verify-51be — 9f917ea19

- **PR:** [#479](https://github.com/raydocs/maka-cloud/pull/479)
- **What:** Harden cross-model review: isolated read-only contract (diff+repo only; write/network/secrets forced false; secret-shaped env stripped and proven not to reach the reviewer), prompt and parse drop style-only findings, default max rounds 3, ledger records review duration / token share / issues reported / issues fixed. After merge+publish, optional `/version` probe confirms the live SHA contains the merge commit before Done; timeout or mismatch marks the worker stuck and raises a watchdog card. Optional weekly sweep (default off) opens a cleanup PR for duplicates / temp patches / leftover code / diary docs and never pushes trunk. Tests use fakes only.
- **Why:** Follow-up to the learning/review hook: isolate the reviewer, verify the live deploy, and keep a weekly cleanup lane without touching parallel branches.
- **Tests:** `@maka-cloud/superagent` typecheck + `node --test` + biome format
- **Live:** n/a
- **Migrations / risk:** none. Defaults false. No server/deploy/billing change. No sqlite `user_version` bump.

## 2026-11-02 13:42 MST — cursor/superagent-real-loop-51be — 1157d2ea8

- **PR:** [#471](https://github.com/raydocs/maka-cloud/pull/471)
- **What:** Removed leftover `AGENTS.md` conflict markers on the `asf-license-headers` fork-delta row. Kept both `docs/superagent` and `scripts/cloud-maka-engine-boundary.mjs` exclusions.
- **Why:** The main-merge commit resolved the T34/MakaEngine table but left a second hunk at line 65.
- **Tests:** none (docs table only)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 13:42 MST — cursor/superagent-bounded-autonomy-51be — 20b7ba5cc

- **PR:** [#473](https://github.com/raydocs/maka-cloud/pull/473)
- **What:** Removed leftover `AGENTS.md` conflict markers on the `asf-license-headers` fork-delta row. Kept both `docs/superagent` and `scripts/cloud-maka-engine-boundary.mjs` exclusions.
- **Why:** The main-merge commit resolved the T34/MakaEngine table but left a second hunk at line 65.
- **Tests:** none (docs table only)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 13:42 MST — cursor/superagent-shared-box-51be — cf89368a5

- **PR:** [#472](https://github.com/raydocs/maka-cloud/pull/472)
- **What:** Removed leftover `AGENTS.md` conflict markers on the `asf-license-headers` fork-delta row. Kept both `docs/superagent` and `scripts/cloud-maka-engine-boundary.mjs` exclusions.
- **Why:** The main-merge commit resolved the T34/MakaEngine table but left a second hunk at line 65.
- **Tests:** none (docs table only)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 13:42 MST — cursor/superagent-usable-51be — 6bdd4b03f

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Removed leftover `AGENTS.md` conflict markers on the `asf-license-headers` fork-delta row. Kept both `docs/superagent` and `scripts/cloud-maka-engine-boundary.mjs` exclusions.
- **Why:** The main-merge commit resolved the T34/MakaEngine table but left a second hunk at line 65.
- **Tests:** none (docs table only)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 13:41 MST — cursor/superagent-bounded-autonomy-51be — 7a8ddb0f5

- **PR:** [#473](https://github.com/raydocs/maka-cloud/pull/473)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent bounded-autonomy. Kept MakaEngine and T34 P3 (`superagent` before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept.
- **Why:** #469 landed on main; this PR was DIRTY. User asked to merge main up the stack and keep MakaEngine. #473 is a sibling of #472, both cut from #471.
- **Tests:** conflict resolution only; prior head `473ac5ad0` already had `test` green
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:40 MST — cursor/superagent-shared-box-51be — b25a3c7ca

- **PR:** [#472](https://github.com/raydocs/maka-cloud/pull/472)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent shared-box. Kept MakaEngine and T34 P3 (`superagent` before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept.
- **Why:** #469 landed on main; this PR was DIRTY. User asked to merge main up the stack and keep MakaEngine.
- **Tests:** conflict resolution only; prior head `e632e765f` already had `test` green
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:39 MST — cursor/superagent-real-loop-51be — 90bb34bd6

- **PR:** [#471](https://github.com/raydocs/maka-cloud/pull/471)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent real-loop. Kept MakaEngine and T34 P3 (`superagent` before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept.
- **Why:** #469 landed on main; the stack PRs were DIRTY. User asked to merge main up the stack and keep MakaEngine.
- **Tests:** conflict resolution only; prior head `50b582a0c` already had `test` green
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:39 MST — cursor/superagent-usable-51be — dbe274210

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent usable. Kept MakaEngine and T34 P3 (`superagent` before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept.
- **Why:** #469 landed on main; this PR was DIRTY. Prior `test` on `e6234fce7` (run 41508419480) failed desktop e2e `workhub-layout` (`aria-haspopup` expected `listbox`, got `dialog`). `apps/desktop` / `packages/ui` match #466 where that spec passed; prior #470 head `520f204b` was green. Upstream flake, not the usable build. Not a test we own; merge retriggers CI. Assertions unchanged.
- **Tests:** conflict resolution only
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:38 MST — cursor/superagent-workspaces-51be — b10cab40f

- **PR:** [#465](https://github.com/raydocs/maka-cloud/pull/465)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent workspaces. Kept MakaEngine (workspace, `build`/`build:eval` after `@maka/eval`, fork-lane/Dockerfile step, import-boundary) and T34 P3 (`superagent` still builds before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept. `docs/superagent` joins the ASF header exclusion.
- **Why:** #469 landed on main; this PR was DIRTY. User asked to merge main up the stack and keep MakaEngine.
- **Tests:** conflict resolution only
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:38 MST — cursor/superagent-ledger-51be — d12b53238

- **PR:** [#466](https://github.com/raydocs/maka-cloud/pull/466)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent ledger. Kept MakaEngine and T34 P3 (`superagent` before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept. `docs/superagent` joins the ASF header exclusion.
- **Why:** #469 landed on main; this PR was DIRTY. Prior `test` on `7f900d01c` (run 41507887910) failed three desktop e2e cold-start specs (`composer-directory-reference`, `composer-session-reference`, `expected-failure-feedback`) — splash only, 20s composer timeout. Unrelated to the ledger; `cloud-runners` cancel-install passed. Not a test we own; merge retriggers CI. Assertions unchanged.
- **Tests:** conflict resolution only
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:36 MST — cursor/superagent-host-51be — 6251b7923

- **PR:** [#464](https://github.com/raydocs/maka-cloud/pull/464)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent host. Kept MakaEngine (`packages/cloud-maka-engine`, build order after `@maka/eval`, fork-lane/Dockerfile build step, import-boundary test) and the T34 Super-agent host rows. Only `AGENTS.md` conflicted; both fork-delta tables kept. `docs/superagent` joins the ASF header exclusion so this file is allowed.
- **Why:** #469 landed on main; this PR was DIRTY. User asked to merge main up the stack and keep MakaEngine.
- **Tests:** conflict resolution only; desktop e2e flakes on later PRs are unrelated
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:29 MST — cursor/superagent-learning-review-51be — 66178a088

- **PR:** [#478](https://github.com/raydocs/maka-cloud/pull/478)
- **What:** Optional mistake book (off by default) records a lesson when work is bounced — review changes/reject, CI fail-then-fix after a worker push, owner deny, watchdog correction, peer-review BLOCK. Distill merges repo-level lessons and emits skill/prompt diffs that are never auto-applied. Accepted lessons inject as an append-only id+summary prefix via existing spill/recall. Optional cross-model review (off by default, default 2 rounds) runs a different model on the diff before push/PR; blocking findings bounce the worker, then wait on a human; tokens go to the usage ledger. Tests use `FakePeerReviewClient`. Constructor does not read env; host passes flags. No sqlite `user_version` bump (audit + worker JSON).
- **Why:** Self-learning from bounced work and a second-model review gate, without touching parallel scheduler/watchdog/BYOM/box branches.
- **Tests:** `@maka-cloud/superagent` typecheck + `node --test` + biome format
- **Live:** n/a
- **Migrations / risk:** none. Defaults false. No server/deploy/billing change.

## 2026-11-02 13:26 MST — cursor/superagent-intake-merge-51be — e45c5fc4f

- **PR:** [#477](https://github.com/raydocs/maka-cloud/pull/477)
- **What:** Cross-source live event graph (programmatic path/commit/fingerprint/ref merge, fuzzy Slow Path only for survivors, observe/auto/split, recall `mergeId`) and graded escalation (value/urgency/risk → archive / worker / waiting-human card + feedback). Scheduler footprint conflicts record a graph hint. JSON `graph` / `escalate` documents. No `user_version` bump.
- **Why:** User-approved P1 (2 Nov 2026) aligned with DSH same-ticket intake and cheap-model triage.
- **Tests:** 171 passed (`test:dist`), including new event-graph / escalate suites. FakeJudgeClient proves programmatic hits do not grow router prompts.
- **Live:** n/a
- **Migrations / risk:** none. Documents are `CREATE TABLE IF NOT EXISTS`. Schema version stays 2.

## 2026-11-02 12:42 MST — cursor/superagent-byom-spec-51be — 010c9b925

- **PR:** [#475](https://github.com/raydocs/maka-cloud/pull/475)
- **What:** BYOM default command allowlist drops shells (`sh`, `bash`, `zsh`, `dash`, …) and wrappers (`env`, `xargs`, …). Devices exec `argv[0]` by exact basename match, no shell parse. `SandboxPort` `cmd` is tokenized and spawned directly; pipes / redirects / `sh -c` are refused with `shell_not_allowed` (never a silent `sh -c` fallback). Per-device `allowShell` (default false) is set at pairing or via `setAllowShell`; enabling writes `byom_allow_shell` to the hub audit and Super-agent ledger and shows `allowShell` on worker progress. A shell job also records `byom_shell_used`.
- **Why:** Owner agreed to close the residual that an allowlisted shell could run arbitrary scripts on a paired machine.
- **Tests:** `@maka-cloud/superagent` byom suite: default refuse `sh` / `bash` / `sh -c` / pipes; allow when `allowShell` is on; existing jail / HMAC / offline / pairing tests unchanged.
- **Live:** n/a
- **Migrations / risk:** none. Existing paired devices stay `allowShell: false`. Owners who need a shell opt in per device.

## 2026-11-02 12:26 MST — cursor/superagent-watchdog-duplex-51be — 656e7d7cc

- **PR:** [#476](https://github.com/raydocs/maka-cloud/pull/476)
- **What:** Conversational watchdog (ask/instruct on the existing progress API + `status` CLI; ledger / incidents / worker state / trigger→thread→worker citations; cheap model optional, deterministic fallback default; nudge/pause/resume/cancel/stuck-check only on explicit instruct). Full-duplex workers (`DuplexLoop`: mid-run inbox at the next step, `start()` → `started`, cancel/correct preempt, `seenEventIds` idempotency, progress ack `received, will apply at next step`). Design: `docs/superagent/watchdog-duplex.md`.
- **Why:** User-approved task: queryable watchdog + async ReAct mid-run delivery, additive against parallel BoxPool / scheduler branches.
- **Tests:** `@maka-cloud/superagent` `test:dist` (watchdog-query + duplex). cloud-server progress ask/instruct route test.
- **Live:** n/a
- **Migrations / risk:** none. Worker JSON only (`seenEventIds`, `cancelRequested`). No sqlite `user_version` bump. Watchdog `tick()` stays a separate timer loop.

## 2026-11-02 12:25 MST — cursor/superagent-byom-spec-51be — ca33ac59d

- **PR:** [#475](https://github.com/raydocs/maka-cloud/pull/475)
- **What:** BYOM execution target (default off) and speculative runs (default off). New `@maka-cloud/superagent-device` daemon dials out; `ByomHub` pairing / HMAC / jail / allow-deny / kill switch / repo opt-in; `ExecutionTarget` picks Instabox or a capability-matched device and waits with `device_offline` when the box is gone. Speculative workers start on watched CI failures / matching issues before the Router, lowest priority, hard daily + concurrency caps, no push/comment/PR until `acceptSpeculative`; discard cleans worktree/box and the ledger records accepted/discarded cost.
- **Why:** Owner-approved: run iOS / local trees on a paired machine; measure whether pre-decision attempts are worth the spend. Both stay off so P0 Instabox behavior is unchanged.
- **Tests:** `@maka-cloud/superagent` byom + speculative suites (in-process daemon / fake daemon). `@maka-cloud/superagent-device` loopback daemon test.
- **Live:** n/a
- **Migrations / risk:** none. No sqlite `user_version` bump. New fields are worker JSON (`executionTarget`, `speculative`). Cloud never receives device-local secrets. Threat model: [byom.md](byom.md). Speculative: [speculative.md](speculative.md).

## 2026-11-02 12:19 MST — cursor/superagent-scheduler-router-51be — 3f12cbe39

- **PR:** [#474](https://github.com/raydocs/maka-cloud/pull/474)
- **What:** Scheduler / admission queue (priority, size, deps, footprint, reserved human slot, aging, async start) and a two-layer tunable Router (Fast Path drops, Slow Path classify + observe/auto/off + feedback). Subscribed threads skip the router model. Recall chain `triggerId → threadId → workerId`. Queue + intake metrics on the progress snapshot. JSON `documents` table, no `user_version` bump.
- **Why:** User-approved P1 (2 Nov 2026) plus DSH Fast/Slow Path alignment.
- **Tests:** new scheduler / intake / recall suites; existing routing box/spend caps now expect `queued`. FakeSandbox + FakeJudgeClient.
- **Live:** n/a
- **Migrations / risk:** none. `documents` is `CREATE TABLE IF NOT EXISTS`. Schema version stays 2.

## 2026-11-02 12:15 MST — cursor/superagent-bounded-autonomy-51be — 0b00eb643

- **PR:** [#473](https://github.com/raydocs/maka-cloud/pull/473)
- **What:** `biome format` on autonomy / prompt-cache / session / runtime / judge-client. Merged #471 W2 two-tick host test and #466 `.setup-*` cleanup.
- **Why:** CI `test` on #473 run 41505737950 failed `format:check` (`Found 6 errors`) before workspace tests ran. Same assertions. After format, the forwarded host stuck-card test is the next gate.
- **Tests:** format check of those six files; host stuck-card and cancel-install come from the merge
- **Live:** n/a
- **Migrations / risk:** none. Format only.

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

## 2026-11-02 11:58 MST — cursor/superagent-bounded-autonomy-51be — 85ef3d4f0

- **PR:** [#473](https://github.com/raydocs/maka-cloud/pull/473)
- **What:** Bounded autonomy in the worker loop (Factory Droid 1.0 harness): 4 min stream silence → retry; hard time limit at most 2 attempts; partial responses discarded before retry. 3 empty turns → stop; 3 identical tool calls → nudge, 6 → stop; polls that return new results continue. Every stop/retry/nudge is a ledger event, a watchdog incident (`stream_silence` / `time_limit` / `empty_turns` / `repeat_tools`), and a progress `reason` the lead speaks. Compaction summary budget is 16k tokens (Super-agent had none). Prompt-cache hygiene: worker requests are append-only (new tools appended at the end; git status and other volatile facts stay in the tail). A cache-break monitor names the first changed segment and counts breaks; cache-hit share uses Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`. Failed requests retry on the same provider endpoint.
- **Why:** User request (2026-11-02) after the Factory Droid 1.0 writeup: when the agent gets stuck, always have a next step (nudge, retry, summarize, or stop); grow the request by keeping the prompt cache.
- **Tests:** 146 passed in `@maka-cloud/superagent` (`test:dist`). FakeProvider / FakeSandbox — silence retry, time-limit cap, empty-turn stop, identical-tool nudge/stop, CI-poll new results, ledger+watchdog+progress+lead, 16k compaction, append-only tool load, git-status tail, same-endpoint retry, cache-hit share.
- **Live:** n/a
- **Migrations / risk:** none. JSON fields only (`worker.autonomy`). No sqlite `user_version` bump.

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
