# Super-agent real loop

A worker that owns a PR or issue does the work: clone via `WorkspaceStore`,
apply a coder, run tests, commit, push a **worker branch**, open or update the
PR, and attach evidence (test output, diff summary, CI link). CI failures and
review comments resume the same worker (Router is not called).

## What is real vs stubbed

| Piece | CI / default CLI | Live (`MAKA_CLOUD_LOOP_LIVE=1`) |
|---|---|---|
| Sandbox | `FakeSandbox` | Instabox `HttpSandbox` when `INSTABOX_API_KEY` is set: 2 vCPU / 4096 MiB, template `universal`, always destroyed |
| Coder | `FakeCoder` (writes `add.js`) | `HttpCoder` via Anthropic Messages when `ANTHROPIC_API_KEY` or `MAKA_CLOUD_JUDGE_API_KEY` is set; falls back to `FakeCoder` on a bad reply. Key stays on the host. Host can later inject `CodingRunner` |
| Tests | `node add.test.js` on the host workspace | same, plus `echo loop-verify` in the box |
| Git / PR | `FakeGitHost` (local commit, fake URL) | `HttpGitHost` when `MAKA_GITHUB_TOKEN=github_pat_…` and `MAKA_CLOUD_LOOP_REPO=owner/name` (GitHub git API, token never on argv) |
| Router | forced `act` mandate | still forced `act` so the scratch run actually pushes. Product Router (`createJudgeFromEnv`) is separate |
| Merge | held, then approved against the fake host | held only — live GitHub is never auto-merged |

The box never receives `INSTABOX_API_KEY`, `ANTHROPIC_API_KEY` or
`MAKA_GITHUB_TOKEN`. Clone / coder / tests / git stay on the host
`WorkspaceStore` (the same split as `cloud-playbooks` `GitHubPublisher`).
The box is the machine proof: `ensureRunning` + `echo loop-verify`.

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

## Live (owner only — this environment must not set the keys)

```bash
export MAKA_CLOUD_LOOP_LIVE=1
export INSTABOX_API_KEY='…'                 # env only, never argv
# optional Instabox:
# export INSTABOX_TEMPLATE_ID='universal'
# optional model coder (host-side Anthropic Messages):
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
