# Super-agent real loop

A worker that owns a PR or issue does the work: clone via `WorkspaceStore`,
apply a coder, run tests, commit, push a **worker branch**, open or update the
PR, and attach evidence (test output, diff summary, CI link). CI failures and
review comments resume the same worker (Router is not called).

## What is real vs stubbed

| Piece | CI / default CLI | Live (`MAKA_CLOUD_LOOP_LIVE=1`) |
|---|---|---|
| Sandbox | `FakeSandbox` | Instabox `HttpSandbox`, 2 vCPU / 4096 MiB, template `universal` |
| Coder | `FakeCoder` (writes `add.js`) | still `FakeCoder` in this slice; host can later inject `CodingRunner` / Agent SDK. Model key stays on the host |
| Tests | `node add.test.js` on the host workspace | same, plus `echo loop-verify` in the box |
| Git / PR | `FakeGitHost` (local commit, fake URL) | same unless you replace `GitHostPort` |
| Router | forced `act` mandate | `createJudgeFromEnv` (heuristic prefilter + ModelJudge when a key is set) |
| Merge | held, then approved in the fake CLI | still held — owner must approve exact bound text |

The box never receives `INSTABOX_API_KEY`, `ANTHROPIC_API_KEY` or
`MAKA_GITHUB_TOKEN`. That matches `cloud-playbooks` `GitHubPublisher`: publish
from the host.

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
export INSTABOX_API_KEY='…'           # env only, never argv
# optional:
# export INSTABOX_TEMPLATE_ID='universal'
# export ANTHROPIC_API_KEY='…'        # ModelJudge prefilter
# export MAKA_GITHUB_TOKEN='github_pat_…'  # only if you swap in a live GitHost
npm run build -w @maka-cloud/superagent
npm run real-loop -w @maka-cloud/superagent
```

The box is always destroyed. Agents and CI do not run this live.

## Metrics harness

```bash
npm run metrics -w @maka-cloud/superagent -- --n 3 --parallel 2 --out /tmp/sa-metrics
```

Writes `metrics.json` and `metrics.md`: success rate, time-to-green, human
interventions, $/PR, wasted Router wakeups. Parallelism is bounded. Fakes only.
