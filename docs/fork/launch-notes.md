# Launch notes: what stays off

The first launch is the default path of `docs/fork/deploy.md`: one sandbox machine per invite, tasks
started by users, the model gateway, approvals and the inbox. Three things are built and tested but
stay off at launch. None of them is needed by a first user, and none is switched on by accident:
each is off unless its setting is present, so the launch environment file simply leaves them out.

| Off at launch | How it is off | What it would change | Turn it on when |
| --- | --- | --- | --- |
| Box pool | `MAKA_CLOUD_BOXES` unset (and `MAKA_CLOUD_BOX_TEMPLATE`, `MAKA_CLOUD_BOX_MAX` unset) | the server would make, sleep and delete sandboxes itself, a pool per invite, instead of the fixed `MAKA_CLOUD_SANDBOXES` machine per invite | the pool's own review items are closed and a second invite needs more than one box |
| Proposed cards | `MAKA_CLOUD_CARDS` unset or `0` | a daily read-only scan of each registered project, with up to 3 one-tap cards in the inbox | the cards' own review items (secrets in GitHub text, rendering as plain text) are closed |
| Plan vault | not wired: `packages/cloud-plans` is imported by no server package, so no setting turns it on | the user's own Claude or ChatGPT plan used on the boxes (T27) | T27 is finished and reviewed; it needs the box pool first |

## What to check at launch

- `MAKA_CLOUD_SANDBOXES` is set (one machine per invite) and `MAKA_CLOUD_BOXES` is not. The server refuses
  both set, and refuses neither.
- `MAKA_CLOUD_CARDS` is not in the environment file. The start-up summary then says
  `proposed cards:      off (set MAKA_CLOUD_CARDS=1 to turn them on)` and
  `sandbox machines:    N (one per invite)`.
- Nothing about the plan vault is set; there is nothing to set. Tasks use the model gateway with the
  owner's keys, as in the runbook.
- `MAKA_CLOUD_AGENT_USER` and `MAKA_CLOUD_AGENT_GROUP` are set, and every sandbox machine has that
  account (see "The agent account" in `docs/fork/deploy.md`). Without them no CLI starts and every
  task fails at once, so a launch host without them serves nobody.
- The go-live rehearsal (`deploy/rehearsal/`, the `rehearsal` CI job) runs with the same three off.
  Read its green run for what it covers (below), not as proof of the launch path.

## What the rehearsal does not verify yet

The rehearsal's sandbox is a single-user stand-in with no second OS account, so every step that
runs a task fails by design and is listed as an expected failure in
`.github/workflows/fork-deploy-rehearsal.yml` (`MAKA_REHEARSAL_XFAIL`). A green run therefore proves
the image build, the Compose and Caddy stack, TLS, the health check and sign-in, and nothing about
tasks:

| Step | Status in the rehearsal | Unverified until |
| --- | --- | --- |
| `health`, `sign-in` | runs and passes | (covered) |
| `task` (a task and its result card) | expected failure | the stand-in has the agent account |
| `approval` (an approval answered once) | expected failure | the same |
| `restart` (a restart in the middle of a task) | expected failure | the same |
| `restart-reply` | expected failure (may pass when `restart` does) | the same |
| `backup-restore` (backup, restore, a task still runs) | expected failure | the same |

What takes them off the list is written in `deploy/rehearsal/README.md`, "The agent account": a real
second account in the stub container, a shared group, passwordless `sudo -n` for the sandbox user
and stand-ins for the firewall tools the box check tries, and the scripted `claude` speaking the
Agent SDK's stream-json protocol. Until that is done, the first run on a real host is the first time
a task runs end to end with the agent account, and it needs the owner's keys and budget.

## Why these three

Each adds a second way to reach a sandbox, a credential or a GitHub repository, and the open review
items on them are not on the path a first user takes. Leaving them off cuts scope without leaving a
gap in what a first user does: sign in, give a goal, see the result card, approve, restart safely.
That path is built and unit-tested; the rehearsal does not yet run it end to end (see above).
