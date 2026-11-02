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
| Coder | `FakeCoder` files written **inside the box** | `HttpCoder` on the host when `ANTHROPIC_API_KEY` / `MAKA_CLOUD_JUDGE_API_KEY` is set; files applied in the box. Public-clone probe without a model key uses `NoopCoder` |
| Tests / install | `node add.test.js` (and optional install) **in the box** | `MAKA_CLOUD_LOOP_TEST` / `MAKA_CLOUD_LOOP_INSTALL` in the box; output is evidence |
| Git / PR | `FakeGitHost` after applying the box `git diff --cached` to a **clean** host checkout | `HttpGitHost` when `MAKA_GITHUB_TOKEN=github_pat_…` and `MAKA_CLOUD_LOOP_REPO=owner/name`. Public-clone live with no token skips publish |
| Router | forced `act` mandate | still forced `act`. Product Router (`createJudgeFromEnv`) is separate |
| Merge | held, then approved against the fake host | held only — live GitHub is never auto-merged |

The box never receives `INSTABOX_API_KEY`, `ANTHROPIC_API_KEY` or
`MAKA_GITHUB_TOKEN`. Clone of a public URL is credential-less. Private
workspaces are packed on the host and uploaded as a tarball. The host does
not write coder files itself: it `git reset --hard` a clean checkout and
applies the box's cached diff, so the tree that ran tests is the tree that
ships. The CLI prints `create/materialize/edit/test/diff/destroy` timings and
saves every in-box exec's stdout/stderr/exit code.

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
# optional live GitHub (fine-grained PAT only; scratch repo must exist with a default branch):
# export MAKA_GITHUB_TOKEN='github_pat_…'
# export MAKA_CLOUD_LOOP_REPO='owner/scratch'
npm run build -w @maka-cloud/superagent
npm run real-loop -w @maka-cloud/superagent
```

The box is always destroyed. Live GitHub never auto-merges. Agents and CI
do not run this live.

## Metrics harness

```bash
npm run metrics -w @maka-cloud/superagent -- --n 3 --parallel 2 --out /tmp/sa-metrics
```

Writes `metrics.json` and `metrics.md`: success rate, time-to-green, human
interventions, $/PR, wasted Router wakeups. Parallelism is bounded. Fakes only.
