# The go-live rehearsal

A rehearsal of the first deploy that costs nothing: the same images, the same Compose file and the
same Caddyfile as a real host (`deploy/`), with stand-ins for what costs money. It catches what the
runbook never ran: a Dockerfile that does not build, a proxy that does not pass the event stream, a
health check that never goes green.

| Part | What it is |
| --- | --- |
| `compose.yaml` | adds the `stubs` service to `deploy/compose.yaml`, and gives the rehearsal its own project name (`maka-rehearsal`) and image tags |
| `lib.sh` | the one place that runs Compose (`-p maka-rehearsal`), and `guard_rehearsal`, which every script calls before it changes the stack |
| `compose.env` | the three names (`app`, `mcp`, `models` on `.localhost`) and Caddy's own certificate authority (`local_certs`) |
| `server.env` | the server's settings: fake keys, the stand-ins as the model and sandbox APIs |
| `stubs.mjs` | the model API and the sandbox API, and a control API for the scripted `claude` |
| `up.sh`, `down.sh` | build and bring the stack up behind Caddy and check it over TLS; take it down |
| `flow.mjs` | the flow: sign in, a task and its result card, an approval, a restart, a backup and a restore |
| `ops.sh` | what the flow does to the Compose stack: stop, start, restart, backup, restore |

```sh
export MAKA_REHEARSAL_DIR=/tmp/rehearsal
deploy/rehearsal/up.sh                    # needs Docker, and ports 80 and 443
set -a; . "$MAKA_REHEARSAL_DIR/env"; set +a
node deploy/rehearsal/flow.mjs            # Node 22 or later
deploy/rehearsal/down.sh
```

## Never the deployment's project

`down.sh` deletes volumes, and `ops.sh` stops, restores and backs up, so the rehearsal must not be able
to reach a real deployment on the same host (project `maka-cloud`, volumes `maka-cloud_maka-data`,
`maka-cloud_maka-backups` and Caddy's state, images `maka-cloud:local` and `maka-cloud-proxy:local`).
It has its own project, `maka-rehearsal` (the override names it, and every call passes `-p`), its own
volumes, networks and containers, and builds its own images (`maka-rehearsal:local`,
`maka-rehearsal-proxy:local`) instead of retagging the deployment's. Before any step that changes the
stack, `guard_rehearsal` reads the resolved Compose configuration and refuses unless the project, every
volume and every image are the rehearsal's. `MAKA_REHEARSAL_PROJECT` may rename the project, but only to
`maka-rehearsal` or a name that starts with `maka-rehearsal-`. The rehearsal publishes ports 80 and 443,
so it cannot start next to a running deployment on the same ports either (set `MAKA_CLOUD_HTTP_PORT` and
`MAKA_CLOUD_HTTPS_PORT` in `compose.env` to run both).

`up.sh` leaves, in `$MAKA_REHEARSAL_DIR`, the server's settings (`server.env`), the invite's token
(`token`), the root certificate of Caddy's authority (`ca.crt`) and the settings the flow reads (`env`).

## The flow

`flow.mjs` plays a first user and the first operator against the stack, over HTTP only:

1. `health`: the health check passes through the proxy, over TLS.
2. `sign-in`: the invite's token opens the API; no token and a wrong one do not.
3. `task`: a message starts a task; the result card (an inbox item of kind `finished`) and the
   closing message arrive.
4. `approval`: two tasks in one conversation; the second is held for the user. Each approval card is
   answered, the first one twice (the second answer must be a duplicate), and exactly that many
   answers are recorded and tasks run.
5. `restart`: the server restarts while a task is running in the sandbox; the task resumes and
   finishes once, with one result card.
6. `restart-reply`: the conductor, whose turn the restart cut, follows the resumed task and, when it
   ends, says so in the conversation, once.
7. `backup-restore`: the server is stopped and backed up, something new happens, the backup is
   restored, and the conversations and the inbox are as they were; a new task still runs.

A conversation after the first holds each delegation for approval (the invite's memory has read
content from outside), so a step that waits for work answers the approval cards it meets.

### Against another host

The flow reads where to go from `MAKA_REHEARSAL_URL`, `MAKA_REHEARSAL_TOKEN_FILE`,
`MAKA_REHEARSAL_CA` and `MAKA_REHEARSAL_RESOLVE` (see the head of `flow.mjs`), steers the scripted
`claude` through `MAKA_REHEARSAL_CONTROL_URL`, and stops, starts and backs up the server through the
one script in `MAKA_REHEARSAL_OPS`. A second stack on the owner's host, started with this override so
that it runs on the stand-ins, with an `ops.sh` that uses that host's own service commands, runs the
same flow after every merge and daily. Nothing of that is set up yet. Never point the flow at a stack
that has real keys: its tasks are scripted and the control API has no login.

## What the stand-ins are

`stubs.mjs` runs from the server image and uses the test doubles the workspaces already ship, so the
server's real sandbox and model code runs against them:

- **Sandbox API** (`:9100`): `FakeInstabox` from `@maka-cloud/instabox/testing`. A command the server
  runs "in the sandbox" runs for real in the stubs container, with the scripted `claude` installed
  where the server looks for it (`CLAUDE_CLI` from the runners' tests, modes `ok` and `waitinit`).
- **Model API** (`:9101`): `startFakeModel` from `@maka-cloud/conductor/testing/fake-model`, answering
  the conductor from the script in `stubs.mjs`: the user's first message names the scenario
  (`rehearsal: run`, `rehearsal: approve`, `rehearsal: ask`).
- **Control API** (`:9102`, published on `127.0.0.1` only): `POST /mode?mode=waitinit` makes the next
  run of the scripted `claude` stop after it reported its session, `POST /release` lets it go,
  `GET /state` says what it did.

Nothing in the rehearsal calls a real model, sandbox, GitHub or push service, and nothing in it is a
secret: the keys are fake and the token belongs to a database that `down.sh` deletes.

## The agent account

Every CLI runs as an account that is not the sandbox user (`MAKA_CLOUD_AGENT_USER`, `_GROUP`), and
the server checks the box for that account before its first run. The stand-in sandbox is one
container with one user, so it has no such account: a task fails at once with "needs an agent
channel", and the steps that run a task (`task`, `approval`, `restart`, `restart-reply`,
`backup-restore`) are marked as expected failures in the workflow (`MAKA_REHEARSAL_XFAIL`;
`restart-reply?` depends on `restart` and may pass).

What takes them off the list, all of it in this directory:

- the stubs container gets a real second account without sudo, a group shared with the sandbox user
  and passwordless `sudo -n` for the sandbox user (the box image's job on a real host);
- `server.env` sets `MAKA_CLOUD_AGENT_USER` and `MAKA_CLOUD_AGENT_GROUP`, which also turns the
  Agent SDK path on, so the scripted `claude` has to speak its stream-json protocol (`SDK_CLI` in
  the runners' tests does) and the control API's `waitinit` and `release` have to work with it.
