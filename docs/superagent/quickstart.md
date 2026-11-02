# Super-agent local loop

Run the Router → Worker → watchdog → approval → ledger path on your machine.
No Instabox account is required. The default sandbox is `FakeSandbox`.

## Replay (CI and first try)

From the repository root, after dependencies are installed:

```bash
npm run build -w @maka-cloud/superagent
npm run local-loop -w @maka-cloud/superagent
```

Equivalent:

```bash
node packages/cloud-superagent/scripts/local-loop.mjs
```

The script writes a temporary `superagent.db`, then:

1. Replays a GitHub `pull_request` opened delivery → Router spawn, sandbox `echo spawn`, worker sleeps.
2. Reopens the sqlite file (process-restart resume).
3. Replays an `issue_comment` → subscription pass-through (Router is not called).
4. Replays a `workflow_run` failure → pass-through, merge held for exact-text approval.
5. Approves `Merge pull request #12`.
6. Replays a looping issue → watchdog `looping` finding and a T33 stuck card.
7. Prints the tenant usage ledger and evidence blocks.

CI runs the same path as `packages/cloud-superagent/src/__tests__/local-loop.test.ts` (`npm run test:dist -w @maka-cloud/superagent`).

## Receive a live GitHub webhook

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

## Real Instabox instead of FakeSandbox

When both are set, the loop uses `HttpSandbox` against Instabox:

```bash
export INSTABOX_API_KEY='…'
export INSTABOX_MACHINE_ID='mch_…'
# optional:
# export INSTABOX_API_URL='https://api.instabox.sh'
npm run local-loop -w @maka-cloud/superagent
```

A key without a machine id fails immediately (`InstaboxCredentialsError`).
The host product does **not** use `INSTABOX_MACHINE_ID`; it maps one machine
per invite (`MAKA_CLOUD_SANDBOXES` or `MAKA_CLOUD_BOXES`). The machine id is
only for this single-box local / P0 path.

See [p0-checklist.md](p0-checklist.md) before the first live Instabox run.
Do not put the API key on argv or in the repo.

## Optional ModelJudge

HeuristicJudge stays the default. To send unowned events through the same
Anthropic Messages API the host already uses:

```bash
export MAKA_CLOUD_SUPERAGENT_JUDGE=model
export ANTHROPIC_API_KEY='…'          # or MAKA_CLOUD_JUDGE_API_KEY
# optional: ANTHROPIC_BASE_URL or MAKA_CLOUD_JUDGE_BASE_URL
# optional: MAKA_CLOUD_JUDGE_MODEL (default claude-haiku-5-5)
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

## What you should see

```
sandbox: fake
steps: spawn → resume-store → passthrough-comment → passthrough-ci → approval-request → approved → watchdog:looping
states: … sleeping … awaiting_approval …
router calls after spawn: 1 (comment/CI must stay 0 more: 0)
ledger: tokens=… events=…
### Evidence
```

P5 (hi device worker) is not in this repo. The interface is documented in
[p5-hi-device.md](p5-hi-device.md).
