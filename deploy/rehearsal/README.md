# The go-live rehearsal

A rehearsal of the first deploy that costs nothing: the same images, the same Compose file and the
same Caddyfile as a real host (`deploy/`), with stand-ins for what costs money. It catches what the
runbook never ran: a Dockerfile that does not build, a proxy that does not pass the event stream, a
health check that never goes green.

| Part | What it is |
| --- | --- |
| `compose.yaml` | adds the `stubs` service to `deploy/compose.yaml` |
| `compose.env` | the three names (`app`, `mcp`, `models` on `.localhost`) and Caddy's own certificate authority (`local_certs`) |
| `server.env` | the server's settings: fake keys, the stand-ins as the model and sandbox APIs |
| `stubs.mjs` | the model API and the sandbox API, and a control API for the scripted `claude` |
| `up.sh`, `down.sh` | build and bring the stack up behind Caddy and check it over TLS; take it down |

```sh
MAKA_REHEARSAL_DIR=/tmp/rehearsal deploy/rehearsal/up.sh     # needs Docker, and ports 80 and 443
deploy/rehearsal/down.sh
```

`up.sh` leaves, in `$MAKA_REHEARSAL_DIR`, the server's settings (`server.env`), the invite's token
(`token`), the root certificate of Caddy's authority (`ca.crt`) and the settings the flow reads (`env`).

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

## When the server runs the real Agent SDK path

The server starts `claude -p` today. When `createCloudRunnersFromEnv` wires the Agent SDK channel, the
scripted `claude` has to speak its stream-json protocol (`SDK_CLI` in the runners' tests does); the
rehearsal then fails at its first task until `stubs.mjs` installs that one. That is what it is for.
