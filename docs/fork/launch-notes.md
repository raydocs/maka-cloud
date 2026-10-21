# Launch notes: what stays off

The first launch is the default path of `docs/fork/deploy.md`: one sandbox machine per invite, tasks
started by users, the model gateway, approvals and the inbox. Four things are built and tested but
stay off at launch. None of them is needed by a first user, and none is switched on by accident:
each is off unless its setting is present, so the launch environment file simply leaves them out.

| Off at launch | How it is off | What it would change | Turn it on when |
| --- | --- | --- | --- |
| Box pool | `MAKA_CLOUD_BOXES` unset (and `MAKA_CLOUD_BOX_TEMPLATE`, `MAKA_CLOUD_BOX_MAX` unset) | the server would make, sleep and delete sandboxes itself, a pool per invite, instead of the fixed `MAKA_CLOUD_SANDBOXES` machine per invite | the pool's own review items are closed and a second invite needs more than one box |
| Proposed cards | `MAKA_CLOUD_CARDS` unset or `0` | a daily read-only scan of each registered project, with up to 3 one-tap cards in the inbox | the cards' own review items (secrets in GitHub text, rendering as plain text) are closed |
| Deep mode | `MAKA_CLOUD_DEEP_MODE` unset or `0` | the conductor is not told about `deep`, a suggestion of it runs as `standard`, and a user's pick of it runs as `standard` with the notice "Deep mode is not available yet"; `deep` holds `standard`'s values everywhere the modes are read | the provenance gap in `docs/fork/post-launch-backlog.md` (Deep research) is closed |
| Plan vault | not wired: `packages/cloud-plans` is imported by no server package, so no setting turns it on | the user's own Claude or ChatGPT plan used on the boxes (T27) | T27 is finished and reviewed; it needs the box pool first |

## What to check at launch

- `MAKA_CLOUD_SANDBOXES` is set (one machine per invite) and `MAKA_CLOUD_BOXES` is not. The server refuses
  both set, and refuses neither.
- `MAKA_CLOUD_CARDS` is not in the environment file. The start-up summary then says
  `proposed cards:      off (set MAKA_CLOUD_CARDS=1 to turn them on)` and
  `sandbox machines:    N (one per invite)`.
- `MAKA_CLOUD_DEEP_MODE` is not in the environment file. The start-up summary then says
  `deep mode:           off (set MAKA_CLOUD_DEEP_MODE=1 to turn it on)`.
- Nothing about the plan vault is set; there is nothing to set. Tasks use the model gateway with the
  owner's keys, as in the runbook.
- `MAKA_CLOUD_AGENT_USER` and `MAKA_CLOUD_AGENT_GROUP` are set, and every sandbox machine has that
  account (see "The agent account" in `docs/fork/deploy.md`). Without them no CLI starts and every
  task fails at once, so a launch host without them serves nobody.
- The go-live rehearsal (`deploy/rehearsal/`, the `rehearsal` CI job) runs with the same three off.
  Read its green run for what it covers (below), not as proof of the launch path on a real host.

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
| `restart` (a restart in the middle of a task) | passes (about a minute: Compose waits out its 60 s grace period) |
| `restart-reply` | passes |
| `backup-restore` (backup, restore, a task still runs) | passes |

**Gate for the first live run: a coding task's checkout.** The `task` step runs the `free` playbook, which
never clones a repository, so nothing in the rehearsal makes the agent account read or edit a checkout or
write `handoff/repro.json`. A review of the launch-path PRs found that on the launch path it cannot
(the checkout is cloned under `umask 077` and the agent account is not in its group; `repro.json` is
written to a directory the agent cannot write). Until a rehearsal step shows the agent account editing a
file in a real checkout and writing `handoff/repro.json`, and that step passes, no coding task has been
shown to work and **the first live run does not start**. This is a gate, not an expected failure: it is
not in `MAKA_REHEARSAL_XFAIL`, and the line below is struck out only when the step is in the flow and green.

- [ ] Rehearsal step `checkout`: the agent account edits a file in the checkout of a coding task and writes
  `handoff/repro.json`, and the host reads it.

Still not verified by the rehearsal, so the first run on a real host is the first time they run:

- The firewall is a stand-in that keeps its rules in files: the egress guard's rules are checked as
  text, no packet is filtered.
- The CLI is scripted: the real `claude`'s flags, its own files and its network use are not exercised.
- The sandbox user may run any command as root in the stand-in; a real box need not allow that.
- Any model, GitHub, certificate or domain, and the owner's keys and budget.

## Why these three

Each adds a second way to reach a sandbox, a credential or a GitHub repository, and the open review
items on them are not on the path a first user takes. Leaving them off cuts scope without leaving a
gap in what a first user does: sign in, give a goal, see the result card, approve, restart safely.
That path is built, unit-tested and run end to end by the rehearsal on stand-ins (see above).
