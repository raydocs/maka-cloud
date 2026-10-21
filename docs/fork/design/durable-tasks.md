# Durable tasks (T28)

A server restart used to fail every running task ("orphaned"), and a box that died took the agent's session with it. T28 makes a task outlive both. The design is Vercel's [durable-harness](https://github.com/vercel-labs/durable-harness) (Apache-2.0): its step log and fencing ideas, not its code, and none of its dependencies. We keep our SQLite stores, our gateway and instabox. Plan and ownership: `/plans/t28-plan.md` of the project files.

Status of the pieces (updated by each PR):

| # | Piece | State |
|---|---|---|
| 1 | Step log and epoch fencing | merged (#162), section 1 |
| 2 | Resume instead of fail | merged (#164), section 2 |
| 3 | Process channel and Agent SDK runner | section 3 (off until a deployment passes `agentSdk`) |
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

Nothing calls `steps` yet; the Agent SDK runner (piece 3) is the first caller.

## 2. Resume instead of fail

`Runner.recover?(spec)` is optional. With it, `restore()` drives an unfinished task again instead of ending it as orphaned; without it nothing changes.

At restart, per unfinished task: take it over (new epoch, open steps marked interrupted), stop what the earlier attempt left (`stopOrphaned`), then decide:

- **Resume** when the runner has `recover`, nobody is cancelling or pausing the task, no ancestor ended, its tree still has budget, and the leftover run was confirmed stopped (or the runner cannot leave one). A task that had started is told a `task_progress` note ("resuming after a restart (resume N in a row)") and handed to `recover` with `spec.recovery = {epoch, resumes, note}`. It stays `running` in the log: no second `task_started`. A task that never started is started by `start` as usual. The executor's MCP token is issued again; the old ones were revoked.
- **Give up** after `MAX_RESUMES_IN_A_ROW` = 3: the fourth restart in a row that got nowhere ends the task `failed` with a reason starting `needs you:`. Getting somewhere means a step that finished (`step_outcome` done) or spend recorded for the task since the previous attempt (a run that logs no steps counts only by spend). Spend is the safe measure: a crash loop that never reaches a model call stops after three tries and costs nothing.
- **End as before** otherwise: cancelled if a cancel was pending, `orphaned` if the runner has no `recover`, the task is paused, an ancestor ended, or the leftover run could not be stopped (then the stop stays owed and is retried).

If `recover` throws or its run reports it cannot resume (no recorded session), the task fails with `orphaned: could not resume after a restart: <reason>`, which the supervisor already treats as a restart's doing and not the step's fault.

**The recovery note** (`recoveryNote`) is the first thing the resumed agent reads: what finished (not to be done again), which `never` steps were cut off and may or may not have taken effect (check the real state, do not repeat blindly), which `safe` steps will run again, and that workspace files are not transactional. Each step is one line, `- kind: "label"` with the label as a JSON string, so a label an agent wrote cannot pass for a line of the note; lists show the latest 8 and count the rest; the closing advice survives the 5,000-character cap. A runner that logs no steps still gets the closing advice (check before you push or send).

**`SandboxCliRunner.recover`** is its existing `resume` with the note as the prompt: it continues the recorded vendor session (`--resume <id>`) on the task's machine, or on one restored from the last snapshot when the machine is gone. A task with no recorded session id fails with "nothing to resume". The transcript still lives only on the box (piece 4 mirrors it), so a box that is lost with no snapshot cannot be resumed yet.

**When resumed runs start.** `Orchestrator.create` decides in `restore()` but, with `resume: 'manual'`, starts nothing until `startRestored()`. `startCloudServer` uses it and calls `startRestored()` last, after the MCP endpoint listens and the handler's `onReady` ran: a resumed run needs the endpoint (or its executor could not delegate) and the host's tenant lookup (or its sandbox could not be found, and it would fail closed). Until then a resumed task reads `running` with no run; a cancel in that window ends it normally. Standalone callers get `automatic` (started at the end of `create`).

**A plan that waits can go stale.** `restore()` decides with the log as it was then; between that and `startRestored()` another process may have taken the task over (a later attempt). Starting from a stale plan would run the task twice. So `startRestored()` starts each run only after a write under the attempt's epoch has been accepted (the "resuming after a restart" note, now written at that moment instead of in `restore()`): the store refuses it when a newer attempt exists, and the process lets go of the task and starts nothing. A resumed running task has no `task_started` to write, so once its run exists it writes a second fenced note ("the run is back"); a takeover that landed while the runner was starting is refused there, and fencing out cancels the late run before it has written anything. What stays open: a takeover in the instant after that second write is caught at the run's first write, as before.

**Spend across attempts.** A run reports its own cumulative total, and a resumed run starts counting from zero. `task_cost` therefore carries the attempt's `epoch`: within one attempt the highest report stands, and the attempts of a task add up (key `<epoch>:<taskId>`; an event without `epoch` counts as epoch 0). Without this a resumed task got its spent budget back, because the reducer kept the maximum per task. What an earlier process wrote in the gateway's journal is recorded as the total of the attempt that process drove (the one before the attempt this process begins), so it replaces the figure the run reported live instead of adding to it. A crash between recording those rows and forgetting them counts them once more under the next attempt: never lost, counted twice in that one window (the safe side of a cap). The server feed's `totalCostUsd` groups the same way.

**The conductor across a restart.** A task the conductor delegated used to be cancelled by it at every shutdown and every start, so a resumed task found itself cancelled before it ran. With `ConductorOptions.tasksSurviveRestart` (the stack sets it) the three causes are separate. A *user's stop* and the *operator's pause* cancel as before (a pause also covers tasks no open run supervises). A *shutdown* cancels only what was already owed a cancel. A *crash or restart* marks cancel-pending only a delegation whose task the conductor never learned of (the answer was lost, so it has no id; it is cancelled by its key). Every other unsettled delegation is followed: its reservation stays against its run's budget, and a `follow_tasks` job asks the orchestrator (`task_status`) every `stopCheckMs` until the task has ended, then settles it at what its tree spent. A task the orchestrator could not resume is ended `orphaned` and settled the same way. Without the option the old behavior stays.

**Fuzzer.** Half of the schedule fuzzer's seeds give the fake runner a `recover`; restarts then resume started tasks, and the restore check requires every unfinished task to be either ended or resumed (never both), resumed tasks to have no terminal event, the active count to equal the resumed count, and old executor tokens to be dead.

## 3. Process channel and Agent SDK runner

With `CloudRunnersOptions.agentSdk` set (`loadAgentSdk()` loads the installed package), the Claude
runner drives its CLI through the Claude Agent SDK instead of running `claude -p` on its own.
Without it nothing changes; the host does not pass it yet (piece 4 wires it, together with the
transcript mirror, in the host's stack). The Codex runner is untouched.

**Why.** The SDK gives the host two things the plain CLI cannot: hooks that call back into the host
before and after every tool (the step log of section 1 needs exactly that), and, in piece 4, a
`sessionStore` that mirrors the transcript off the box. The cost is a conversation with the CLI in
both directions, which `exec` (one request, one answer) cannot carry. Hence the channel.

**The process channel** (`process-channel.ts`). `ExecProcess` is the SDK's `SpawnedProcess` for a
process on the box:

- The process is a detached run like every other (`launch`: its lock, its pid, its exit file, its
  raw output in memory-backed storage), so stop, cleanup, restart recovery and the orphan sweep are
  the ones that already exist. It survives a restart of this server.
- Its **stdout** is the run's output file, read by the machine poller by offset: one exec per
  machine per tick for every watched run, the terminal WebSocket stays free for the user's handoff
  (T14). stderr is merged into it, as on the CLI path; the SDK skips lines that are not messages.
- Its **stdin** is a file, `<run>.in`, that the run script reads as it grows (`maka_feed`: copy the
  new bytes, sleep 50 ms, stop when the end marker is there and everything before it has been
  copied, or when the run script that started it is gone). Each write is one exec that appends at
  the offset the host believes the file is at: a request whose answer was lost is sent again and
  lands once; a file that is somewhere else than expected refuses the write (`MISMATCH`), which
  breaks the process's stdin instead of corrupting the conversation. Writes are cut at 64k
  characters (never inside a surrogate pair or a multibyte character), and all input of a run is
  capped (32 MiB). The end of the SDK's input writes the end marker.
- `kill` runs the same per-run stop the cleanup uses (TERM to the group, grace, KILL, nothing may
  survive). A sandbox that cannot be reached for 5 polls is an `error` of the process and the end
  of it; an error with nobody listening is dropped rather than crashing the server.
- The cost is a round trip per message in each direction (a poll on the way out, one exec and up to
  50 ms of feeder polling on the box on the way in), and every hook the CLI waits for is two of them
  (the question, the answer), twice per tool call (before and after). So a run driven by the SDK is
  polled at 150 ms while output is coming and the wait doubles towards 1 s while it is quiet
  (`agentSdkPollMs`; the CLI path keeps `pollIntervalMs`, 2 s). The poll loop of a machine runs at the
  shortest wait any of its watched runs asks for, one exec serving them all. Piece 8 measures the
  overhead; it has not been measured on a live sandbox.

**What the SDK is and is not trusted with.** `query()` builds the CLI's arguments and speaks its
protocol; its own `command` (a bundled binary on the host) and its `env` (the host's whole
environment, 189 variables in a plain shell) are not used. The box runs the `claude` installed
there, with the run's own environment (`vendor.env`: the gateway key, the task's MCP token, the
search token) and the SDK's own markers (`CLAUDE_AGENT_SDK_*`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_SDK_*`, nothing that looks like a credential, short single-line values). Arguments are
quoted into the run script one by one. The flags are those of the CLI path: the Claude Code system
prompt, `bypassPermissions`, `--setting-sources project,local`, the orchestrator's MCP endpoint
with its token read from the environment, `--strict-mcp-config`, and the run's model and effort.
The subscription guard and the unset variables of the CLI path are in the run script's preamble,
as before.

**Output.** The SDK's messages are the CLI's own output lines, so one reader serves both ways of
running it (session id, progress, the in-progress todo item, opened pages, spend, the verdict, and
the guard line). Spend, the budget stop and the failure reasons are the CLI path's. A run that the
SDK gave up on (a protocol error) or that was stopped for its budget has its process stopped and
reports that; a process that exited 0 after the SDK reported an error is a failure.

**Hooks** (`hooks.ts`). Before a tool runs the CLI calls `PreToolUse`; the hook writes the step's
intent (`stepId` = the tool call's id, `kind` = `tool:<name>`, a redacted one-line label) and
answers only after the append is durable, so the CLI cannot start a step that is not on record. The
answer to a `completed` or `running` intent is "go on"; to `interrupted` and `refused` it is a
deny with the reason, which the agent reads. If the log cannot be written, a `never` step is
denied and a `safe` one runs (a note says so). After the tool, `PostToolUse` or `PostToolUseFailure`
records the outcome; a failed outcome carries the (redacted, cut) error text, a done one carries
nothing: the log holds metadata and the transcript holds content.

*Replay class of a tool call.* `safe`: reading and searching tools, notes, edits of the task's
files (the same edit leaves the same file), subagent tasks (their own tool calls are steps of their
own), and a shell command that is one plain read-only command (no pipes, redirects, substitution or
separators; `ls`, `grep`, `git status`, `npm test`, ...). Everything else is `never`: any other
shell command, any MCP tool, any tool this list does not know. The class decides what the recovery
note tells the agent about a step that was cut off ("check the real state first" for `never`), so
an unknown call errs towards the caution.

**Restart.** Unchanged from section 2: `recover` resumes the recorded session with the recovery
note as its message, in a run of its own (`t<n+1>`, with its own input file). What the SDK adds is
that the note now lists the tool calls that were cut off, because the hooks logged them.

**Known limits.**

- The conversation of a run lives in the SDK's process on this server and in the CLI on the box;
  a restart of the server ends the SDK's side and `recover` starts a new one on the recorded session.
  The turn that was in progress is not continued mid-sentence: the agent is told what the log knows.
- Input files stay in the task directory (they hold the prompt, like `brief.md`) and are in a
  snapshot of it; they are removed with the directory.
- A box lost with no snapshot still cannot be resumed (piece 4).
