# Super-agent quick start

Two commands after install and build. The default loop never talks to Instabox.
The live smoke does, using `INSTABOX_API_KEY` from the environment (never argv).

**Node.js `^22.19.0 || >=24`.** The store uses `node:sqlite` (stable on 22.19+
and 24). Node 23 is not supported. The owner's local loop ran on Node 24.

## 1. Fake local loop (no secrets)

```bash
npm ci
npm run build -w @maka-cloud/superagent
npm run local-loop -w @maka-cloud/superagent
```

Equivalent last line: `node packages/cloud-superagent/scripts/local-loop.mjs`

This writes a temporary `superagent.db`, then:

1. Replays a GitHub `pull_request` opened delivery → Router spawn, sandbox `echo spawn`, worker sleeps.
2. Reopens the sqlite file (process-restart resume).
3. Replays an `issue_comment` → subscription pass-through (Router is not called).
4. Replays a `workflow_run` failure → pass-through, merge held for exact-text approval.
5. Approves `Merge pull request #12`.
6. Replays a looping issue → watchdog `looping` finding and a T33 stuck card.
7. Prints the tenant usage ledger and evidence blocks.

CI runs the same path as `packages/cloud-superagent/src/__tests__/local-loop.test.ts`
(`npm run test:dist -w @maka-cloud/superagent`).

Expect:

```
sandbox: fake
steps: spawn → resume-store → passthrough-comment → passthrough-ci → approval-request → approved → watchdog:looping
```

## 2. Live Instabox smoke (owner runs this)

Creates the smallest Instabox Pro sandbox (2 vCPU / 4096 MiB; the API rejects
1/512 as `spec_not_allowed`). Allowed sizes: `2/4096`, `4/8192`, `8/16384`.
Runs `echo live-smoke`, and **always deletes the box**, including when exec
fails. Create is long-polled with `GET /v1/operations/{id}?wait=25s` for up to
five minutes (a 4–5s create used to lose a 24-poll tight loop). Destroy waits
for an in-flight create, then retries DELETE on HTTP 409 `operation_conflict`.
Prints timings. Never prints the API key.

When `INSTABOX_TEMPLATE_ID` / `MAKA_CLOUD_BOX_TEMPLATE` are unset, the smoke
uses template `universal` (`base` / `dev` are retired). Override with
`INSTABOX_TEMPLATE_ID` or `INSTABOX_SNAPSHOT_ID`.

Export the key in the shell. Do not put it on the command line.

```bash
export INSTABOX_API_KEY='…'          # already in the environment; not on argv
# optional:
# export INSTABOX_API_URL='https://api.instabox.sh'
# export INSTABOX_TEMPLATE_ID='universal'   # default; or MAKA_CLOUD_BOX_TEMPLATE
npm ci
npm run build -w @maka-cloud/superagent
npm run live-smoke -w @maka-cloud/superagent
```

Equivalent last line: `node packages/cloud-superagent/scripts/live-smoke.mjs`

`INSTABOX_MACHINE_ID` is not used. The smoke makes a throwaway box named
`maka-smoke-<timestamp>` and destroys it.

Expect:

```
ok: true
machine: mch_…
created: true
destroyed: true
exec: echo live-smoke exit=0 stdout="live-smoke"
timings_ms: create=… exec=… delete=… total=…
size: 2 vCPU / 4096 MiB
```

This repository's agents and CI do **not** run the live smoke against Instabox.
Tests mock HTTP only.

## 3. Real loop (fake by default)

A worker clones a scratch repo, applies `FakeCoder`, runs `node add.test.js`,
pushes `maka/sa-<workerId>`, opens a fake PR, resumes on CI/review, and holds
merge for approval.

```bash
npm run build -w @maka-cloud/superagent
npm run real-loop -w @maka-cloud/superagent
```

Live (owner only): `MAKA_CLOUD_LOOP_LIVE=1` plus `INSTABOX_API_KEY`. Clone,
edits and tests run **inside** the box. Public probe:
`MAKA_CLOUD_LOOP_CLONE_URL=https://github.com/owner/scratch.git` (no GitHub
token). Optional `ANTHROPIC_API_KEY` (host-side coder; files applied in the
box) and `MAKA_GITHUB_TOKEN=github_pat_…` with `MAKA_CLOUD_LOOP_REPO`. See
[real-loop.md](real-loop.md). Never put keys on argv.

## 4. Metrics harness (fakes)

```bash
npm run metrics -w @maka-cloud/superagent -- --n 3 --parallel 2 --out /tmp/sa-metrics
```

See [p0-checklist.md](p0-checklist.md) for the rest of the first real run.

## Receive a live GitHub webhook (optional)

```bash
npm run build -w @maka-cloud/superagent
node packages/cloud-superagent/scripts/local-loop.mjs --listen 8787
```

POST deliveries to `http://127.0.0.1:8787/github/webhook` with `X-GitHub-Event` and
`X-GitHub-Delivery`. Supported events: `pull_request`, `issues`, `issue_comment`,
`pull_request_review`, `pull_request_review_comment`, `workflow_run`, `ping`.

If `MAKA_GITHUB_WEBHOOK_SECRET` is set (16+ characters), the listener checks
`X-Hub-Signature-256` the same way duties do. Unset: unsigned local posts are
accepted so you can replay fixtures with `curl`. This is not a public endpoint.

```bash
curl -sS http://127.0.0.1:8787/github/webhook \
  -H 'content-type: application/json' \
  -H 'X-GitHub-Event: pull_request' \
  -H 'X-GitHub-Delivery: local-1' \
  -d '{"action":"opened","pull_request":{"number":12,"title":"PR 12","user":{"login":"alice","type":"User"},"head":{"ref":"maka/pr-12"}},"repository":{"full_name":"acme/app"},"sender":{"login":"alice","type":"User"}}'
```

Tenant id defaults to `inv_local`. Override with `MAKA_CLOUD_SUPERAGENT_TENANT`.
Spawn admission defaults to `alice,bob`. Override with `MAKA_CLOUD_SUPERAGENT_ACTORS`.

To drive the **loop** (not the smoke) at a box you already have:

```bash
# INSTABOX_API_KEY already exported
export INSTABOX_MACHINE_ID='mch_…'
npm run local-loop -w @maka-cloud/superagent
```

A key without a machine id fails the loop immediately. Use `live-smoke` instead
when you want a throwaway box.

## Optional ModelJudge

HeuristicJudge stays the Superagent constructor default (no keys in CI).
When a judge key is present, `createJudgeFromEnv` uses `ModelJudge` with the
heuristic as a **prefilter** (ignore/empty skips the model). Force one path
with `MAKA_CLOUD_SUPERAGENT_JUDGE=heuristic` or `=model`. Decisions log
`confidence` and source. Optional read-only `RouterInspect` (`git log`, CI
URL) is a cheap check so the Router can verify instead of guessing.

```bash
# default when a key is set: ModelJudge + heuristic prefilter
export ANTHROPIC_API_KEY='…'          # or MAKA_CLOUD_JUDGE_API_KEY
# optional: ANTHROPIC_BASE_URL or MAKA_CLOUD_JUDGE_BASE_URL
# optional: MAKA_CLOUD_JUDGE_MODEL (default claude-haiku-5-5)
# optional force: MAKA_CLOUD_SUPERAGENT_JUDGE=model|heuristic|prefilter
```

Point `MAKA_CLOUD_JUDGE_BASE_URL` at the gateway's `/anthropic` prefix if you
want spend to go through `@maka-cloud/gateway`. Tests never set these.

## Optional local Org Secrets

```bash
export MAKA_CLOUD_ORG_SECRET_GH_TOKEN='…'
# or a JSON file:
# export MAKA_CLOUD_ORG_SECRETS_FILE=/path/to/secrets.json
```

`inject` writes into a caller-supplied env/header bag. The port never returns
the raw value.

P5 (hi device worker) is not in this repo. The interface is documented in
[p5-hi-device.md](p5-hi-device.md).

BYOM (paired machine) and speculative runs are **off**. See
[byom.md](byom.md) and [speculative.md](speculative.md). Do not set
`MAKA_CLOUD_BYOM` or `MAKA_CLOUD_SPECULATIVE` in CI.
