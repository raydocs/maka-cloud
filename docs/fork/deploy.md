# Deploying maka-cloud on one host

This is the runbook for the internal beta: one Linux host runs the server, a TLS
proxy sits in front of it, and every task runs in a sandbox of its own (one per
invite). Nothing here was run against a real host, a real proxy or a real push
service. The unit file, the compose file, the Dockerfile and the Caddyfile are
real files under `deploy/` (checked with `docker compose config` and
`caddy validate`); try them on a throwaway host first.

Every command below that starts with `maka-cloud` is
`node /opt/maka-cloud/packages/cloud-host/dist/cli.js <command>`; make a shell
alias or a one-line script if you want the short form. `cloud-server` is
`node /opt/maka-cloud/packages/cloud-server/dist/cli.js`.

## First live run: what you provide

Everything the first live run needs from you, in the order you will need it.
Nothing here is spent or sent until you run the smoke command at the end. The
steps below were checked in a dry run on a clean checkout (build, `check`, a
start on loopback with fake keys and a local stand-in for the model and
sandbox APIs, a backup and a restore, `pause` and `resume`, and the web app
through a proxy); the real model, sandbox and GitHub calls, the proxy, systemd
and Compose were not run.

**1. A host and three names**

- One Linux host with Node 22.19 or later (or 24) and `git`. It makes outbound
  HTTPS calls to `api.anthropic.com`, `api.instabox.sh` and `api.github.com`,
  and to `api.openai.com` and the DeepSeek API if you set those keys.
- Three DNS names with TLS certificates that point at the host: one for the
  app and API (`app.example.com`), one for the MCP endpoint
  (`mcp.example.com`) and one for the model gateway (`models.example.com`).
  The sandboxes reach the last two over the internet; the server itself binds
  to loopback and the proxy is the only thing listening on 443. See the proxy
  section for nginx and Caddy files.

**2. Keys, in `/etc/maka-cloud.env` (root only, never in the repository)**

| Variable | When | What it is |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required | Claude, through the gateway (conductor, runs, checks). Set a monthly limit on this key at the vendor as well. |
| `INSTABOX_API_KEY` | required | the sandbox provider's API key |
| `MAKA_CLOUD_SANDBOXES` | required | `'{"<invite id>":"<machine id>"}'`, one sandbox machine per invite, none shared |
| `MAKA_CLOUD_MCP_PUBLIC_URL`, `MAKA_CLOUD_GATEWAY_PUBLIC_URL` | required | `https://mcp.example.com/mcp` and `https://models.example.com` |
| `MAKA_GITHUB_TOKEN` | for a pull request | a fine-grained token (it starts `github_pat_`) limited to the scratch repository, with Contents and Pull requests read and write. Classic, OAuth and app tokens are refused. |
| `DEEPSEEK_API_KEY` | recommended | web search for research tasks; without it they get no search tool |
| `OPENAI_API_KEY`, `MAKA_CLOUD_GATEWAY_MODELS`, `MAKA_CLOUD_VERIFIER_MODELS` | recommended | a model of another vendor that checks finished work; without a verifier model only the checks that need none run |
| `CLOUD_PUSH_VAPID_PUBLIC`, `CLOUD_PUSH_VAPID_PRIVATE`, `CLOUD_PUSH_SUBJECT` | optional | Web Push; make the pair with `node_modules/.bin/web-push generate-vapid-keys` in the checkout (it works offline) |

**3. A sandbox machine for each invite**

- Create the machine in the sandbox provider's console, from an image with
  `node` and `npm`, `git`, `bash` and the usual coreutils, and with outbound
  HTTPS (to your two public names, to `github.com` and to the npm registry).
  The first task on a machine installs the Claude CLI there with `npm`.
- Make one for you and one more for the smoke invite. Never share a machine
  between invites.

**4. The scratch repository for the coding scenario**

- Make it **public**. The sandbox clones `https://github.com/<repo>.git`
  without a token; the token stays on the server and is used only to push the
  branch and open the pull request. A private repository fails at the clone.
- Put one commit in it (a README), so there is a branch to start from.

**5. Two invites and their limits**

```sh
cloud-server invite create --invites /var/lib/maka-cloud/invites.db --label "owner"
cloud-server invite create --invites /var/lib/maka-cloud/invites.db --label "smoke"
cloud-server invite limits --invites /var/lib/maka-cloud/invites.db inv_<smoke> --daily 5 --monthly 10
```

Add both ids to `MAKA_CLOUD_SANDBOXES` and restart. While you test, also set
`MAKA_CLOUD_SERVER_DAILY_USD` to the same amount as the smoke budget, so the
whole server cannot spend more than that in a day either.

**6. The gated smoke run**

Fill `/etc/maka-cloud-smoke.env` as in the smoke section below, with
`MAKA_CLOUD_SMOKE_MAX_USD=5` and the smoke invite's daily limit at 5 or less
(the command refuses otherwise), then run the one command:

```sh
sudo -u maka-cloud bash -c 'set -a; . /etc/maka-cloud-smoke.env; set +a; \
  exec node /opt/maka-cloud/packages/cloud-host/dist/cli.js smoke'
```

The hard cap is the run budget: from the moment the command starts, the gateway
refuses any model request of the smoke invite that would take what the invite
has booked since then (held and settled, every scenario together) above
`MAKA_CLOUD_SMOKE_MAX_USD`, across UTC midnight and across the restart scenario.
The cap is kept in the gateway journal file itself, so it binds every process
that books into it, even a server still running an older version (one that stamps
no run generation books nothing on an invite that has had a run), and the
command refuses to start if the file does not carry it. The budget is
also the amount at which the run stops starting new scenarios. The run refuses
without `MAKA_CLOUD_LIVE=1`, so nothing happens by accident. If a model key is
wrong, the research and coding scenarios say so within seconds instead of
waiting out their timeouts.

## What runs

`maka-cloud start` is one Node process (Node 22.19 or later, or 24) that listens
on three ports. All three bind to 127.0.0.1 unless you say otherwise.

| Port (default) | What it is | Who reaches it |
| --- | --- | --- |
| 8080 `MAKA_CLOUD_PORT` | the public API, `/v1/...`, the event stream and `/healthz` | browsers, through the proxy |
| 8081 `MAKA_CLOUD_MCP_PORT` | the orchestrator's MCP endpoint | the sandboxes, through the proxy |
| 8082 `MAKA_CLOUD_GATEWAY_PORT` | the model gateway; every model request of every task goes through it | the sandboxes, through the proxy |

The sandboxes live outside your host, so the MCP endpoint and the gateway must
be reachable from the internet. Both want a bearer token that is made per task
and revoked when the task ends. The gateway's URL must be `https` (the
variable is refused otherwise, except on a loopback host).

The web app is a static build. The proxy serves it and sends `/v1` and `/healthz`
to port 8080, so the page and the API share one origin (Web Push needs HTTPS).

## Install

```sh
git clone https://github.com/raydocs/maka-cloud /opt/maka-cloud
cd /opt/maka-cloud
npm ci
npm run build
npm --prefix packages/cloud-web ci --workspaces=false
npm --prefix packages/cloud-web run build        # writes packages/cloud-web/dist
```

Make a user for the service and give it the data and backup directories:

```sh
useradd --system --home /var/lib/maka-cloud --shell /usr/sbin/nologin maka-cloud
install -d -o maka-cloud -g maka-cloud -m 700 /var/lib/maka-cloud /var/backups/maka-cloud
```

The backup directory has to be outside the data directory (`maka-cloud check`
refuses it otherwise). Put it on another disk if you can: a backup on the disk
that failed does not help.

## Secrets and file permissions

The keys are environment variables, read once at start. Keep them in one file
that only root can read (systemd and Compose read it as root and pass the values
on), and nowhere else:

```sh
install -m 600 -o root -g root /dev/null /etc/maka-cloud.env
$EDITOR /etc/maka-cloud.env        # NAME=value lines, no "export"
```

A value that holds quotes or spaces, the JSON ones such as `MAKA_CLOUD_SANDBOXES`,
goes in single quotes, which systemd, Compose and the shell all read the same
way: `MAKA_CLOUD_SANDBOXES='{"inv_0123456789ab":"machine-dana"}'`.

- `ANTHROPIC_API_KEY`, `INSTABOX_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`,
  `MAKA_GITHUB_TOKEN` and `CLOUD_PUSH_VAPID_PRIVATE` are secrets. Only
  `ANTHROPIC_API_KEY` and `INSTABOX_API_KEY` are required.
- The repository is public. Never commit this file, and never paste a key into a
  unit file, a compose file or a shell history: systemd and compose can both
  read the file itself.
- The data directory holds the databases, which hold invite digests and your
  users' conversations. Mode 700, owned by the service user. The server creates
  its own files with that in mind, but the directory is what keeps others out.
- A backup holds no keys, no environment and no push subscriptions (devices turn
  notifications on again after a restore). It does hold conversations, so give it
  the same protection as the data directory.
- Logs are JSON lines on standard output. Keys, tokens, key-shaped strings and
  model vendor names are removed before a line is written, but treat the log as
  private anyway.

To make the VAPID keys for Web Push, use any tool that makes a P-256 pair, for
example `npx web-push generate-vapid-keys`. `CLOUD_PUSH_SUBJECT` is a `mailto:`
or `https:` contact for the push services.

## Run it under systemd

Install `deploy/maka-cloud.service` as `/etc/systemd/system/maka-cloud.service`
(it expects the checkout in `/opt/maka-cloud`, the settings in
`/etc/maka-cloud.env`, and the user and directories from the section above):

```sh
install -m 644 deploy/maka-cloud.service /etc/systemd/system/maka-cloud.service
systemctl daemon-reload
systemctl enable --now maka-cloud
journalctl -u maka-cloud -f
```

Check the settings before the first start. `check` prints what the server would
use, without secrets, and exits 2 with every problem it found:

```sh
( set -a; . /etc/maka-cloud.env; set +a
  MAKA_CLOUD_DATA_DIR=/var/lib/maka-cloud MAKA_CLOUD_BACKUP_DIR=/var/backups/maka-cloud \
    node /opt/maka-cloud/packages/cloud-host/dist/cli.js check )
```

Starting runs nothing by itself: a task starts only when a user posts a message.

## Run it under Docker Compose

`deploy/Dockerfile` builds the server and a Caddy image with the web app in it,
and `deploy/compose.yaml` runs both: the server is reached only through Caddy,
which publishes ports 80 and 443 (`MAKA_CLOUD_HTTP_PORT` and
`MAKA_CLOUD_HTTPS_PORT` change them). The server's data is the volume
`maka-data` (at `/data`) and its backups are the volume `maka-backups` (at
`/backups`, outside the data directory as `check` requires); Caddy's
certificates are kept in `caddy-data`.

Put the server's settings in `/etc/maka-cloud.env` (or point
`MAKA_CLOUD_ENV_FILE` at another file) and the three names in a second file
that Compose reads for its own substitutions:

```sh
# /etc/maka-cloud.compose.env
MAKA_CLOUD_APP_NAME=app.example.com
MAKA_CLOUD_MCP_NAME=mcp.example.com
MAKA_CLOUD_MODELS_NAME=models.example.com
```

```sh
docker compose -f deploy/compose.yaml --env-file /etc/maka-cloud.compose.env up -d --build
```

Under Compose, run the commands below as
`docker compose -f deploy/compose.yaml run --rm --no-deps maka-cloud <command>`
(the image's entry point is `maka-cloud`), for example `check` or `backups`.
`backup` and `restore` need the server stopped: `docker compose -f
deploy/compose.yaml stop maka-cloud` first. Copy the `maka-backups` volume off
the host as the backup section says.

## Rehearse it first

`deploy/rehearsal/` brings the same images, Compose file and Caddyfile up with stand-ins for the model
and the sandbox, on `app.localhost`, `mcp.localhost` and `models.localhost` with Caddy's own
certificate authority, and runs the whole first-user flow on them: sign in with an invite, a task and
its result card, an approval answered once, a restart in the middle of a task, a backup and a restore.
CI runs it on every pull request and daily (`.github/workflows/fork-deploy-rehearsal.yml`); to run it
by hand, see `deploy/rehearsal/README.md`. It runs in its own Compose project (`maka-rehearsal`), with its
own volumes and image tags, and refuses to touch anything else, so it cannot stop or delete a deployment
on the same host. It costs nothing and uses no key. What it does not cover is
the real model, the real sandbox, GitHub, a real certificate and a real domain: the first live run
still needs everything under "First live run: what you provide".

## What goes into an image

The Docker build context is an allowlist (`.dockerignore`): the root manifests, `packages/`, the one
script the core package's build runs and `deploy/Caddyfile`. The Dockerfile copies those paths by
name, never the whole context. An `.env`, an `.npmrc` with a registry token or a key left in the
checkout is not sent to the build and is in no layer. `packages/cloud-host/src/__tests__/docker-context.test.ts`
checks the context against the tracked files and a list of secret-shaped names.

## The TLS proxy

Three public names, all with certificates: one for the app and API, one for the
MCP endpoint, one for the gateway. Set the matching variables to those URLs:

- `MAKA_CLOUD_MCP_PUBLIC_URL=https://mcp.example.com/mcp` (the whole MCP endpoint
  as a sandbox reaches it; the server's own path is `/mcp`)
- `MAKA_CLOUD_GATEWAY_PUBLIC_URL=https://models.example.com` (https only; the
  gateway adds its own paths)

The event stream (`GET /v1/events`) is Server-Sent Events: one response that
stays open and carries a heartbeat every 15 seconds. A proxy that buffers the
response, compresses it or times out an idle upstream breaks live updates. The
server already sends `X-Accel-Buffering: no`; the settings below make the proxy
honor it.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name app.example.com;
    # ssl_certificate / ssl_certificate_key from your certificate tool

    root /opt/maka-cloud/packages/cloud-web/dist;
    index index.html;

    location = /sw.js {                      # the worker must always be fresh
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri /index.html;
    }

    location ~ ^/(v1/|healthz$) {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;                 # keep the event stream flowing
        proxy_cache off;
        gzip off;
        proxy_read_timeout 1h;               # the heartbeat is 15 s; stay well above it
        proxy_send_timeout 1h;
        client_max_body_size 1m;             # the API refuses bodies over 64 KiB itself
    }
}

server {
    listen 443 ssl;
    server_name mcp.example.com;
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}

server {
    listen 443 ssl;
    server_name models.example.com;
    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_buffering off;                 # model responses stream too
        proxy_read_timeout 1h;
        client_max_body_size 32m;
    }
}
```

### Caddy

`deploy/Caddyfile` is the file the Compose setup uses. It reads the three names
from `MAKA_CLOUD_APP_NAME`, `MAKA_CLOUD_MCP_NAME` and `MAKA_CLOUD_MODELS_NAME`,
the server's host name from `MAKA_CLOUD_UPSTREAM` (default `maka-cloud`, the
Compose service; use `127.0.0.1` for a Caddy on the host) and serves the web
app from `/srv/web`. For a Caddy on the host, copy the web build there
(`packages/cloud-web/dist`) and set `root` to it.

Caddy compresses only with `encode`; do not add it to the `@api` handler.

To test the stream through the proxy, open a conversation in the app and watch
messages appear without a reload, or run
`curl -N -H "Authorization: Bearer $TOKEN" 'https://app.example.com/v1/events'`
and expect `: stream open` at once and `: keep-alive` every 15 seconds.

## Health check

`GET /healthz` needs no token and answers `{"status":"ok"}` (200) when the
database answers and the server is not shutting down, otherwise
`{"status":"unavailable"}` (503). The body never says more: no counts, no names.
Point the proxy's upstream check, your uptime monitor and a systemd watchdog
script at it:

```sh
curl -fsS https://app.example.com/healthz
```

## The environment

Every variable the server reads. This table is checked against the code by a
test, so a variable that is added or renamed without changing this file fails
the build. Run `maka-cloud` with no arguments for the same list.

<!-- env:start -->
| Variable | What it does |
| --- | --- |
| `MAKA_CLOUD_DATA_DIR` | required: directory for the databases, handoff files and conductor storage |
| `MAKA_CLOUD_BACKUP_DIR` | directory for the daily backup (kept 7 days, no keys inside); outside the data directory. Unset: no backups |
| `MAKA_CLOUD_TASK_TURN_USD` | the most one run of a task (a start, or a resume after a restart) may spend in model calls, on top of the task’s own budget; above 0. Unset: no turn limit |
| `MAKA_CLOUD_TASK_RUN_HOURS` | how long a task may run in all, over every attempt and restart, before it is stopped with a note (default 4, at most 168) |
| `MAKA_CLOUD_TIMELINE_CONTENT` | set to 1 to let a task’s timeline show what each step did (its command or file); by default it shows only the kind of step, its state and its timing |
| `MAKA_CLOUD_AGENT_USER` | the account every CLI (Claude, Codex) runs as inside a sandbox (not the sandbox user, no sudo); with MAKA_CLOUD_AGENT_GROUP it also turns on Agent SDK runs, the step log and the stored conversation. Unset: no CLI is started |
| `MAKA_CLOUD_AGENT_GROUP` | the group the sandbox user and that account share; goes with MAKA_CLOUD_AGENT_USER |
| `MAKA_CLOUD_SPEND_ALERT_USD` | send a push notification to the owner’s devices once a UTC day’s spend reaches this many dollars; needs MAKA_CLOUD_OWNER_INVITE and Web Push |
| `MAKA_CLOUD_OWNER_INVITE` | the invite id (inv_…) whose devices get the spend alert; its devices turn notifications on in the web app |
| `MAKA_CLOUD_HOST` | public API host (default 127.0.0.1) |
| `MAKA_CLOUD_PORT` | public API port (default 8080) |
| `MAKA_CLOUD_MCP_HOST` | orchestrator MCP host (default 127.0.0.1) |
| `MAKA_CLOUD_MCP_PORT` | orchestrator MCP port (default 8081) |
| `MAKA_CLOUD_MCP_PUBLIC_URL` | the MCP URL as the sandbox reaches it (http or https) |
| `ANTHROPIC_API_KEY` | required: the model gateway’s key for Claude (the conductor, checks and runs go through it) |
| `ANTHROPIC_BASE_URL` | Messages API base URL, for the conductor and the model gateway |
| `MAKA_CLOUD_LLM_CONNECTION_ID` | stable id of the conductor’s model connection |
| `INSTABOX_API_KEY` | required: sandbox API key |
| `MAKA_CLOUD_SANDBOXES` | required unless MAKA_CLOUD_BOXES=1: JSON object {"<inviteId>": "<sandbox machine>"}, one machine per invite; an invite with no machine runs no tasks |
| `MAKA_CLOUD_BOXES` | 1: the server makes, sleeps and deletes the sandboxes itself, a pool per invite, instead of a fixed machine per invite (do not set MAKA_CLOUD_SANDBOXES); needs MAKA_CLOUD_BOX_TEMPLATE |
| `MAKA_CLOUD_BOX_TEMPLATE` | the sandbox template id new boxes start from; required with MAKA_CLOUD_BOXES=1 |
| `MAKA_CLOUD_BOX_MAX` | the most boxes one invite may have (1 to 32, default 3); when instabox refuses a create the task waits for a free box of its invite |
| `INSTABOX_API_URL` | sandbox API base URL |
| `OPENAI_API_KEY` | the model gateway’s key for Codex runs |
| `OPENAI_BASE_URL` | Responses API base URL for the model gateway |
| `DEEPSEEK_API_KEY` | the model gateway’s key for web search (DeepSeek Search API) |
| `DEEPSEEK_BASE_URL` | DeepSeek API base URL for web search |
| `MAKA_CLOUD_GATEWAY_HOST` | model gateway host (default 127.0.0.1) |
| `MAKA_CLOUD_GATEWAY_PORT` | model gateway port (default 8082) |
| `MAKA_CLOUD_GATEWAY_PUBLIC_URL` | the model gateway as the sandbox reaches it (https, or http on a loopback host) |
| `MAKA_CLOUD_GATEWAY_MODELS` | JSON array of model prices for the gateway: {vendor, model, inputPerMTokUsd, outputPerMTokUsd, cacheReadPerMTokUsd?, maxOutputTokens, longContext?}; Codex models need one |
| `MAKA_CLOUD_MODES` | JSON: the modes (quick, standard, deep) as "maka-cloud modes" prints them: per mode the conductor, implementer, reviewer and helper models and effort, and the budgets; every model named needs a gateway price. Unset: the built-in modes |
| `MAKA_CLOUD_VERIFIER_MODELS` | JSON array of models that check finished work: {vendor, model, inputPerMTokUsd, outputPerMTokUsd}; none means only the checks that need no model run |
| `MAKA_CLOUD_VERIFIER_DAILY_CAP_USD` | daily cap on model checks, default 5; changeable in the inbox settings |
| `MAKA_CLOUD_SUMMARY_MODEL` | model that writes the digest summary (default claude-haiku-5-5) |
| `MAKA_CLOUD_INVITE_DAILY_USD` | most an invite may spend per UTC day unless set with "cloud-server invite limits", default 5 |
| `MAKA_CLOUD_INVITE_MONTHLY_USD` | most an invite may spend per UTC month unless set with "cloud-server invite limits", default 50 |
| `MAKA_CLOUD_SERVER_DAILY_USD` | most all invites together may spend per UTC day, default 25 |
| `CLOUD_PUSH_VAPID_PUBLIC` | Web Push: the VAPID public key (with the next two, turns push on) |
| `CLOUD_PUSH_VAPID_PRIVATE` | Web Push: the VAPID private key, kept in memory only |
| `CLOUD_PUSH_SUBJECT` | Web Push: the VAPID contact, a mailto: or https: URL |
| `CLOUD_PUSH_ALLOWED_HOSTS` | Web Push: comma separated push service hosts, default FCM, Mozilla, Apple, Windows |
| `MAKA_GITHUB_TOKEN` | fine-grained GitHub token for opening pull requests, read when one is opened |
| `MAKA_GITHUB_WEBHOOK_SECRET` | the GitHub App’s webhook secret (16 characters or more), kept in memory only. Set: signed deliveries are accepted at /github/webhook and standing duties run. Unset: no standing duties |
| `MAKA_CLOUD_DEEP_MODE` | 1 turns on deep mode. Off at launch: deep research has a provenance gap that is parked until after launch, so a request for deep runs in standard mode with a notice and the conductor is not told about deep. Unset or 0: off |
| `MAKA_CLOUD_CARDS` | 1 turns on proposed cards: each project is scanned read-only once a day (and after the employee’s own task on it finishes) and offers up to 3 one-tap cards. Needs MAKA_GITHUB_WEBHOOK_SECRET and MAKA_GITHUB_TOKEN. Unset or 0: off |
| `MAKA_CLOUD_DUTY_REPOS` | comma separated owner/name@<installation id>=<invite id> links a project may be registered through: the repository, the GitHub App installation it lives in and the one invite that owns it; needs MAKA_GITHUB_WEBHOOK_SECRET. Unset: no project can be registered |
<!-- env:end -->

`INSTABOX_MACHINE_ID` is not used any more and is refused: one machine for every
invite would let invites read each other.

## Modes

A task runs in one of three modes, `quick`, `standard` or `deep`: the user may pick
one, otherwise the conductor does, from the size of the work and the budget. A mode
sets which model and how much effort the conductor, the implementer, the reviewer
and the helpers use, and the budget of a run. Whatever vendor implemented a coding
change, the other vendor reviews it; no setting can change that.

`maka-cloud modes` prints the modes in force as JSON. To change them, save that
output, edit it and set `MAKA_CLOUD_MODES` to it (the whole config, version 1; a
config of another version is refused). Every model it names needs a price in the
gateway: the Claude models are priced already, a Codex model needs an entry in
`MAKA_CLOUD_GATEWAY_MODELS`. Until you name one, the Codex roles run on the Codex
CLI's own default model, which the gateway cannot price, so a Codex run (and with
it the review of a Claude change) is refused: `maka-cloud check` says how many
roles are in that state.

How a mode is chosen: a mode the user picks for a message that starts a run is that
run's mode, and the run starts with that mode's default budget; the conductor cannot
choose another. Without a pick, the conductor may name a mode for each delegation
(`workMode`), and the run's budget decides whether it is affordable (never `deep`
by itself). The mode's own cap on one delegation holds either way. The mode reaches
the runner as one `maka-mode:` line the conductor's code adds to the brief, right
after any `maka-inputs:` and `maka-artifacts:` lines; a brief the model wrote with
such a line in it is refused. The conductor keeps one model for a conversation, so
a mode sets how hard it thinks, not which model it is; its own thinking effort is
fixed when the conversation's first run opens its session, and its planner's effort
follows each run's mode.

## Standing duties and the GitHub webhook

Standing duties are off until `MAKA_GITHUB_WEBHOOK_SECRET` is set. With it, the
server accepts GitHub App deliveries at `POST /github/webhook` and an invite can
register projects (`/v1/projects`) through the links named in
`MAKA_CLOUD_DUTY_REPOS`. Each link ties a repository to the GitHub App
installation it lives in and to the one invite that owns it
(`acme/widgets@12345678=inv_0123456789ab`); only that invite, under that
installation id, can register the repository. A repository name alone proves
nothing, so no other invite or installation can claim it, and none can be
registered that the operator did not link.

1. In the GitHub App, set the webhook URL to `https://<your host>/github/webhook`
   and a secret of 16 characters or more; put the same secret in
   `MAKA_GITHUB_WEBHOOK_SECRET`. Subscribe the app to workflow runs, issues,
   issue comments, pull request reviews and pull request review comments. Any
   other event is refused.
2. Make the owner's invite first, find the installation id of the app on that
   repository (the number in the installation's URL), write the link in
   `MAKA_CLOUD_DUTY_REPOS` and restart. A repository can be linked once.
3. A project's owner asks for a proposal, and the server offers two to four
   duties as one decision in the inbox. Nothing runs until the owner chooses a
   set. `MAKA_GITHUB_TOKEN` is used read-only to look at the repository for the
   proposal.

Every delivery is checked against its signature before anything else, a
delivery id is handled once, and a run started by an event carries text from
outside the owner, so the conversation is marked as such. A run has the duty's
authority level for its whole life and a budget it cannot raise. The duties
database is `duties.db` in the data directory and is part of the daily backup.

### The agent account, and Claude through the Agent SDK

Every CLI runs as an account that is not the sandbox user: the sandbox user holds the channel the
SDK trusts, the task's files and the egress rules, and the agent's code must not be able to touch
them. A host without `MAKA_CLOUD_AGENT_USER` and `MAKA_CLOUD_AGENT_GROUP` starts no CLI (Claude or
Codex): the run fails at once and says so. Those two also run Claude tasks through the Agent SDK:
the step log, resume after a restart and the stored conversation (`transcripts.db` in the data
directory, part of the daily backup) need it. The box image must have that account (no sudo, not the
sandbox user), a group the sandbox user shares with it, a `claude` binary it can read, and
passwordless `sudo -n` for the sandbox user. Each box is checked before its first SDK turn and a box
that fails the check refuses the turn with the reason.

The check also looks at what the account could do to the egress rules, so code the agent runs
cannot take them away. The sandbox user (it needs `sudo -n`, which the egress guard needs too) reads
the account's sudo rules with `sudo -l -U <account>` and the box passes only when sudo says the
account is not allowed to run anything; a query that fails is a failed check. The account must hold no
Linux capabilities (`CapPrm`, `CapEff`, `CapAmb` all zero), no program under `/usr/sbin`, `/usr/bin`,
`/sbin`, `/bin` or `/usr/local` may carry a capability such as `cap_net_admin` or `cap_setuid`
(the box needs `getcap`, from `libcap2-bin`; without it the check fails), it must not be in a group that
is as good as root (`docker`, `lxd`, `sudo`, `disk`, ...), must not be able to write a container or VM
socket, must not be able to write the sandbox user's home, its `~/.maka-cli` or the work root, and must
not be able to create an iptables or ip6tables chain. What it left behind is removed on every way
out of the check.

The box must also allow unprivileged user and PID namespaces (`unshare --user --map-current-user
--pid` as the sandbox user): every check of a coding task (the repository's tests, the reproduction
test) runs in one, and a box that refuses them, as Docker's default seccomp profile does, makes every
check fail at once with exit 125 ("could not start the check in its own user and PID namespace"). And
the agent runs `git` in a checkout that the sandbox user owns, so git must be told that checkout is
safe for the agent account (`safe.directory`); a box where it is not shows the agent a "dubious
ownership" error on every git command.

The server starts nothing as the sandbox user either. A run is a program and its arguments; the
server quotes them and hands the whole command to the agent account itself, so no argument can add a
command that runs as the sandbox user. The pinned CLI install, which writes the sandbox user's own
`~/.maka-cli`, is its own method and the only run that stays the sandbox user.

Nothing of the CLI is checked, installed or run before the account and the box check pass, a repository's
test commands run as the agent account (the stop that ends them runs as root, since the processes are
the agent's), the CLI's version check refuses a CLI that is not wholly the sandbox user's own and
closed to everyone else and then asks it for its version as the agent account, by absolute path, so
the sandbox user never runs what the agent's tooling may have shaped, and the brief is written in the task directory and renamed into `handoff/`,
so a link the agent leaves there is never followed.

Limits that are not settings: a schedule runs at most every 15 minutes; an invite
has at most 20 enabled duties; a duty whose runs fail 10 times in a row turns
itself off; and at most 3 runs in a row are woken by the checks of their own
branch before a person has to step in. Each of these, and a proposal that does
not fit, is told to the owner as a note in a conversation of the project
("Standing duties: owner/repo"); the note is sent at least once.

## A new invite and its sandbox

An invite is a person (or a test) who may use the app. Each one runs its tasks
on a sandbox machine of its own, so two invites never share a machine, a Unix
user or a process table. An invite with no machine in `MAKA_CLOUD_SANDBOXES`
can talk but runs no tasks.

1. Make a sandbox machine for the invite in the sandbox provider's console and
   copy its machine id.
2. Make the invite. The token is printed once; only its digest is stored:

   ```sh
   sudo -u maka-cloud node packages/cloud-server/dist/cli.js invite create \
     --invites /var/lib/maka-cloud/invites.db --label "Dana"
   ```

   Send the token to Dana through a channel you trust. It is their login.
3. Add the pair to `MAKA_CLOUD_SANDBOXES` in `/etc/maka-cloud.env`, which is a
   JSON object with one machine per invite and no machine used twice:

   ```
   MAKA_CLOUD_SANDBOXES='{"inv_0123456789ab":"machine-dana","inv_ba9876543210":"machine-lee"}'
   ```
4. Restart: `systemctl restart maka-cloud`. The map is read at start.
5. Set a spend limit if the default is wrong for them (the cap applies at once,
   without a restart):

   ```sh
   sudo -u maka-cloud node packages/cloud-server/dist/cli.js invite limits \
     --invites /var/lib/maka-cloud/invites.db inv_0123456789ab --daily 3 --monthly 30
   ```

To remove someone: `invite revoke` ends their streams and tokens at once; then
delete the entry from `MAKA_CLOUD_SANDBOXES` and remove the machine.

## Money controls

- Per-invite and whole-server caps (`MAKA_CLOUD_INVITE_DAILY_USD`,
  `MAKA_CLOUD_INVITE_MONTHLY_USD`, `MAKA_CLOUD_SERVER_DAILY_USD`) are enforced at
  the model gateway, so a task cannot spend past them. The server writes the caps
  it runs under into `gateway-spend.db` at each start; the evals (a second process
  booking spend on this server) read them from there instead of their own
  environment, and refuse to start if their environment sets one of the three to a
  different value.
- `maka-cloud pause` stops all spending within seconds, while the server runs;
  `maka-cloud resume` allows it again (work that was stopped is not restarted).
  Both need `MAKA_CLOUD_DATA_DIR`.
- A spend alert: set `MAKA_CLOUD_SPEND_ALERT_USD` and `MAKA_CLOUD_OWNER_INVITE`
  (the owner's invite id) and the Web Push variables. When a UTC day's spend
  (settled plus held) reaches the amount, each device the owner turned
  notifications on for gets one notification that says only that spend passed
  the alert level. The amount is not in the notification; open the app for it.
  Sending is at least once, as with task notifications: a crash at the wrong
  moment can send it twice. Without Web Push the setting is refused at start,
  because there would be nobody to tell.

## Backups and restore

With `MAKA_CLOUD_BACKUP_DIR` set the running server writes one backup per UTC
day (a minute after it starts if the day has none yet), using SQLite's online
backup so a copy is consistent while the server works. It keeps the newest 7.
A backup is a directory under `MAKA_CLOUD_BACKUP_DIR` named by its UTC time,
holding the four databases (cloud, invites, supervisor, gateway spend), the
runner and delivery state files, the conductor store and the handoff files,
and a manifest with a digest of each file. Push subscriptions are taken out.

```sh
maka-cloud backups               # list them, newest first
maka-cloud backup                # write one now; only with the server stopped
maka-cloud restore <name>        # put one back; only with the server stopped
```

Use the same environment as the service (`MAKA_CLOUD_DATA_DIR` and
`MAKA_CLOUD_BACKUP_DIR`, as the service user). Notes:

- `backup` and `restore` open the databases exclusively, so they refuse while
  the server runs. Stop it first: `systemctl stop maka-cloud`.
- Restore checks the manifest and every file's digest and refuses a backup that
  does not match. It moves what was in the data directory to
  `<data dir>/pre-restore-<time>` and deletes nothing. Delete those by hand when
  you are sure.
- The manifest is not signed: someone who can change both a backup's files and
  its manifest can make a backup that restores. Keep the backup directory as
  private as the data directory.
- After a restore, devices turn notifications on again in the app.
- Copy the backup directory off the host too (`rsync`, `restic`, a bucket). A
  backup on the same disk does not survive the disk.
- Try a restore once on a spare host before you need it.

## Logs

Standard output carries one JSON object per line: `ts`, `level`, `event`, and
the fields of that event. Read them with `journalctl -u maka-cloud -o cat`,
and filter with `jq`, for example `jq 'select(.level != "info")'`. Warnings the
stack raises (a failed backup, a failed alert) arrive as `event: "warning"`.

## The smoke test

`maka-cloud smoke` checks a running server end to end with real models and a
real sandbox: one research task, one coding task that opens a pull request on a
scratch repository, a cancel in the middle of a run, a budget stop, a restart,
and then the orchestrator's cost of each conversation next to the gateway's
journal, flagged when they differ by more than a cent or 10%. **It spends real
money and only you should run it**, after deciding a budget.

It refuses to do anything unless `MAKA_CLOUD_LIVE=1` and every setting below is
present and valid; it checks that before it reads a file or sends a request, and
it names a missing setting, never a value. It does not start another scenario
once the server has spent the budget today. It never approves an irreversible
action except the pull request on the scratch repository.

Preparation:

1. A **public** scratch repository the `MAKA_GITHUB_TOKEN` may open pull requests
   on (the sandbox clones it without a token), with at least one commit.
2. An invite for the smoke test alone, with its own sandbox machine, **and a
   daily limit of its own that is at most `MAKA_CLOUD_SMOKE_MAX_USD`**
   (`invite limits ... --daily`). The run budget (see above) is what bounds the
   whole run; the daily limit is a second ceiling per UTC day, and the
   budget-stop step needs a limit of its own to lower and put back. The command
   refuses (exit 2, before any request) when `MAKA_CLOUD_SMOKE_TOKEN` is not
   that invite's own token, when the invite has no limit of its own or one
   above the budget, or when the server does not enforce the run budget. The
   budget-stop step lowers the daily limit for a few minutes and puts it back.
   If the run is killed in that window, set the limit back by hand: the line
   printed at the start of the step says what it was. One smoke run holds an
   invite's run budget at a time: a second run is refused (exit 2) while the
   first is going. A run that is killed leaves its run budget in place, which
   only holds that invite back; about two minutes after it stopped renewing it,
   the next smoke run takes it over. A takeover first fences the killed run:
   every model key and conductor session issued under it books nothing from then
   on (the invite's generation in the journal moves up), and only then does the
   new run get a budget of its own, starting empty. Every run, takeover or not,
   first stops what an earlier run left going: it cancels each task that has not
   ended, and asks about every task that has (however long ago, since the task
   list cannot show a pending stop and the server's flag has no age limit), because only the server's answer to a cancel says whether the task's run or
   its tree is still being stopped. It sends the cancel again every 5 seconds,
   for up to 3 minutes a task (the server itself retries a stop that failed with
   a growing delay), until the answer says the task ended with nothing pending.
   A task not seen stopped, or a conversation or task list it cannot read to
   its end (a next page after the last one it reads, a cursor that does not move
   forward, an entry of an unexpected shape), means it starts nothing and exits
   2, naming the last error: stop those tasks by hand and run again. A task that
   started after the list was read is not seen. The
   cleanup is repeated by the next run even though the run that failed it has
   cleared its budget. A run that ends clears its budget and fences its own
   keys the same way. A budget left by an older version, without a row
   sequence, books nothing until the next run reopens it. A server on code from
   before run generations can no longer book on the smoke invite once that invite
   has had a run (update every server before the first live run).
3. A command that restarts the server, as a JSON array (no shell is used). The
   service user cannot restart its own unit, so allow exactly that command:

   ```
   # /etc/sudoers.d/maka-cloud-smoke
   maka-cloud ALL=(root) NOPASSWD: /usr/bin/systemctl restart maka-cloud
   ```

Put the settings in a file only the service user can read, so the token never
lands in a shell history, and run the command from it:

```sh
install -m 600 -o maka-cloud -g maka-cloud /dev/null /etc/maka-cloud-smoke.env
$EDITOR /etc/maka-cloud-smoke.env
# MAKA_CLOUD_LIVE=1
# MAKA_CLOUD_SMOKE_URL=https://app.example.com
# MAKA_CLOUD_SMOKE_TOKEN=<the smoke invite's token>
# MAKA_CLOUD_SMOKE_INVITE_ID=inv_0123456789ab
# MAKA_CLOUD_SMOKE_REPO=you/scratch
# MAKA_CLOUD_SMOKE_MAX_USD=5
# MAKA_CLOUD_DATA_DIR=/var/lib/maka-cloud
# MAKA_CLOUD_SMOKE_RESTART_CMD='["sudo","-n","systemctl","restart","maka-cloud"]'

sudo -u maka-cloud bash -c 'set -a; . /etc/maka-cloud-smoke.env; set +a; \
  exec node /opt/maka-cloud/packages/cloud-host/dist/cli.js smoke'
```

It must run on the server's host as the service user, because it reads the
gateway journal and the invites file from the data directory. Delete the file
when you are done.

Settings, for reference:

<!-- smoke:start -->
| Variable | What it does |
| --- | --- |
| `MAKA_CLOUD_LIVE` | must be exactly 1: the smoke test spends real money and runs only on purpose |
| `MAKA_CLOUD_SMOKE_URL` | the server’s public API URL |
| `MAKA_CLOUD_SMOKE_TOKEN` | an invite token reserved for the smoke test |
| `MAKA_CLOUD_SMOKE_INVITE_ID` | that invite’s id |
| `MAKA_CLOUD_SMOKE_REPO` | the scratch repository, owner/name |
| `MAKA_CLOUD_SMOKE_MAX_USD` | the budget you approved for this run, in dollars |
| `MAKA_CLOUD_DATA_DIR` | the server’s data directory |
| `MAKA_CLOUD_SMOKE_RESTART_CMD` | a JSON array: the command that restarts the server |
<!-- smoke:end -->

Exit code 0 means every scenario passed; 1 means one failed (the report says
which and why); 2 means it refused to start.

## Before you give someone a token

- [ ] `maka-cloud check` passes and `GET /healthz` answers through the proxy.
- [ ] The event stream stays open for several minutes through the proxy.
- [ ] A backup was written, copied off the host, and restored once on a spare.
- [ ] The spend alert reaches your phone (turn notifications on in the app,
      then set a low `MAKA_CLOUD_SPEND_ALERT_USD` for a moment).
- [ ] `maka-cloud pause` and `resume` work, and you know where to run them.
- [ ] The owner has run the smoke test within the approved budget.
