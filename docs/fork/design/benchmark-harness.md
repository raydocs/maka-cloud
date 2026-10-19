# Benchmark harness (T10)

Package: `packages/cloud-evals` (`@maka-cloud/evals`, command `cloud-evals`). It builds on `packages/eval`
(`@maka/eval`) and changes nothing in it.

## What is reused and what is not

Reused from `@maka/eval`: the experiment spec (`maka.eval.v1`), cells (`task::repetition::subject`), `runExperiment`
with its append-only attempt store ("earliest valid attempt wins", infrastructure failures are replaced by a new
attempt), the result kernel (`EvalResult`) and the CLI loop `runMakaEvalCli`, which already takes `loadExecutor` and
`subjects` overrides.

Not reused: the Harbor/Pier executor. It runs the agent inside the task's Docker container behind the relay and egress
proxy, and our subjects run in instabox sandboxes. So `cloud-evals` supplies an `ExperimentExecutor` of kind `cloud`
and a subject adapter for `external` subjects (the only non-Maka kind the spec parser accepts).

## Subjects

| Subject id | What runs |
|---|---|
| `claude-agent-sdk` | T6 runner, the vendor CLI alone: one run, no checks, no retry, no hand-over. |
| `codex` | The same with Codex. |
| `coding-playbook` | T8 `CodingRunner`: reproduction test, independent checks, repair, one hand-over. Its delivered change is the outcome. |

Held equal for all three (`VendorAloneDriver`, `PlaybookDriver`, one `CloudSubject` path): the issue text, the wall-clock
limit, the dollar cap per cell (`budget.taskBudgetUsd`, passed to the runner as `budgetUsd`) and how the change is taken
out. For the vendor-alone subjects the harness fetches the base commit (the playbook's own clone script) and, after the
run, reads the change with the playbook's collection script: over `exec` as the sandbox user (never `GET /files`),
symlinks, submodules, unsafe paths and anything over the delivery caps refused. The agent never writes the outcome.
A vendor-alone run that does not finish leaves no outcome; a playbook run that gives up delivers none.

The playbook's `testCommand` is an import smoke test per repository (`defaultTestCommand`), not the repository's suite:
a suite cannot finish inside a check's time limit and would grade the environment instead of the change. A task can
override it with `config.testCommand`. It is never derived from hidden tests.

## Hidden tests only grade

`PublicTask` and `HiddenTests` are separate types. Briefs, the spec, attempt records and everything sent to a sandbox are
built from `PublicTask`. `HiddenTests` come out of a `HiddenTestSource` in exactly one place, the executor's `verify`,
which the experiment runner calls only after the subject's `execute` has returned. `execute` returns only after
the run handle is cancelled, the task-wide stop (`stopAll`, which fails if any process survives) has finished, the change
is read, and the sandbox lease is released. A stop that cannot be confirmed is an infrastructure failure with no
collection and no grading. Tests pin the order (`stopAll:done` and `release` before the hidden load) and that no hidden
value appears in anything sent to the sandbox, in a brief, in the spec or in an attempt.

SWE-bench is graded by the official harness (`SweBenchGrader`) in Docker on the grading host, not in an instabox
sandbox. It writes a prediction file and reads the harness report; an errored instance is an infrastructure failure,
never a score.

## Results

Per cell: `score` 1 or 0, `costUsd` from the runner's cumulative `usage` events (null when none arrived; never
recorded as 0), `usage` null (the runners report dollars, not tokens), artifacts `outcome` (patch, files, sha256) and
`grade`.

Status follows eval's own rule, evidence rather than symptom: a failure or timeout after any spend is `subject_failed`
with score 0 (the money is spent, the cell is not retried); a failure before any spend, a clone or sandbox error, a
stop that could not be confirmed, or a grader error is `infra_failed` (replaced by a new attempt); an abort is
`indeterminate`.

## Budget: nothing spends by default

- Specs are `dry-run` or `live` (`executor.config.mode`). `make-spec` has no default dollar amount.
- A dry run uses a deterministic fake subject per subject id and a fake grader. It needs no network, key or sandbox.
- A live spec runs only with `--live` and `--approve-budget <usd>` at least cells x `taskBudgetUsd`, and a total budget
  not above the approval (`assertLiveApproved`, before anything is built or contacted). **No thread runs `--live`
  without win's explicit OK.** The real wiring (`createLiveDeps`) needs `INSTABOX_API_KEY`, `INSTABOX_MACHINE_ID`, the
  model keys, `MAKA_EVALS_DATA_DIR` (a `swe-bench-verified.jsonl`) and `MAKA_EVALS_PYTHON`.
- **Keys.** Model calls go through the model gateway (`design/model-gateway.md`), started inside the run with the
  vendor keys from the environment. A sandbox gets a token for its own cell's budget and the gateway URL, never a vendor
  key. `createLiveDeps` refuses, before it builds a fleet, when a subject's vendor has no key (`ANTHROPIC_API_KEY` for
  Claude, both for the playbook, which hands over to the other vendor), when Codex has no price in
  `MAKA_CLOUD_GATEWAY_MODELS`, or when the gateway settings are invalid. The gateway reserves the worst case of every
  request inside the cell's cap and its spend journal is `gateway-spend.db` in the experiment directory.
- `BudgetLedger` is synchronous. A cell reserves its whole cap before its first await, so cells that start together
  cannot overspend the total. A run that started and reported no cost is charged its cap. On a resumed run the ledger
  starts from what the earlier attempts already cost. Every exit (finish, abort, timeout, driver throw, grader throw)
  settles the reservation, stops the run, returns the lease and removes the attempt directory; each has a test.

## Commands

```
cloud-evals select --suite swe-bench-verified --dataset verified.jsonl --size 50 --seed 1 --out ids.json
cloud-evals make-spec --suite swe-bench-verified --dataset verified.jsonl --ids-file ids.json \
    --task-budget-usd 5 --total-budget-usd 750 --mode dry-run --out spec.json
cloud-evals make-spec --suite swe-bench-verified --synthetic 50 ...     # no dataset needed
cloud-evals run spec.json --out run-001 [--cell <id>]...
cloud-evals report run-001
```

`run` writes `run-001/report/`: `per-task.json`, `per-task.csv`, `summary.json`, `pareto.svg`, `report.md`.

## Reading the chart

Three subjects are three points, so the chart also draws a curve per subject. A run stops when it reaches its budget
and behaves the same below it, so the share of tasks resolved within a cap `c` is read off one run: resolved cells whose
cost is at most `c`, over all compared cells. The marker is the subject's mean cost and resolve rate; a ringed marker is on
the Pareto frontier. This is slightly off for the playbook, whose per-agent budget is what is left of the task's.

Only task repetitions where every subject has a result are compared (the eval README explains why averaging unmatched
cells is biased); the left-out ones are listed in the report.

## Limits

- **SWE-bench numbers are self-setup and not comparable to published ones.** The sandbox has no per-instance image, so
  agents set the repository's environment up themselves. The comparison between subjects is like for like; the absolute
  rates are not SWE-bench's.
- **Terminal-Bench is dry-run only.** Its tasks run in a per-task Docker image and are graded on the container's end
  state; the instabox client has no image choice. The suite, subset selection and spec generation exist, a live spec for
  it is refused. A live path waits on running task images in instabox.
- Cost is what the CLIs report, priced with the runners' table; it is not an invoice, and grading is not included.
- The agents can reach the public internet, where upstream fixes exist; only the base commit is fetched, with no history.
- The 50-task subset is produced by `select` from the real dataset; the instance ids are not checked in.
