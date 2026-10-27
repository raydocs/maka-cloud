# Maka Cloud: plan for go-live, and for Claude Code without your laptop

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
- Never run for real: one task on a real sandbox with the real model and GitHub. Everything else is
  rehearsed with stand-ins.
- Sandboxes move from instabox to boat.dev (decided 2026-10-26). The first live run is on boat, so it
  waits for Phase 3.1 steps 1 to 3.

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
   - the Anthropic, OpenAI and boat keys
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
| 1 | Put both pinned CLIs (`claude`, `codex`) in the sandbox template (a boat saved snapshot) | `cloud-boxes/src/cli-install.ts`, the template | a cold box skips 4 tarball downloads, the checksum checks and an `npm install` | rebuild the image on every CLI bump; the version check still runs | S |
| 2 | Install Codex in the background while Claude implements | `cloud-runners/src/fleet.ts` `ensureCli` | removes the install from between "verified" and "reviewed" | one wasted install when no review runs | S |
| 3 | Poll CLI runs with backoff (150 ms to 1 s), as the Claude SDK path already does | `fleet.ts:187` (2 s fixed today) | up to 2 s less per turn end, repair and review | more `exec` calls to the sandbox | S |
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

## Direction (2026-10-27): your Claude Code, without your laptop

Claude Code is already the best coding agent; Anthropic now also ships Claude Duet and Projects, Amp
runs Claude Code on the user's own plan, and Coworkers and Grok Bot give each agent its own cloud
computer. We do not build a better model loop. We make the one people already like easier to live
with: **your agent can run a hundred subagents; your laptop can't.** One tap in our app, the laptop
stays closed, and the work comes back as a pull request you can merge.

What a user gets from us that `claude` on their own machine does not give them:

| Using Claude Code directly | In Maka Cloud |
|---|---|
| The laptop stays open, or the task stops | Runs in the cloud; brief, approve and review from the phone |
| Permission prompts and "continue?" all along | A work order up front (at most three questions, each with a default), then it runs; only risky actions ask |
| "Done" you have to check yourself | Done with evidence: the reproduction fails before and passes after, the other vendor reviews, the integrity scan finds no touched tests, CI is green |
| One task per machine, worktrees and setup by hand | One clean sandbox per task, forked from the repository's snapshot with its dependencies, several at once |
| The 5-hour limit stops the work | The user's Claude and ChatGPT plans as one employee: Claude writes, Codex reviews; at a limit the task waits and resumes by itself |
| A diff in a terminal | A pull request, CI followed, fixed once when red, merged in one tap where granted |
| The project explained again each session | Project memory learned from reviews and from merged and rejected PRs |

How we keep to Anthropic's terms (AGENTS.md "Product constraints"): the `claude` binary is
unmodified; each user signs in with their own plan through Anthropic's flow inside their own
sandbox, and the sign-in never leaves it; no task runs on another person's plan; API keys stay the
default. The host keeps the keys, the money and the verdict; inside the sandbox Claude Code is free
to work.

How we measure it: the share of pull requests merged without the owner changing code, and the
owner's minutes per task. Both go on the scorecard (`cloud-evals`) next to the integrity-flag share
of T33. No score is worth a shortcut.

## Phase 3: build it (starts now, in this order)

### 3.1 boat.dev sandboxes (agent) — the first live run waits for steps 1 to 3

boat gives full-root Ubuntu VMs, per-second billing, stop as a snapshot, fork, environments and an
embeddable desktop. Checked on a trial box (2026-10-27): `unshare --user --pid`, passwordless sudo
and `/dev/fuse` work; Claude Code and Codex are preinstalled.

1. A sandbox provider interface in front of `InstaboxClient` (used directly today by
   `cloud-boxes`, `cloud-host`, `cloud-runners` and `cloud-playbooks`). No behaviour change.
2. `packages/cloud-boat`: the boat adapter, with a fake for tests. Design around boat's limits: no
   pause (a stop ends every process), auto-stop after one hour unless extended, API commands end
   after 600 s unless detached, EU regions only. The environment is `safe-for-third-parties`, and
   the model keys stay in our gateway, not in boat's credential proxy.
3. The rehearsal on the boat fake, then live probes behind `MAKA_CLOUD_LIVE=1`: the agent account,
   the check namespace, the egress rule, `claude -p` under the `env -i` entry.
4. One sandbox per task, forked from a per-repository snapshot (replaces the box pool's own
   snapshots). A task no longer shares a machine, so `MAKA_CLOUD_TASKS_PER_INVITE` can go above 1.

Done when a coding task runs end to end on a boat sandbox and opens its pull request.

### 3.2 The user's own plans (agent, after 3.1 step 2)

- Claude: the user signs in inside their sandbox through Anthropic's own flow (a terminal or desktop
  link from the app), as the agent account, so the runner finds it. The token stays in the
  sandbox; boat's credential profiles are not used for users.
- ChatGPT: the Codex sign-in of T27 (#429), the same way.
- Plan limits: read `rate_limit_event`; at a 5-hour limit the task waits and says when it resumes,
  or, with the user's consent, continues on the other vendor or an API key. Headless runs use the
  5-hour window faster per token today (anthropics/claude-code#97074); we do not work around it
  with the entrypoint label.

### 3.3 One session per task, and work like an employee (T33, #444)

One long Claude Code session runs the whole task: plan, reproduction, implementation and the fix
after review (`--resume`, so the prompt cache stays warm). The host adds the work order, the
integrity scan, the stuck report and at most two unverified delegations.

### 3.4 Start where the user already is

1. A Claude Code plugin with `/handoff`: the goal, branch and context of the local session go to a
   cloud task, and the laptop can close. A push notification brings the result back.
2. `@maka` in a GitHub issue or PR comment starts a task on that repository.

### 3.5 Watch and take over

The task view streams the sandbox's terminal and desktop (boat's embed). The user can take over,
the agent waits, and hands back to the same session. The narration and panel UI (`task_narration`,
`task_panel`, #383) shows what it is doing between results.

### 3.6 Ship (T26)

Commit, rebase, test, push, open the PR, follow CI, fix once on red, then escalate.
`merge-when-green` only where granted. This is the one-tap merge the cards need.

### 3.7 Phone apps to TestFlight and internal testing (T29)

As before: the polish pass through tokens, Apple and Google sign-in on the phone, notification
actions "Got it" and "Not now" only. O's steps: Apple Developer account, bundle id, App Store
Connect record and APNs key; Play Console app and FCM project; Expo/EAS with O's signing keys.

### 3.8 Later

- Proposed cards (T30): the P1 and P2 items in `post-launch-backlog.md`, a per-owner GitHub
  credential, then `MAKA_CLOUD_CARDS=1` for the owner's projects first.
- Deep mode after the provenance fix; memory (T11) and schedules (T12) beyond duties; voice (T19).

## Decisions only O can make

1. Per-task agent accounts: the decision card in the "Isolation and egress design" thread.
2. #366: the confirm step. #378: the Source section's P2.
3. Whether one invite may run two tasks at once (#394 makes it one at a time; one boat sandbox per
   task, Phase 3.1 step 4, removes the shared-machine reason).
4. Budgets: the first live run (suggested $10), and the first paid scorecard run.
5. Fast mode and priority tier (Phase 2 #7 and #9): whether faster is worth up to twice the model cost.
6. Whether to skip cross-review in `quick` mode.
7. The production server and domain (Phase 1.3), and the boat plan ($20 a month at least).
