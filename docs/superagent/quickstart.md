# Super-agent quick start

**Node.js `^22.19.0 || >=24`.** The store uses `node:sqlite` (stable on 22.19+
and 24). Node 23 is not supported.

The host starts one in-process Super-agent (`packages/cloud-host/src/superagent.ts`).
The stand-alone `local-loop`, `live-smoke`, `real-loop` and `metrics` commands were
removed: nothing in the product called them. `npm run status -w @maka-cloud/superagent`
still prints the status view.

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

BYOM (paired machine) and speculative runs are **off** and the host has no
switch for them. See [byom.md](byom.md) and [speculative.md](speculative.md).
