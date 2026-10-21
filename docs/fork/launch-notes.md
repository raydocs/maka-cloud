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
- The go-live rehearsal (`deploy/rehearsal/`, the `rehearsal` CI job) runs with the same three off,
  so its green run is the launch path.

## Why these three

Each adds a second way to reach a sandbox, a credential or a GitHub repository, and the open review
items on them are not on the path a first user takes. Leaving them off cuts scope without leaving a
gap in what a first user does: sign in, give a goal, see the result card, approve, restart safely.
