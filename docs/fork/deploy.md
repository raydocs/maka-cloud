# Deploying maka-cloud on one host

This is the runbook for the internal beta: one Linux host runs the server, a TLS
proxy sits in front of it, and every task runs in a sandbox of its own (one per
invite). Nothing here was run against a real host, a real proxy or a real push
service; the unit file, the compose file and the proxy settings are written
from the code's own behavior and should be tried on a throwaway host first.

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

The hard cap is the smoke invite's daily limit, which the gateway enforces; the
budget is also the amount at which the run stops starting new scenarios. The
run refuses without `MAKA_CLOUD_LIVE=1`, so nothing happens by accident. If a
model key is wrong, the research and coding scenarios say so within seconds
instead of waiting out their timeouts.

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

`/etc/systemd/system/maka-cloud.service`:

```ini
[Unit]
Description=maka-cloud
After=network-online.target
Wants=network-online.target

[Service]
User=maka-cloud
Group=maka-cloud
WorkingDirectory=/opt/maka-cloud
EnvironmentFile=/etc/maka-cloud.env
Environment=MAKA_CLOUD_DATA_DIR=/var/lib/maka-cloud
Environment=MAKA_CLOUD_BACKUP_DIR=/var/backups/maka-cloud
ExecStart=/usr/bin/node /opt/maka-cloud/packages/cloud-host/dist/cli.js start
Restart=on-failure
RestartSec=5
# SIGTERM closes the stack in order; give it time to stop running work.
KillSignal=SIGTERM
TimeoutStopSec=60
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```sh
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

There is no image in this repository. This file runs the checkout you built
above inside a stock Node image, so the host's `node_modules` and `dist` are
what runs:

```yaml
services:
  maka-cloud:
    image: node:24-slim
    working_dir: /app
    command: ["node", "packages/cloud-host/dist/cli.js", "start"]
    restart: unless-stopped
    env_file: /etc/maka-cloud.env
    environment:
      MAKA_CLOUD_DATA_DIR: /data
      MAKA_CLOUD_BACKUP_DIR: /backups
      MAKA_CLOUD_HOST: 0.0.0.0        # inside the container; publish below only on loopback
      MAKA_CLOUD_MCP_HOST: 0.0.0.0
      MAKA_CLOUD_GATEWAY_HOST: 0.0.0.0
    volumes:
      - /opt/maka-cloud:/app:ro
      - maka-data:/data
      - /var/backups/maka-cloud:/backups
    ports:
      - "127.0.0.1:8080:8080"
      - "127.0.0.1:8081:8081"
      - "127.0.0.1:8082:8082"
    stop_grace_period: 60s
volumes:
  maka-data:
```

Run the container as a user that owns `/data` and `/backups` (add `user:` with
that uid), and give the host side of `/backups` the same mode as in the
systemd setup. Under Compose, run the commands below with
`docker compose run --rm --no-deps maka-cloud node packages/cloud-host/dist/cli.js <command>`.

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

```caddy
app.example.com {
    root * /opt/maka-cloud/packages/cloud-web/dist
    @api path /v1/* /healthz
    handle @api {
        reverse_proxy 127.0.0.1:8080 {
            flush_interval -1          # send every write at once: the event stream
        }
    }
    handle /sw.js {
        header Cache-Control "no-cache"
        file_server
    }
    handle {
        header Cache-Control "no-cache"
        try_files {path} /index.html
        file_server
    }
}

mcp.example.com {
    reverse_proxy 127.0.0.1:8081 {
        flush_interval -1
    }
}

models.example.com {
    reverse_proxy 127.0.0.1:8082 {
        flush_interval -1
    }
}
```

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
| `MAKA_CLOUD_SANDBOXES` | required: JSON object {"<inviteId>": "<sandbox machine>"}, one machine per invite; an invite with no machine runs no tasks |
| `INSTABOX_API_URL` | sandbox API base URL |
| `OPENAI_API_KEY` | the model gateway’s key for Codex runs |
| `OPENAI_BASE_URL` | Responses API base URL for the model gateway |
| `DEEPSEEK_API_KEY` | the model gateway’s key for web search (DeepSeek Search API) |
| `DEEPSEEK_BASE_URL` | DeepSeek API base URL for web search |
| `MAKA_CLOUD_GATEWAY_HOST` | model gateway host (default 127.0.0.1) |
| `MAKA_CLOUD_GATEWAY_PORT` | model gateway port (default 8082) |
| `MAKA_CLOUD_GATEWAY_PUBLIC_URL` | the model gateway as the sandbox reaches it (https, or http on a loopback host) |
| `MAKA_CLOUD_GATEWAY_MODELS` | JSON array of model prices for the gateway: {vendor, model, inputPerMTokUsd, outputPerMTokUsd, cacheReadPerMTokUsd?, maxOutputTokens, longContext?}; Codex models need one |
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
<!-- env:end -->

`INSTABOX_MACHINE_ID` is not used any more and is refused: one machine for every
invite would let invites read each other.

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
   (`invite limits ... --daily`). That limit is the hard cap: the gateway refuses
   every model request past it, whereas the budget alone only keeps another
   scenario from starting once the server has spent it. The command refuses
   (exit 2, before any request) when the invite has no limit of its own or one
   above the budget. The budget-stop step lowers that limit for a few minutes and
   puts it back. If the run is killed in that window, set the limit back by
   hand: the line printed at the start of the step says what it was.
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
