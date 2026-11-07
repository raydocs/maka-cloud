# Launch notes: what stays off

The first launch is the default path of `docs/fork/deploy.md`: one sandbox machine per invite, tasks
started by users, the model gateway, approvals and the inbox. Five things are built and tested but
stay off at launch. None of them is needed by a first user, and none is switched on by accident:
each is off unless its setting is present, so the launch environment file simply leaves them out.

| Off at launch | How it is off | What it would change | Turn it on when |
| --- | --- | --- | --- |
| Box pool | `MAKA_CLOUD_BOXES` unset (and `MAKA_CLOUD_BOX_TEMPLATE`, `MAKA_CLOUD_BOX_MAX` unset) | the server would make, sleep and delete sandboxes itself, a pool per invite, instead of the fixed `MAKA_CLOUD_SANDBOXES` machine per invite | the pool's own review items are closed and a second invite needs more than one box |
| Proposed cards | `MAKA_CLOUD_CARDS` unset or `0` | a daily read-only scan of each registered project, with up to 3 one-tap cards in the inbox | the cards' own review items (secrets in GitHub text, rendering as plain text) are closed |
| Deep mode | `MAKA_CLOUD_DEEP_MODE` unset or `0` | the conductor is not told about `deep`, a suggestion of it runs as `standard`, and a user's pick of it runs as `standard` with the notice "Deep mode is not available yet"; `deep` holds `standard`'s values everywhere the modes are read | the provenance gap in `docs/fork/post-launch-backlog.md` (Deep research) is closed |
| Phone push | `MAKA_CLOUD_EXPO_PUSH` unset or `0` (and `MAKA_CLOUD_EXPO_ACCESS_TOKEN` unset) | the server tells the phone app, through the Expo push service, when a decision waits or a result is ready: fixed words and ids only | the owner has an APNs key and an FCM project in the EAS project, and a build with them reaches a phone |
| Plan vault | not wired: `packages/cloud-plans` is imported by no server package, so no setting turns it on | the user's own Claude or ChatGPT plan used on the boxes (T27) | T27 is finished and reviewed; it needs the box pool first |

## One task at a time per invite

Every task of an invite runs on the invite's machine as the one agent account, so two tasks at once
could read and change each other's workspace (`pre-launch-audit.md` §2). Until each task gets an
account of its own, the server runs one task tree per invite at a time (`MAKA_CLOUD_TASKS_PER_INVITE`,
default 1). A second task, from the same conversation or another one of the invite, is not refused:
it waits as `queued`, says "One task runs at a time on this workspace for now. This one starts when
<title> finishes.", and starts when the running tree has ended and nothing of it can still be running.
Tasks the running task delegates belong to its tree and start at once. A restart keeps the line: a
task that was waiting waits again (nothing of it is stopped or resumed), and trees that were running
beyond the limit (a lowered setting, or the first start of this version) resume one at a time; such a
tree still reads as running while it waits (with the same note) and cannot be paused until it resumes. The
start-up summary says
`tasks at once:       1 per invite; the next one waits its turn`.

A task that waits counts as queued for the inbox's stall check, so one that waits longer than
`queuedStallAfterMinutes` (10 by default) raises a "no progress" item although it is only waiting its
turn. A run stuck owing a stop (an unreachable machine) keeps the next task waiting until the stop is
confirmed or the task is cancelled.

## What to check at launch

- `MAKA_CLOUD_SANDBOXES` is set (one machine per invite) and `MAKA_CLOUD_BOXES` is not. The server refuses
  both set, and refuses neither.
- `MAKA_CLOUD_CARDS` is not in the environment file. The start-up summary then says
  `proposed cards:      off (set MAKA_CLOUD_CARDS=1 to turn them on)` and
  `sandbox machines:    N (one per invite)`.
- `MAKA_CLOUD_DEEP_MODE` is not in the environment file. The start-up summary then says
  `deep mode:           off (set MAKA_CLOUD_DEEP_MODE=1 to turn it on)`.
- `MAKA_CLOUD_EXPO_PUSH` is not in the environment file. The start-up summary then says
  `phone push:          off (set MAKA_CLOUD_EXPO_PUSH=1 to turn it on)`.
- Nothing about the plan vault is set; there is nothing to set. Tasks use the model gateway with the
  owner's keys, as in the runbook.
- `MAKA_CLOUD_AGENT_USER` and `MAKA_CLOUD_AGENT_GROUP` are set, and every sandbox machine has that
  account (see "The agent account" in `docs/fork/deploy.md`). Without them no CLI starts and every
  task fails at once, so a launch host without them serves nobody.
- The go-live rehearsal (`deploy/rehearsal/`, the `rehearsal` CI job) runs with the same three off.
  Read its green run for what it covers (below), not as proof of the launch path on a real host.

## Sign-in: what to check with the first real token

- The web session is the `__Host-maka-session` cookie (`HttpOnly; Secure; SameSite=Strict`),
  read only on requests that send `X-Maka-Cookie: 1`. It needs the app and `/v1` on one https
  origin, which the Caddyfile gives. Check in the browser's storage panel that the cookie is
  there after signing in, that a reload stays signed in, and that signing out removes it.

- Sign in with Apple: the app passes the server's nonce to Apple unchanged, and the token's nonce
  claim must equal it. Check this form with a real Apple token in the live run. The tests use a
  fake signer, so a mismatch (for example if Apple returns the nonce hashed) would show only then.
  Until then, email code and Google are the other ways in, and the invite token always works.
- `MAKA_CLOUD_TRUST_PROXY` names the proxy's address (default loopback; Compose sets Caddy's fixed
  address), so sign-in limits count each client and not the proxy, and a caller that reaches the
  server directly cannot forge its way past them. Check that two phones on different networks do
  not share one limit, and that the server is not reachable from outside except through the proxy.

## What the rehearsal verifies, and what it does not

The rehearsal's sandbox stand-in has a real second OS account (`maka-agent`), a group it shares with
the sandbox user and passwordless `sudo` for the sandbox user, and the scripted `claude` speaks the
Agent SDK's stream-json protocol. So every step of the flow runs with the agent account, and none is
an expected failure any more. The CI run on the pull request that added it (Docker, Compose, Caddy)
passed all seven steps:

| Step | Status in the rehearsal |
| --- | --- |
| `health`, `sign-in` | passes |
| `task` (a task and its result card) | passes |
| `approval` (an approval answered once) | passes |
| `restart` (a restart in the middle of a task) | passes (a close lets go of the runs, so it takes seconds; before that, a minute: Compose waited out its 60 s grace period) |
| `restart-reply` | passes |
| `backup-restore` (backup, restore, a task still runs) | passes |

**Gate for the first live run: a coding task's checkout.** The `task` step runs the `free` playbook, which
never clones a repository, so it cannot show the agent account working in a checkout. The launch-path
review found that it could not: the checkout was cloned under `umask 077` with the agent outside its group
(fixed on main by #312), `repro.json` is written to a directory the agent cannot write, and git as the agent
refuses the checkout ("dubious ownership"; the sandbox user owns it). The rehearsal's `checkout` step runs
a coding task through the server's own clone script and has the scripted agent, as the agent account, read
its brief, edit a file of the checkout, run `git status` there and write the `repro.json` the brief names;
it then needs the runner to read that file, run the reproduction test in its check namespace, and go on to the task's own tests. It is a gate, not an expected
failure (it is not in `MAKA_REHEARSAL_XFAIL`): the `rehearsal` job is the launch check and stays red
until the step passes, and **the first live run does not start until it does.**

- [ ] `checkout` passes in CI (needs the `repro.json` move and the `safe.directory` fix to have landed).

Still not verified by the rehearsal, so the first run on a real host is the first time they run:

- Unprivileged user namespaces on the instabox image. Every check of a coding task runs under `unshare --user --pid`;
  Docker's default seccomp profile refuses it (the rehearsal's box must allow it), and whether instabox does is
  unknown. Where it is refused, no check can run and the task fails with the message "the check … could not run:
  the sandbox could not start the check in its own user and PID namespace (unshare --user --pid failed …)". Live-run
  check: run `unshare --user --map-current-user --pid --fork true` as the sandbox user on the real box first.
- The firewall is a stand-in that keeps its rules in files: the egress guard's rules are checked as
  text, no packet is filtered.
- The CLI is scripted: the real `claude`'s flags, its own files and its network use are not exercised.
- The agent starts under `env -i` with named variables only (`asAgentUser`, isolation F8). `USER`, `LOGNAME`
  and `SHELL` are set by the entry from the agent account; whether the real `claude -p` starts without any
  other variable the box's exec carried is not shown. Before the first task, run the real `claude -p` once
  under the exact `asAgentUser` line on the real box.
- The sandbox user may run any command as root in the stand-in; a real box need not allow that.
- Any model, GitHub, certificate or domain, and the owner's keys and budget.

## Why these three

Each adds a second way to reach a sandbox, a credential or a GitHub repository, and the open review
items on them are not on the path a first user takes. Leaving them off cuts scope without leaving a
gap in what a first user does: sign in, give a goal, see the result card, approve, restart safely.
That path is built, unit-tested and run end to end by the rehearsal on stand-ins (see above).

A close lets go of the runs without stopping them, and lease renewals stop with it, so a task's
sandbox lease runs out five minutes (the default `leaseTtlSeconds`) after the last renewal. A
restart that takes longer than that lets the sandbox go to sleep under its running agent. What the
next process does depends on the runner. A runner that can resume (`recover`, the Claude runner) is
stopped where it was left and runs the task again from a fresh clone, as after a crash. **The
coding runner cannot**: its task is stopped and ended as failed ("orphaned: the orchestrator
restarted while this task was running"), and the owner sends the goal again. If the change had
already passed its checks, it is on the host (`keepUntilReviewed`) and the failed task shows it as
kept for the owner to look at, as a task that fails or is stopped in the same state does.
A forced exit (the process was still closing after ten seconds) exits with code 1 and logs
`server.exit_forced`.

Run one server per data directory. A second one over the same directory refuses to start
(`DatabaseInUseError`) before it touches the spend journal or the task log, and the first keeps
running. With a fixed gateway port on the same machine the second one is refused earlier, by the
port (`EADDRINUSE`): same outcome, nothing of the first touched. See
`design/durable-tasks.md`, "One process owns a task store".
