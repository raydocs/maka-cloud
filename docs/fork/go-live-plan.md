# Maka Cloud: plan for go-live and for closing the gap with Hark

Written 2026-10-22. It builds on the "Direction (2026-10-21)" section of `docs/fork/TASKS.md`,
`docs/fork/pre-launch-audit.md`, `docs/fork/launch-notes.md` and `docs/fork/post-launch-backlog.md`,
and does not repeat them. Each step names its owner (O = the owner, an agent lane otherwise), what
"done" means, and what it depends on.

## 0. Where things stand

- Built and on `main`:
  - the server, orchestrator, runners and playbooks
  - the web app
  - the model gateway with spend caps
  - approvals and the inbox
  - restart and backup
  - the sign-in building blocks (T31 S1 to S3)
  - Home cards, scoped approvals, the scorecard and the design tokens
- Off at launch, but built: the box pool, proposed cards, deep mode and the plan vault (`launch-notes.md`).
- CI: Linux jobs on GitHub's runners (the repository is public), the phone apps on the owner's Mac mini (#396, `docs/fork/ci.md`).
- Never run for real: one task on a real instabox with the real model and GitHub. Everything else is
  rehearsed with stand-ins.

## Phase 1: go live (target: about one week)

### 1.1 Merge the queue (agent, in progress)

The order is in the merge train: the independent PRs first, then the design stack bottom-up, then
#390, then the PRs that conflict, then the upstream sync (#226) as a merge commit. Each PR is squash-merged
once its checks pass. A PR that fails or conflicts is fixed on its branch and
taken again.

Done when no PR that belongs to the launch is open, and `main`'s own push run is green.

### 1.2 Sign-in, the launch gate (T29 lane, then O)

1. #375 (host wiring: client ids, mail service, trust proxy). It is in the queue.
2. The client sign-in PR (AuthFlow, the phone sign-in screen, Settings devices, the Maestro email flow).
   It is done locally and held behind #375.
3. **New: web sign-in screens.** Email code, then Apple and Google, plus a devices list in Settings.
   Email code is in (#417); Apple's and Google's sheets are not on the web yet. #367 only added
   sessions on the server: the web keeps its session in an HttpOnly `__Host-` cookie
   (`cloud-server/src/session-cookie.ts`), so a reload and a push tap stay signed in.
4. O: Apple Services ID and key, Google OAuth client id, and a mail service (any SMTP or API).
   They go into the settings file, never into the repository.

Done when, on the web, a reload and a push tap keep you signed in, a revoked device is signed out
within one request, and a new account without an invite is refused.

### 1.3 Install on the real host (agent and O)

1. O: a Linux server for production. Not the CI VPS: the rehearsal job uses ports 80/443 and Docker
   there.
2. O: DNS for `app.`, `mcp.` and `models.<domain>`.
3. Run `curl …/deploy/install.sh | sh`, from #390, which is in the queue. The wizard asks for:
   - the domain
   - the Anthropic, OpenAI and instabox keys
   - the sandbox machine
   - a GitHub token
4. `maka-cloud check` must print, as `pre-launch-audit.md` §9.1 requires:
   - one machine per invite
   - the agent account
   - `proposed cards: off`
   - no box pool
   - a backup directory
   - the gateway URL as https

Done when `/healthz` answers over TLS through Caddy, and the owner signs in.

### 1.4 First live run (agent drives, O watches; budget `MAKA_CLOUD_SMOKE_MAX_USD`, suggested $10)

Follow `pre-launch-audit.md` §9, steps 1 to 8, on a scratch repository:

1. One coding task:
   - the box check passes
   - `claude -p` starts under the `env -i` entry
   - clone, check namespace, result card
   - the PR opens
   - `verification.json` carries no key
2. One approval answered from the phone and from the web; the second must be refused as a duplicate.
3. A restart while a task runs: the server exits at once and the kept change is shown.
4. Backup, list and restore.
5. The gateway journal against the Anthropic and OpenAI dashboards, within one reservation.

Each finding is one small PR with a test that fails on `main`. Done when all eight steps pass on one
run.

### 1.5 Launch checklist (O)

- Invite yourself, then one or two friendly users.
- Spend caps: $5 per task, $50 per day, $25 alert (the wizard's defaults).
- Watch the first week's tasks in the inbox. Read `docs/fork/deploy.md` "Operations" for backup
  timing and log rotation.
- README screenshots from the running app. The README is #389; the shots come once the design stack
  is in.

## Phase 2: faster tasks, on Claude and on ChatGPT (alongside Phase 1, no launch risk)

Ranked by gain against risk, from a read of the code. "Measure" means `cloud-evals` before and after;
no default changes on a guess.

| # | Change | Where | Speed effect | Trade-off | Size |
|---|---|---|---|---|---|
| 1 | Put both pinned CLIs (`claude`, `codex`) in the instabox template image | `cloud-boxes/src/cli-install.ts`, the template | a cold box skips 4 tarball downloads, the checksum checks and an `npm install` | rebuild the image on every CLI bump; the version check still runs | S |
| 2 | Install Codex in the background while Claude implements | `cloud-runners/src/fleet.ts` `ensureCli` | removes the install from between "verified" and "reviewed" | one wasted install when no review runs | S |
| 3 | Poll CLI runs with backoff (150 ms to 1 s), as the Claude SDK path already does | `fleet.ts:187` (2 s fixed today) | up to 2 s less per turn end, repair and review | more `exec` calls to instabox | S |
| 4 | Name the Codex model and price it (`gpt-6.1-sol`) | #393 / #390, in the queue | the gateway can price review, which makes a faster model choosable per mode | none | done in queue |
| 5 | Resume the implementer's own session for the post-review fix, instead of a fresh run | `cloud-playbooks/src/coding/runner.ts` ~1114 | warm prompt cache, no re-reading of the repo | keep one session per vendor; append-only history holds | M |
| 6 | Setup snapshots per repository (CLIs, checkout, dependencies), when the box pool goes on | `cloud-host/src/stack.ts` passes `setupOf` to the pool (built, not wired) | minutes per cold box on real repositories | snapshot storage; a builder box per setup change | M, Phase 3.1 |
| 7 | Claude fast mode (`speed`) for the Opus 5.5 roles | gateway `bound.ts` (allow `speed`), `pricing.ts` (fast at 2x), modes | up to about 2.5x output tokens per second | twice the price of Opus 5.5; a switch mid-task invalidates the cache; verify how Claude Code sends it | M |
| 8 | Sonnet 5.5 effort `high` → `medium` in `standard` | `cloud-modes/src/modes.ts` | fewer and more consolidated tool calls, less thinking | quality: measure first | S |
| 9 | Codex review effort `medium` → `low` in `standard`; consider the OpenAI `priority` tier for review | `modes.ts`, `bound.ts:307` (`service_tier` locked to `default`) | fewer reasoning tokens per review; priority means lower latency | quality; priority costs more; verify the Codex CLI key and pricing | S/M |
| 10 | Run the reproduction check and the test command at the same time (the reverted-base check stays serial) | `coding/runner.ts` 1007-1119 | one check's wall-clock per verification | tests that write shared files | M |

Not ranked because each is a policy decision for O:
- Skip cross-review in `quick` mode, or for small diffs.
- Race the second vendor in parallel instead of after two failures. That is about half the worst-case time
  at twice the spend, and the design says "never two at once".

Already fine: Claude prompt caching (the gateway passes `cache_control`; Claude Code places the
breakpoints) and OpenAI prompt caching (automatic; `prompt_cache_key` is allowed).

Order: 1, 2 and 3 now (small, no quality risk). Item 4 lands with the queue. Measure 8 and 9 on the
scorecard before changing defaults. Item 7 waits for a priced decision. Item 6 comes with the pool.

## Phase 3: closing the gap with Hark (after launch, in this order)

Hark's experience: one chat, Home with one-tap Action Buttons, Projects, memory, Handoff, a cloud
computer per user, and apps on web, iOS and Android. Maka Cloud stays a software employee. Errands,
email and calendar, payments and the vault are out of scope.

### 3.1 Boxes that feel like Hark's computer (T27 pool, T26 sleep and Ship) — the biggest gap

1. Close the pool's review items (`post-launch-backlog.md` "Box pool" 1 to 5, "Snapshots" 1 and 2).
   Each is one PR with a failing test.
2. Wire setup snapshots (Phase 2 #6) and the resume script after every wake.
3. Turn on `MAKA_CLOUD_BOXES` for the owner's invite only, with the rest kept on one machine each.
   Probes behind `MAKA_CLOUD_LIVE=1`: wake time, snapshot restore, exec after sleep, no reach
   between boxes, the egress rule.
4. T26 Ship: commit, rebase, test, push, open the PR, follow its CI, fix once on a red CI, then
   escalate. `merge-when-green` only when granted. This is the merge tool the cards need ("Merge PR #12").
5. Per-task agent accounts (r19-4). The patch is built. It needs the real-account peer test, host
   config tests, the deploy text and the `taskOver` release, and O's answer on the decision card.

Done when the owner runs three tasks at once on three boxes that sleep when idle and wake in under a
minute, and a green PR merges from one tap where granted.

### 3.2 Watch and take over: live handoff (T14b)

- Real pause and resume on `SandboxCliRunner` and the coding runner. The same session continues;
  a restart is not a pause.
- A trusted adapter from the instabox desktop and terminal to T14's `ComputerSource`. No provider URL
  ever reaches the browser.
- Read Cua's driver and Spaces model first, and check each licence.
- Done when, on the web and the phone, the user watches the employee's screen, takes control (the
  agent does nothing meanwhile), and hands back to the same session.

### 3.3 The employee notices work by itself (T30 cards, built and off)

1. The P1 and P2 items in `post-launch-backlog.md` "Proposed cards" 1 to 9: scrub at the write
   boundary, recovery re-checks, refresh failure, kind switch, owner scoping, the schema version.
2. A per-owner GitHub credential for scans (item 5), replacing the host token.
3. The phone card screens (T29).
4. The cheap ranker behind `CardRanker`, and the employee's own results as a signal.
5. Turn on `MAKA_CLOUD_CARDS=1` for the owner's projects. Watch accept and dismiss counts for two weeks
   before anyone else gets them.

### 3.4 Phone apps to TestFlight and internal testing (T29)

- After the design stack: the polish pass through tokens, and notification actions "Got it" and "Not now"
  only, never Approve.
- Apple and Google sign-in on the phone, and the Apple nonce form in the verifier.
- O's human steps:
  - an Apple Developer account, bundle id, App Store Connect record and APNs key
  - a Play Console app and an FCM project
  - an Expo/EAS project, with the signing keys entered by O
- Done when the first TestFlight and internal-track builds reach the owner's phone.

### 3.5 Narration, panels and Home (Hark patterns 2 and 4, mostly built)

- The web and phone UI for `task_narration` and `task_panel`, now that #383 is in. This is the design lane's
  live work view, which starts after #383.
- The duties engine calls `addHomeNote` on merges, so note cards exist outside tests.

### 3.6 Later

- Deep mode on, after the provenance fix (`post-launch-backlog.md` "Deep research").
- The user's own Claude and ChatGPT plans (T27 vault). A launch gate with Anthropic's and OpenAI's
  terms comes first; API keys stay the default path.
- Memory (T11) and schedules (T12) beyond duties.
- Voice (T19).

## Decisions only O can make

1. Per-task agent accounts: the decision card in the "Isolation and egress design" thread.
2. #366: the confirm step. #378: the Source section's P2.
3. Whether one invite may run two tasks at once (#394 makes it one at a time).
4. Budgets: the first live run (suggested $10), and the first paid scorecard run.
5. Fast mode and priority tier (Phase 2 #7 and #9): whether faster is worth up to twice the model cost.
6. Whether to skip cross-review in `quick` mode.
7. The production server and domain (Phase 1.3).
