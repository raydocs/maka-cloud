# Durable tasks (T28)

A server restart used to fail every running task ("orphaned"), and a box that died took the agent's session with it. T28 makes a task outlive both. The design is Vercel's [durable-harness](https://github.com/vercel-labs/durable-harness) (Apache-2.0): its step log and fencing ideas, not its code, and none of its dependencies. We keep our SQLite stores, our gateway and instabox. Plan and ownership: `/plans/t28-plan.md` of the project files.

Status of the pieces (updated by each PR):

| # | Piece | State |
|---|---|---|
| 1 | Step log and epoch fencing | this document, section 1 |
| 2 | Resume instead of fail | not built |
| 3 | Process channel and Agent SDK runner | not built |
| 4 | Transcript mirror and fresh-box resume | not built |
| 5 | Spend follows the step log, per-task budgets | not built |
| 6 | Steering, `restart` event, catch-up, stream fence | not built |
| 7 | Run timeline | not built |
| 8 | Drills, known gaps, bench | not built |

## 1. Step log and epoch fencing

Lives in `@maka-cloud/orchestrator` (types, reducer, store, `steps.ts`, `orchestrator.ts`) and `SqliteTaskStore` in `@maka-cloud/server`.

### Epochs

Each attempt to drive a task has an epoch. A task starts at **epoch 1**: its creation is the first attempt, which is also what every task in an existing log is. A new attempt writes `task_attempt {epoch, cause}` where `epoch` is the previous one plus one (`cause`: `restart` or `resume`). `restore()` writes one for every unfinished task before it does anything else, so a process that still drives one of them is fenced from that moment.

`TaskStore.append(event, at, fence?)` is the fence:

- a `task_attempt` is refused unless its epoch is the stored epoch plus one, so of two processes racing for the same epoch exactly one wins;
- with `fence = {taskId, epoch}` the append is refused with `StaleEpochError` unless the fenced task's stored epoch is exactly `fence.epoch`; a task the store does not know cannot be written under;
- the check and the append are one step: `Map` access in `MemoryTaskStore`, the append transaction in `SqliteTaskStore` (`task_index.epoch`, migration v10, derived again by `rebuildTaskIndex`).

Every write that comes from the driver of a run carries its epoch: `task_started`, `task_progress`, the terminal events of a run, step events, and `task_cost` (fenced by the task that spent it, not by the tree root it is recorded on). Writes that are not the driver's (a user's cancel, a pause, a stop obligation) are not fenced.

A process whose write is refused lets go of the task: it writes nothing more for it, cancels its own run handle (a handle only ever stops the run it started), revokes the executor session, frees the task's slots and forgets it. The log belongs to the new driver. A late event of an older attempt *of the same process* (a run that was replaced) is dropped without fencing the task out.

Spend of a fenced writer stays out of the log; it is still in the gateway's journal, which `recoveredSpend` replays on the next restore.

### Steps

A runner that wants a step to survive a crash receives `RunSpec.steps` (a `StepLog` bound to its epoch):

- `intent({stepId, kind, replay, label})` writes `step_intent` and answers only after the append is durable (that is the barrier before a `never` step). Answers: `recorded` (go ahead), `completed` (an earlier attempt finished it: `ok` and its recorded `output`, do not run it), `running` (this attempt already started it), `interrupted` (a `never` step cut off earlier: it may or may not have taken effect, check before trying again), `refused` (the task is ending, a newer attempt drives it, or it logged `MAX_STEPS_PER_TASK` = 5,000 steps).
- `outcome(stepId, {status, output?})` writes `step_outcome`. It applies only to a step that is running under the same epoch; anything else is `ignored`. A cancel does not stop an outcome from being recorded; the end of the task does.

The first intent per `stepId` wins; a repeat is not logged. Replay classes: `safe` (reading, tests, building, a model call) runs again after a crash; `never` (push, open or merge a PR, send, pay) does not. When an attempt takes a task over, every step still `running` gets a `step_interrupted` in the log, under the new epoch. A `safe` interrupted step takes a new intent from the new attempt; a `never` one stays interrupted.

The reducer keeps per step only `{stepId, kind, replay, label, state, epoch}`; outputs (at most 4,000 characters) stay in the log and are read back when a finished step is asked for again. Labels are one printable line of at most 200 characters.

### What clients see

`task_attempt` and the step events are in the log and in no client feed (`SqliteTaskStore` writes no feed row for them), so the public API, push and the web app are unchanged. The run timeline (piece 7) reads them from the log.

### Not covered here

Nothing calls `steps` yet; the Agent SDK runner (piece 3) is the first caller. `restore()` still ends the tasks it takes over (piece 2 resumes them instead).
