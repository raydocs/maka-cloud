# Pre-launch audit: the first user's path

Read-only audit of the path a first user takes, on `main` at `952c388` (2026-10-21, after #312):
sign-in, one sandbox machine per invite, the model gateway, approvals, the inbox, a restart and a
backup. Nothing was run, live or otherwise. Each section says what holds the step up (code and the
test that covers it), what is open, and what the first live run is the first to show. Off-at-launch
features (box pool, proposed cards, plan vault) are out of scope; findings on them go to
`docs/fork/post-launch-backlog.md`.

## Verdict

Three things stood between `main` and a first user. The first two are known and owned by a lane;
the third came out of the #323 review and was closed by #331 (a9d9faa, 2026-10-21 23:45Z):

1. **Sign-in is an invite-token box, held in memory only.** The web app's first screen asks for the
   token, keeps it in React state and nowhere else (`packages/cloud-web/src/App.tsx:676-830`,
   `main.tsx` passes no initial token), so every reload, every tap on a push notification and every
   tab the phone browser drops asks for the token again. Owner direction (2026-10-21 21:38) makes
   Apple/Google/email-link sign-in (T31) the launch gate; it is in the T29 lane and not merged.
2. **A restart with a task running is a kill, not a close.** `server.closing` is logged, the stack
   closes its servers and stores, and the process stays up until Compose or systemd kills it 60 s
   later (mechanism in "Restart" below). The rehearsal passes because its restart step tolerates the
   kill; a real task has never been restarted. T28 owns the fix (`post-launch-backlog.md`, "Go-live
   rehearsal" item 2).
3. **The agent's git refused its own checkout (closed by #331).** The clone is owned by the
   sandbox user and no `safe.directory` reached the agent, so the real CLI's `git status` failed
   with "dubious ownership" (section 2). File edits worked, which is why the `checkout` gate (#323)
   passed without it. #331 names the exact workspace as `safe.directory` in the agent's launch
   environment (`cloud-runners/src/agent-user.ts`, `AGENT_ENTRY`, through `GIT_CONFIG_COUNT`), with
   a real-account test; the `git status` as the agent in the rehearsal's `checkout` step is in #323
   and is what shows it on a box.

Everything else on the path is built, unit-tested and, except for the real sandbox, the real model
and GitHub, rehearsed end to end in CI. The rest of this document is what to check on the first
live run, in the order a user meets it, with the smaller findings (P2/P3) where they belong.

## 1. Sign-in

What a first user does: opens `https://app.<domain>`, pastes the invite token, enters the workspace.

What holds it:
- Tokens are `mki_<invite id>.<32 random bytes>`; only the SHA-256 is stored, compared in constant
  time, and a revoked or unknown invite answers 401 (`cloud-server/src/invites.ts:186-210`,
  `http.ts:381-396`). A revoke is read on every request and ends open event streams within
  `revokeCheckMs` (`http.ts:279-316`). Rehearsal step `sign-in` covers no token, a wrong token and
  the right one.
- Every side effect re-checks the invite after the body is read (`reauthenticate`), so a token
  revoked mid-request does nothing.

Findings:
- **P1 (launch gate, T31)**: the token box as the first screen, above. Until T31 lands, the first
  user must keep the token in a password manager and paste it on every reload. Push notifications
  (if VAPID is set) open the app to the token box, not to the item.
- **P3**: the token box is `type="password"` with `autoComplete="off"`, so the browser offers no
  save; with T31 this screen goes away.

First live run shows for the first time: a real certificate on three names, the web build served by
Caddy, the event stream through the proxy (`: stream open` at once, `: keep-alive` every 15 s).

## 2. One sandbox machine per invite

What a first user does: sends a goal; the conductor starts a task; the task runs on the invite's
machine.

What holds it:
- `MAKA_CLOUD_SANDBOXES` maps invite to machine; a machine listed twice is refused at start
  (`cloud-host/src/config.ts:805-831`, `cloud-runners/src/providers.ts:34-52`), and a task whose
  invite has no machine fails to start instead of landing elsewhere (`stack.ts:181-185`).
- Before the first run on a machine the server checks the agent account and the box
  (`ensureAgentIsolation`, the file-capability probe #313, the egress guard), and every CLI runs as
  `MAKA_CLOUD_AGENT_USER`, never as the sandbox user. #312 (merged) moved every git the sandbox user
  runs to a repository of its own (`control.git`), so the agent's `.git` configures nothing the
  sandbox user runs. Covered by `control-git.test.ts`, `checkout-real-account.test.ts`,
  `file-caps.test.ts`, and the rehearsal (two real accounts in the stand-in box).

Findings:
- **P2 (same owner, not a tenant leak)**: two tasks of one invite run at once on one machine, as the
  same agent account. `TenantMachineProvider.acquire` hands out the machine with no exclusivity
  (`providers.ts:54-58`) and the only cap is `maxActiveTasks: 32` (`cloud-orchestrator/src/quota.ts`).
  Task A's agent can read task B's workspace and its `claude-config` (B's gateway grant token) and
  write B's workspace, so one task can change what the other delivers. The owner's caps bind both,
  so no money or tenant line is crossed. Per-task accounts (r19-4) are parked. For launch, either
  say "one task at a time per invite" in the runbook or cap active tasks per invite at 1; the
  rehearsal's `approval` step starts two tasks in one conversation, so a first user will do the same.
- **P2 (follow-up to #312, told to T28)**: the `add -A` of the change is check-then-act and holds only
  while no agent process is alive (the base-check revert and restore now run as the agent account and
  no longer depend on it), but the runner stops the
  agent's runs only in the final cleanup (`cloud-playbooks/src/coding/runner.ts:1797`); a background
  process the agent left in its turn survives into `verify` and `collect`. Fix: stop the task's agent
  runs, with no survivors, before the first revert and before `collect` (isolation-model.md F1).
- **P2 (found in the #323 review), fixed by #331 (a9d9faa)**: the real agent could not run git in
  its checkout. The clone runs as the sandbox user, so `.git` and every file are owned by it (#312
  changes the group, not the owner); git refuses a repository owned by another user ("dubious
  ownership") unless `safe.directory` names it, and only the control user's `g()` had
  `safe.directory='*'` (`cloud-playbooks/src/coding/scripts.ts:16`). The agent runs with the sandbox
  user's `HOME` (`asAgentUser`, `--preserve-env`), which it cannot read. The real Claude CLI runs git
  in the work directory for its own context, and the model runs `git status`/`git diff`; all of it
  failed while file edits still worked. #331 exports `GIT_CONFIG_KEY_n=safe.directory` with the
  workspace's real path in the agent's entry (`agent-user.ts`, `AGENT_ENTRY`, both the run and the
  exec branch), command-line scope being the one protected configuration git reads it from, with a
  real-account test; the `git status` as the agent in the rehearsal's `checkout` step is in #323.
- **P2**: every check runs under `unshare --user --map-current-user --pid` (`CHECK_SCRIPT`), which
  needs unprivileged user namespaces on the box. Docker's default seccomp profile refuses it, so
  the rehearsal's coding task fails its verification with exit 125 and the `checkout` gate (#323)
  only shows the agent's writes. Whether an instabox box allows it is unknown until the first live
  run; if not, every check fails at once with "could not start the check in its own user and PID
  namespace". Add it to the box requirements in the runbook and, for the rehearsal, either say the
  coding path ends at the writes or run the stand-in with `seccomp=unconfined` (it holds no keys).
- **P3**: the box checks are the first thing a real machine meets, and the rehearsal's box is made
  for them (real `sudo`, `getcap`, a second account, a firewall that keeps rules in files). A real
  machine without one of those refuses every task at once (`launch-notes.md`, "What to check at
  launch"). Make the two machines from the same image and run `check` plus one task on the smoke
  invite before the owner's invite.

First live run shows for the first time: the real firewall (`iptables`/`ip6tables` rules as traffic,
not as text), the real `claude` CLI's flags, files and network use, `npm` installing it, a real
clone from GitHub, and the stop-as-root of a real agent process.

## 3. The model gateway

What a first user does: nothing directly; every model call of the conductor, the runs and the
checks goes through the gateway with the owner's keys.

What holds it: the keys-and-money self-review at `/mnt/project-files/gateway/keys-money-self-review.md`
(invariant to test table): no runners export hands a vendor key to a sandbox, a sandbox gets only an
`mkg_` grant bound to its task's budget and revoked when the task ends, the worst case is reserved
before a call and settled at validated usage, spend is journaled before the request and recovered
on restart. `MAKA_CLOUD_GATEWAY_PUBLIC_URL` must be `https` except on loopback (`config.ts:665-671`).
#316 (merged) and #302 (merged) close the clip-before-scrub paths in manifests, asks and text.

Findings:
- **P2 (follow-up to #316, told to the Modes lane)**: `CHECK_SCRIPT` cuts a test's output with
  `tail -c` in the sandbox before any scrub, and that tail reaches the owner raw through
  `failure_brief.json` (`runs[].output`) and `verification.json` (`turns[].detail`), which the server
  serves as artifact bytes without scrubbing. A test that prints its environment puts a key in the
  owner's download. Fix in the runner: scrub `out.stdout` in `runCheck`, ask the sandbox for
  `MAKA_TAIL + 512` and cut on the host after the scrub.
- **P1 (found in the #322 review, told to the Egress lane)**: the secret scrubber is quadratic on
  text with many `"value":`/`"token":`/`"scheme":` fields and no braces (`SECRET_PAIRS`,
  `cloud-orchestrator/src/secret-shapes.ts:70`, `between = '[^{}]*?'`): 273 ms at 60 KB, 4.5 s at
  240 KB for the pair patterns alone, about 13 s through `scrubSecretText`, on the server's one
  thread. Every text a task or a fetched page produces goes through it, so one page stalls the whole
  server. Fix: `[^{}]{0,512}?`; the same shapes still scrub, 74 ms at 240 KB. #322 fixes the
  neighbouring backslash case; this one is the same class.
- **P3**: `MAKA_CLOUD_TASK_TURN_USD` is unset by default (no per-turn limit). For the first live run
  set it, with the invite caps (default 5/day, 50/month) and `MAKA_CLOUD_SERVER_DAILY_USD` (default
  25), and a monthly limit on the key at the vendor as the runbook says.

First live run shows for the first time: the vendor's real usage shapes against the settle schema
(a shape the schema refuses settles at the reservation, which is safe but over-charges the task),
and the real cost of one coding task in `standard` mode.

## 4. Approvals

What a first user does: the conductor holds a delegation; an approval card appears in the inbox and
in the conversation; the user taps approve, once.

What holds it: an answer carries `answerId` and `preconditionHash` and is strict-parsed
(`cloud-server/src/inbox.ts:67-74`); the same answer sent twice is a duplicate, a changed card is
refused, and the invite is re-checked after the body (`inbox.ts:138-175`). Rehearsal step `approval`
sends the first answer twice and asserts exactly as many answers recorded as tasks run. The phone
app (#299) shows the card's full text and hosts of agent-written links; a card it cannot render
exactly cannot be approved there (`cloud-web/src/Inbox.tsx:25`).

Findings: none open on the path. Deep mode cannot be picked while `MAKA_CLOUD_DEEP_MODE` is off
(#318, in review): a user who marks a request as hard gets `standard` and a notice.

## 5. The inbox

What a first user does: reads the result card, open questions and approvals; answers them.

What holds it: an invite lists and answers only the items of its own conversations
(`inbox.ts:121-136`, `owners.conversationsOf`); the mutes, settings and digest routes are one set for
the whole server and answer 404 until kept per owner (`inbox.ts:84-90`). The web inbox shows no
mute, settings or digest control (`Inbox.tsx`), so a first user does not meet the 404.

Findings:
- **P3**: the first user with two devices sees the same items on both; nothing per device. Fine.
- Known, not for launch: per-owner mutes/settings/digest (recommendation card in the server
  isolation thread; T28 or hide).

## 6. Restart

What a first user does: nothing; the operator restarts the server (a deploy, a reboot) while a task
may be running. The user sees "resuming after a restart" in the task and one result, not two.

What holds it: every unfinished task is taken over at start under a new epoch, its leftover run in
the sandbox is stopped (bounded by `orphanStopTimeoutMs`), spend from the dead process is recorded,
and the run resumes from the kept session (`cloud-orchestrator/src/orchestrator.ts:924-990`,
`341-362`). The conductor's cut turn follows the resumed task and replies once. Rehearsal steps
`restart` and `restart-reply` cover both, with the stand-in CLI parked at `waitinit`.

Findings:
- **P1 (owned by T28, backlog item 2)**: no clean detach. `stack.close()` closes the servers,
  the conductor, the orchestrator's retries and clocks, the database and then the gateway
  (`cloud-host/src/stack.ts:602-626`, `cloud-server/src/cloud-server.ts:616-641`,
  `orchestrator.ts:373-382`), but nothing cancels or detaches the running `Run` handles: a run's
  cancel happens only when it ends (`cloud-runners/src/runner.ts:289-297`), its poller sleeps on a
  timer that is not unref'd (`poller.ts:73`) and its exec requests are in flight with a 60 s
  timeout. The process stays up; Compose (`stop_grace_period: 60s`) and systemd (`TimeoutStopSec=60`)
  send SIGKILL. Two effects to expect on a real host:
  - every restart with a task running takes about a minute and ends in a kill, so the restart path
    the rehearsal proves is the kill path, which is also the crash path: recovery is from the store
    (`synchronous = FULL`), not from a handover;
  - between `cloud.close()` and `gateway.close()` the run still works against a closed orchestrator
    and database: a run event in that window throws inside the runner's callbacks. Whether that
    surfaces as an unhandled rejection (exit 1, systemd's `Restart=on-failure` restarts the unit) or
    is swallowed was not traced; either way the task resumes at the next start.
  Fix shape: on close, cancel every run handle with a "restart" reason that leaves the task
  unfinished in the store, stop the pollers and resolve `close()` once the handles are gone, or
  mark the run as detached before closing the stores. Test: start a task, close the stack, assert
  the process has no handles left and the task is still `running` in the store.
- **P3**: the first `restart` with a real task is also the first `stopLeftover` as root against a
  real agent process (`CHECK_STOP_SCRIPT`, `machine.kill`). A stop that reports survivors leaves the
  task owed a stop and the user sees "could not stop the leftover runner"; the owed stop is retried
  at the next start.

First live run shows for the first time: a restart during a real model call (charged in full, the
task says so), the real CLI resuming its session, and the time to healthy after a kill.

## 7. Backup

What a first user does: nothing; the server writes a daily backup to `MAKA_CLOUD_BACKUP_DIR` while
it runs, and the operator restores one with the server stopped.

What holds it: the backup layout is explicit (six databases, two files, two trees) and nothing else
is copied (`cloud-host/src/config.ts`, `backupLayoutOf`); databases are copied with the online backup
API, push subscriptions are dropped from the copy, transcript lines that carry a key shape are
redacted, a manifest with checksums is verified before a restore, the command-line `backup` and
`restore` refuse while a server holds the databases (`backup.ts:142-144`, `427-446`), and a restore
moves what was there to `pre-restore-*` rather than deleting it. Rehearsal step `backup-restore`
covers stop, backup, change, restore, compare, and a task after the restore. Under Compose the
backups are the `maka-backups` volume, which the runbook says to copy off the host by hand.

Findings:
- **P2**: a restore puts `invites.db` back as it was, so an invite revoked after the backup is
  active again, with the same token. The runbook does not say so. Add to the restore section: after
  a restore, re-run every revoke made since the backup (`cloud-server invite list` shows them), and
  rotate the smoke invite.
- **P3**: the daily backup needs `MAKA_CLOUD_BACKUP_DIR`; unset means no backups, silently except
  for the start-up summary. Compose sets it; a systemd host must. `check` prints it.
- **P3**: nothing copies the backup off the host; a disk that fails takes both. Set up the copy
  before the first paying task, not after.

## 8. Review state of the launch-path changes

Codex has been over its usage limit since 17:25Z on 2026-10-21; `docs/fork/unreviewed-prs.md` lists
what merged without an outside review. Launch-path PRs since then with a second Claude review on a
different brief (this thread): #299 (phone apps, ok at e083a6e), #312 (control.git, clean at
be7bdb7, merged), #313 (file-capability probe, findings posted), #315 (isolation model, gap edits at
a40713f), #316 (scrub before clip, merged, one P2 follow-up), #317 (smoke cleanup, ok, merged),
#318 (deep mode off, ok with a P3), #298 (export reserved names, ok), #322 (secret-shapes
backslash run, ok with the P1 above), #323 (rehearsal `checkout` gate, ok with two P2s above), and
after this audit was written: #324 (this audit), #325 (kept conversation exact and owner-only, ok at
8e65d54), #328 (smoke enumeration fail-closed, ok), #330 (short registered values, ok with a P2 on
the host's name-guessed list, merged with the filter), #331 (gate 3, ok), #335 (handoff files, P2:
the reviewer's `change.patch` can be swapped by the first agent's leftover process), #336 (a later
run opens a kept change, ok), #337 (clean detach on close, gate 2, P2: a detach during the base
check leaves the workspace reverted), #340 (CLI check as the agent, ok with a P2 on reinstalls),
#341 (delivery files by hash, ok). The
PRs merged between 17:27Z
and 22:28Z had no outside review at all; of those, the ones on the launch path are #232, #233,
#240, #242, #243, #244, #246, #247, #250, #254, #256, #260, #263 and #237. Recheck them with Codex
when it is back; until then, hold further changes to the same files or give them a second Claude
review.

## 9. What the first live run must show, in order

1. `check` on the real environment file prints the two machines (one per invite), the agent
   account, `proposed cards: off`, no box pool, a backup directory, and the gateway URL as https.
2. `/healthz` through the proxy over TLS; the event stream keeps alive through the proxy.
3. Sign in on the web with the smoke invite; a reload asks for the token again (known, T31).
4. One task on the smoke invite's machine: the box check passes (or says what the machine lacks),
   the CLI installs, the clone works, the result card arrives, the PR opens on the scratch
   repository, `verification.json` carries no key.
5. One approval answered once from the phone and once from the web; the second is a duplicate.
6. A restart while that task runs: about 60 s to the kill (known, T28), the task says it resumed,
   one result, the cut-off call charged in full.
7. `backup` with the server stopped, `backups` lists it, `restore` refuses with the server running
   and works with it stopped; revokes since the backup re-run.
8. The gateway journal and the invite's spend after the run match the vendor's dashboard to within
   the reservation of one refused shape.
9. Two tasks at once on one invite, only after the owner decides on finding 2 of section 2.

Items 1 to 8 need the owner's keys and budget, which this thread never sets or asks for; the smoke
command's own cap (`MAKA_CLOUD_SMOKE_MAX_USD`) is the budget for 4 to 8.
