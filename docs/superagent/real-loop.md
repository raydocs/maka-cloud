# Super-agent real loop

A worker that owns a PR or issue does the untrusted work **inside** the
sandbox: materialize the repo, apply coder edits, run install/test. The host
calls the model and publishes a worker-branch PR from a diff pulled back out
of the box. Tokens never enter the box. CI failures and review comments
resume the same worker (Router is not called).

## What is real vs stubbed

| Piece | CI / default CLI | Live (`MAKA_CLOUD_LOOP_LIVE=1`) |
|---|---|---|
| Sandbox | `FakeSandbox` (real local exec in a per-machine dir) | Instabox `HttpSandbox` when `INSTABOX_API_KEY` is set: 2 vCPU / 4096 MiB, template `universal`, always destroyed |
| Materialize | host tarball uploaded into the box (`base64` + `tar`) | public `MAKA_CLOUD_LOOP_CLONE_URL` → `git clone` in the box; otherwise the same host tarball (private / scratch; no token in the box) |
| Coder | `FakeCoder` files written **inside the box** | `HttpCoder` on the host when `ANTHROPIC_API_KEY` / `MAKA_CLOUD_JUDGE_API_KEY` is set; files applied in the box. Public-clone probe without a model key uses `NoopCoder`. Usage is the Messages API `input_tokens` / `output_tokens` plus estimated USD (Haiku 5.5 list price, same as the gateway) |
| Tests / install | `node add.test.js` (and optional install) **in the box** | `MAKA_CLOUD_LOOP_TEST` / `MAKA_CLOUD_LOOP_INSTALL` in the box; output is evidence |
| Git / PR | `FakeGitHost` after applying the box `git diff --cached` to a **clean** host checkout | `HttpGitHost` when `MAKA_GITHUB_TOKEN=github_pat_…` and `MAKA_CLOUD_LOOP_REPO=owner/name` (e.g. `raydocs/maka-loop-scratch`). Empty repos need `MAKA_CLOUD_LOOP_SEED=1` to create `main` with the broken scratch fixture via the GitHub API. Public-clone live with no token skips publish |
| CI | simulated webhook resume | Checks + Statuses API on the pushed SHA. An empty list is `no-checks`, not a failure. Merge refuses `no-checks` / pending / failed / all-skipped unless the mandate sets `allowNoCi` (scratch) |
| Router | forced `act` mandate (`allowNoCi` for the scratch CLI) | still forced `act` + `allowNoCi`. Product Router (`createJudgeFromEnv`) is separate |
| Merge | held on `Merge pull request #N in repo at <sha>`, then approved against the fake host | held only — live GitHub is never auto-merged. `PUT /pulls/N/merge` sends that SHA so a later push cannot ride the approval |

The box never receives `INSTABOX_API_KEY`, `ANTHROPIC_API_KEY` or
`MAKA_GITHUB_TOKEN`. Clone of a public URL is credential-less. Private
workspaces are packed on the host and uploaded as a tarball. The host does
not write coder files itself: it `git reset --hard` a clean checkout and
applies the box's cached diff, so the tree that ran tests is the tree that
ships. The CLI prints `create/materialize/edit/test/diff/destroy` timings,
Messages API input/output tokens plus estimated USD (also written to the
usage ledger), and every in-box exec's stdout/stderr/exit code.

Worker-branch push (`maka/sa-<workerId>`) is allowed under intensity `act` and
authority `open-pr`. `main` / `master` are protected. Merge, protected push,
secrets and deploy go through `Safety.gate`.

No sqlite migration. `workspaceRef` is already on the worker row.

## Fake (CI and default)

```bash
npm ci
npm run build -w @maka-cloud/superagent
npm run real-loop -w @maka-cloud/superagent
```

## Live — public repo tests in the box (no GitHub token)

Owner only. This environment must not set the keys.

```bash
export MAKA_CLOUD_LOOP_LIVE=1
export INSTABOX_API_KEY='…'                 # env only, never argv
export MAKA_CLOUD_LOOP_CLONE_URL='https://github.com/owner/scratch.git'
# optional:
# export MAKA_CLOUD_LOOP_INSTALL='npm ci'
# export MAKA_CLOUD_LOOP_TEST='npm test'    # default: node add.test.js
# export INSTABOX_TEMPLATE_ID='universal'
npm run build -w @maka-cloud/superagent
npm run real-loop -w @maka-cloud/superagent
```

The box clones the public URL (no credentials), runs install/test there, and
is destroyed. No GitHub token is required. Expect `boxed: true` and
`box-materialize → box-edit → box-test`.

## Live — scratch tarball + optional model / GitHub

```bash
export MAKA_CLOUD_LOOP_LIVE=1
export INSTABOX_API_KEY='…'
# optional model coder (host-side Anthropic Messages; files applied in the box):
# export ANTHROPIC_API_KEY='…'              # or MAKA_CLOUD_JUDGE_API_KEY
# optional live GitHub (fine-grained PAT only; Contents + Pull requests +
# Checks/Statuses read; empty private repo is OK with SEED=1):
# export MAKA_GITHUB_TOKEN='github_pat_…'
# export MAKA_CLOUD_LOOP_REPO='raydocs/maka-loop-scratch'
# export MAKA_CLOUD_LOOP_SEED=1
npm run build -w @maka-cloud/superagent
npm run real-loop -w @maka-cloud/superagent
```

The box is always destroyed. Live GitHub never auto-merges; it stops at
`merge-held`. An empty Checks/Statuses list prints `ci: no-checks` and is
not merge-green unless the scratch mandate set `allowNoCi`. Agents
and CI do not run this live.

## Live — empty private scratch (`raydocs/maka-loop-scratch`)

```bash
export MAKA_CLOUD_LOOP_LIVE=1
export INSTABOX_API_KEY='…'
export ANTHROPIC_API_KEY='…'                # host-side coder; usage goes to the ledger
export MAKA_GITHUB_TOKEN='github_pat_…'
export MAKA_CLOUD_LOOP_REPO='raydocs/maka-loop-scratch'
export MAKA_CLOUD_LOOP_SEED=1               # only when the repo has no commits
npm run build -w @maka-cloud/superagent
npm run real-loop -w @maka-cloud/superagent
```

Expect `seeded: true` on the first run, a worker-branch PR on that repo,
`ci: no-checks` if the repo has no Actions, and `merge-held`. Re-runs skip
seed once `main` exists.

## Metrics harness

```bash
npm run metrics -w @maka-cloud/superagent -- --n 3 --parallel 2 --out /tmp/sa-metrics
```

Writes `metrics.json` and `metrics.md`: success rate, time-to-green, human
interventions, $/PR, wasted Router wakeups. Parallelism is bounded. Fakes only.
