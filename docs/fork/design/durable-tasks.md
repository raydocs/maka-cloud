# Durable tasks (T28)

A server restart used to fail every running task ("orphaned"), and a box that died took the agent's session with it. T28 makes a task outlive both. The design is Vercel's [durable-harness](https://github.com/vercel-labs/durable-harness) (Apache-2.0): its step log and fencing ideas, not its code, and none of its dependencies. We keep our SQLite stores, our gateway and instabox. Plan and ownership: `/plans/t28-plan.md` of the project files.

Status of the pieces (updated by each PR):

| # | Piece | State |
|---|---|---|
| 1 | Step log and epoch fencing | merged (#162), section 1 |
| 2 | Resume instead of fail | merged (#164), section 2 |
| 3 | Process channel and Agent SDK runner | merged (#166), section 3 (off until a deployment passes `agentSdk`) |
| 4 | Transcript mirror and fresh-box resume | merged (#200), section 4 (on when the host sets `MAKA_CLOUD_AGENT_USER` and `_GROUP`) |
| 5 | Spend follows the step log, per-task budgets | merged (#202), section 5 |
| 6 | Steering, `restart` event, catch-up, stream fence | merged (#208, #209), section 6 |
| 7 | Run timeline | merged (#222), section 7 |
| 8 | Drills, known gaps, bench | merged (#224), section 8 |

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

**A slow recovery can be overtaken too.** `restore()` waits for each task's leftover-run stop (bounded, but long), and another process may take the task over meanwhile. Right after the stop, each task is checked against the store (`holdsAttempt`: the latest `task_attempt` in the log is still this process's epoch, read synchronously). If not, the process lets go of the task and does nothing else for it. If so, the credential revoke happens at once, with nothing awaited between check and revoke, and every note, owed stop and outcome that follows carries the fence. The stop request now carries the attempt's `epoch`, so a runner that can tell attempts apart can refuse to stop a later one's run; the real runners do not use it yet (their runs are found by task id alone), which stays a known gap. Fencing out no longer revokes every session of the task: in a shared session store that would revoke the new attempt's own.

**Spend across attempts.** A run reports its own cumulative total, and a resumed run starts counting from zero. `task_cost` therefore carries the attempt's `epoch`: within one attempt the highest report stands, and the attempts of a task add up (key `<epoch>:<taskId>`; an event without `epoch` counts as epoch 0). Without this a resumed task got its spent budget back, because the reducer kept the maximum per task. What an earlier process wrote in the gateway's journal is recorded as the total of the attempt that process drove (the one before the attempt this process begins), so it replaces the figure the run reported live instead of adding to it. A crash between recording those rows and forgetting them counts them once more under the next attempt: never lost, counted twice in that one window (the safe side of a cap). The server feed's `totalCostUsd` groups the same way.

**The conductor across a restart.** A task the conductor delegated used to be cancelled by it at every shutdown and every start, so a resumed task found itself cancelled before it ran. With `ConductorOptions.tasksSurviveRestart` (the stack sets it) the three causes are separate. A *user's stop* and the *operator's pause* cancel as before (a pause also covers tasks no open run supervises). A *shutdown* cancels only what was already owed a cancel. A *crash or restart* marks cancel-pending only a delegation whose task the conductor never learned of (the answer was lost, so it has no id; it is cancelled by its key). Every other unsettled delegation is followed: its reservation stays against its run's budget, and a `follow_tasks` job asks the orchestrator (`task_status`) until the task has ended, then settles it at what its tree spent: at once after the start, then every second, doubling to ten (never past `stopCheckMs`). When the run that delegated it ended for a restart or a shutdown, no turn is left to say the task is done, so settling also queues one message to the user, in the same transaction: fixed wording around the task's own title and summary or failure reason, which go through `scrubTaskText` (the stack passes the shared secret scrubber; without it the message carries none of the task's words). The go-live rehearsal's `restart-reply` step checks it. A task the orchestrator could not resume is ended `orphaned` and settled the same way. Without the option the old behavior stays.

**Fuzzer.** Half of the schedule fuzzer's seeds give the fake runner a `recover`; restarts then resume started tasks, and the restore check requires every unfinished task to be either ended or resumed (never both), resumed tasks to have no terminal event, the active count to equal the resumed count, and old executor tokens to be dead.

## 3. Process channel and Agent SDK runner

With `CloudRunnersOptions.agentSdk` set (`loadAgentSdk()` loads the installed package), the Claude
runner drives its CLI through the Claude Agent SDK instead of running `claude -p` on its own.
Without it nothing changes; the host passes it (with the agent account and the transcript store)
only when `MAKA_CLOUD_AGENT_USER` and `MAKA_CLOUD_AGENT_GROUP` are set. The Codex runner is untouched.

**Why.** The SDK gives the host two things the plain CLI cannot: hooks that call back into the host
before and after every tool (the step log of section 1 needs exactly that), and, in piece 4, a
`sessionStore` that mirrors the transcript off the box. The cost is a conversation with the CLI in
both directions, which `exec` (one request, one answer) cannot carry. Hence the channel.

**Who can write the channel.** Whatever arrives on the CLI's stdin can answer its permission questions, so an agent that could append to the input file could approve its own denied tool calls. The channel therefore lives in `<task>/chan/` (mode 700, owned by the sandbox user; the scripts refuse a link in its place, a file that is a link, or anything not ours), and with the SDK the CLI runs as another account (`agentChannel: { user, group }`, `agent-user.ts`): `sudo -n -u <user>` wraps the command, the workspace belongs to the shared group (setgid, group-writable), and the task directory can be entered by the group but not listed. Stopping a run goes through `sudo -n kill` for the agent's processes. Each box is probed once before it runs an SDK turn (`checkAgentIsolation`): the account is not the sandbox user, cannot use sudo, cannot enter, list, read or write the channel directory, and can write a workspace the sandbox user can clean up; any other answer refuses the turn. Without `agentChannel`, an SDK turn is refused. Assumed, not verified on a real box: that instabox's sandbox user has passwordless `sudo -n` (the egress guard assumes the same), that an unprivileged account and a shared group exist in the image, and that the CLI binary is readable by that account. The tests run the real separation (`nobody`, `nogroup`) when the machine is root with sudo, and skip it otherwise.

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
- A box lost with no snapshot can be resumed only for a conversation the store kept (section 4); a
  task that began before transcripts were kept goes on from the box's own files or fails as before.

## 4. Transcript mirror and fresh-box resume

With `CloudRunnersOptions.transcripts` set (a `TranscriptStore`) an SDK run keeps the conversation
off the box. The SDK mirrors every line the CLI writes to a `SessionStore` it is given
(`sessionStoreFlush: 'eager'`, so a crash loses at most the line in flight); `transcriptSessionStore`
(`transcripts.ts`) takes the run's secrets out of each line (`Run.scrub`) and appends it to the
store. The CLI's configuration directory is the task's own (`<task>/claude-config`, passed as
`CLAUDE_CONFIG_DIR` to both the SDK and the CLI, which the SDK checks the transcript paths against).

**The store.** `TranscriptStore` is `append` (a line with a `uuid` already kept for that transcript
is skipped, so a batch sent again lands once), `locate`, `read` (pages, by line index) and
`deleteTask`. Keys are plain names (a project key, a UUID session id, a subagent subpath), a task
keeps one project key, and a line, a batch, a task and the number of transcripts are capped; a batch
that breaks a cap keeps nothing of itself. `MemoryTranscriptStore` is for tests; the server uses
`SqliteTranscriptStore` (`transcripts.db` in the data directory: exclusive, WAL, one write
transaction per call, part of the daily backup). The backup copy has private-key headers and the
system's own tokens taken out of the lines (a repository file the agent read may hold one, and the
backup scan refuses a copy that does), the live file keeps them.

**Putting it back.** Before a resumed SDK turn the box's transcript is compared with the store's
(`restoreTranscript`): when the box has fewer lines (a new box, or a snapshot older than the
store) the stored transcript is streamed to the box in chunks into a temporary file, checked by
sha256 and renamed into place, so the CLI never reads a half-written file; a chunk whose answer was
lost is sent again safely by its offset, and a failed upload removes its temporary file. A
conversation the store never saw (it began before transcripts were kept) goes on as it is on the
box, unmirrored, and says so.

**A box lost with no snapshot.** `resume` finds the store holds the conversation, asks the provider
for a new box, and goes on there: the brief is written again, the transcript is put back, and the
prompt says the files in the workspace are gone and to check what already reached the outside world
before doing it again. Without a stored conversation the old failure stays ("cannot resume: the
sandbox is gone…").

**With the agent account.** `claude-config` is made by `prepareAgent` as a setgid directory of the
shared group; the agent writes its transcripts there and the sandbox user reads them and writes the
restored one (umask 007). The restore scripts refuse a link as the configuration directory, its
`projects` or the key directory, and create the temporary file without following a link planted at
its name. Assumed: no agent process is running while a transcript is put back (the turn that wrote
it has ended and the run was stopped) — a process of the agent account that outlived its turn could
swap a link between the check and the write.

**The CLI version.** The sandbox installs the `claude` version the SDK was built for
(`claudeCodeVersion` in the SDK's package.json), since the mirror flags are new.

Known limits: the store keeps subagent transcripts but does not put them back; a conversation is
kept in full (capped at 256 MB per task); nothing here is verified on a real box, only against the
stand-in CLI and the real SDK.

## 5. Spend and per-task limits

**What the journal already guarantees.** Every request through the gateway is a reservation (`hold`,
before it is sent) and a settle (after), in the gateway's SQLite journal. A call is keyed by its
own reservation, so a settle that arrives twice charges once; a settle from a process that was
replaced finds nothing to settle (its rows are the next process's to read) and changes nothing; a
reservation still open when a process died is a call it died in, and the next process charges it
in full because whether the vendor billed it is unknown. `restore()` records that spend on the task's
tree under the attempt that drove it (`task_cost` keeps the highest figure per attempt, and attempts
add up). What piece 5 adds: the calls cut off are counted (`cutOffCalls`, `cutOffUsd` in
`RecoveredSpend.unrecorded()`) and the task's log says so, once, under the attempt that resumes it:
"2 calls to the model gateway cut off by the restart were charged in full ($0.75) because the
vendor may have billed them". The resumed run makes the call again if it still needs it, and that
is billed again.

**Why reservations are not keyed by step id.** The plan was "intent reserves, outcome settles". A
model call is not a step the hooks see: the CLI makes it between tools, and it reaches the gateway
as an HTTP request that knows its grant (one per run, hence per attempt) and nothing else. The
attempt is the key that matters for money, and it is already there: the grant is for one run, the
orchestrator fences by epoch, and `task_cost` is keyed by epoch. A fenced attempt cannot reserve
(its grant is revoked when the task is taken over) and cannot settle what a newer process already
recorded (the journal's process epoch).

**Limits of one task** (`OrchestratorOptions.limits`, set from `MAKA_CLOUD_TASK_TURN_USD` and
`MAKA_CLOUD_TASK_RUN_HOURS`), on top of the invite's caps and the tree's budget:

- *Spend per turn.* A run (one start, or one resume after a restart) may spend at most `turnUsd`.
  The orchestrator puts it in `RunSpec.turnBudgetUsd`; the host's `gatewayModelAccess` gives the
  grant a limit of its own (`budget.limitUsd`) inside the pool of what the whole tree has left
  (`poolLimitUsd`), so the gateway refuses the request that would cross it ("this turn's model
  budget has $x left…") and the runner stops the run with a note ("this turn's model budget of $x
  reached"). When the tree has less left than the turn limit, the tree's budget is the one that
  binds, as before.
- *Run time per task.* `runMs` (default 4 hours) over every attempt. The reducer keeps `runMs` and
  `runSince` per task: the time between a start (or a resume from a pause) and the next pause or
  end. A restart does not reset it and time paused does not count; time the server is down does, the
  sandbox keeps going. A timer per running task ends it with a note ("stopped: the task used its 4
  hours of run time") and cancels its subtree; the timer is set when the run is registered or
  resumed, cleared at a pause, an end, a takeover and `close()`, and counted in `stats().runClocks`
  (the schedule fuzzer checks it is 0 at quiescence). A restart finding a task already past its
  limit does not resume it: it ends "needs you: this task had used its 3 hours of run time by the
  time the server came back".

Not here: box-time limits per box rather than per task (instabox bills the machine, which tasks of
one invite share), and a per-turn limit chosen per task rather than per server.

## 6. Steering

What the owner types while a task runs goes into the agent's conversation at the next safe point, instead of waiting for the end or restarting the task.

### Path

- **Public API.** `POST /v1/tasks/:id/messages {text, messageId?}` answers `{message: {messageId, state}}`; `DELETE /v1/tasks/:id/messages/:messageId` takes a message back. The owner's invite is checked twice, in the handler and in the orchestrator's write chain (`steerAs` / `withdrawSteerAs`, like a pause). The text is the owner's own, so it is not judged as model output. The conductor has no tool for it: a conversation that delegated has read outside content, and a message to a runner with full permissions is as much a send as a brief.
- **Log.** `task_steer {steerId, text, by}` is recorded once per `steerId` (a resend returns the message as it stands; the same key with other text is refused). `task_steer_delivered {steerId, epoch}` is written when the run reports it put the message in front of the agent, `task_steer_withdrawn` when the owner took it back first, `task_steer_unseen` when the run ended before the agent read it. The reducer keeps them in `TaskRecord.steers` in order. None is shown on the feed (`NOT_IN_FEED`): the conversation does not show the message back as a task event.
- **Runner.** `Runner.steerable` says whether a task of this runner takes messages; the Claude runner has it when the host passes `agentSdk`. `RunHandle.steer` queues a message in the run's inbox, `RunHandle.unsteer` drops one the agent has not been given (false once it was). The SDK's `PostToolUse` and `PostToolUseFailure` hooks, which already record the step, take the inbox and answer with `additionalContext`: "The user sent you a message while you were working … `<user_message>…</user_message>`", secrets of the run scrubbed, at most 16,000 characters per answer (the first message always goes, the rest wait for the next step). The run then reports `steered`.
- **Why hooks, not streaming input.** The sandbox channel is exec only, with no stdin to a running process (section 3), so the SDK's streaming input has nowhere to write. Hooks run in the server, between steps, which is the safe point anyway.

### Limits, stated plainly

- A turn that makes no more tool calls never reads a message. When the run ends with messages unread, each is marked `unseen` and the task gets one note ("… came too late to be read: it ended without another step"). Nothing is promised about the time a message takes: it waits for the step under way.
- A message is not delivered to a paused task; it waits for the resume.
- At most 20 unread messages per task and 4,000 characters each.

### Restarts

A new attempt (`task_attempt`) sets `steersHeld` on the task; the first `step_outcome` of that epoch clears it. While it is set, nothing is offered to the resumed run, so the owner's message is not read in the middle of the recovery note and the replay of earlier steps (the durable-harness authors leave this undefined). Messages the agent read before the restart are `delivered` and are not offered again; unread ones are offered once to the new run, in the order they were sent. Offers are tracked per run handle, so a new handle gets them all and the same handle gets each once.

### Not verified

No real CLI: the hook answer is checked against the stand-in CLI that speaks the SDK's protocol, not against a real `claude` honouring `additionalContext`.

### The restart event, catch-up and the fence

- **Restart event.** When a restart resumes a task, the attempt that proves it still owns the task writes `task_restarted {epoch, text}` where the run comes back (it replaces the former "the run is back" note). `text` is fixed ("The server restarted. The task goes on from its last finished step; the cut-off turn is not repeated here."): a viewer shows it in place of what it had of the cut-off turn, so the same answer is not shown twice. Today's clients keep only the notes of a task, so the client appends it as the latest note; a client that streams partial replies replaces them with it. The reducer also keeps it as the latest progress note. `task_attempt` and the steps stay out of the feed.
- **Catch-up.** The feed cursor was already exact: `Last-Event-ID` or `?after=` returns what was missed, once, in order, and a row is written in the transaction that appends the event, announced only after it committed. A test now covers a viewer that was connected across a server restart: with its cursor it gets the claim note, the restart event once and the end, with strictly increasing ids and no driver-only event.
- **Fence.** The stream serves only events already in the log, and a write by a driver that lost the task is refused inside the append transaction, so it has no log row, no feed row, no gap in `seq` (`epoch.test.ts`) and, new, wakes no open stream.

## 7. Run timeline

One view of what a task did, drawn from the step log and nothing else.

- **Source.** `buildTimeline(events, {content?, now?})` in `@maka-cloud/orchestrator` folds a task's events through the same reducer that computes the task view and adds only the times. States, kinds, epochs and order come from the reducer, so the timeline and the task cannot disagree (a test compares them). It reads, never writes: no write path means a tracing failure cannot fail a task, by construction.
- **Shape.** `turns` (one per attempt: the task's start, then each restart or resume, with when it began and ended and how many steps began in it), `steps` (one row per step id: kind, replay class, state, the epoch that holds it, how many attempts recorded its intent, start, end and duration; a `safe` step that ran again after a restart is one row, the latest run, with `attempts` 2), `cost` (the tree's spend over time, one point per report), `messages` (counts of sent, read, unseen and withdrawn, never their text), `runMs`, `state`.
- **Metadata only.** Kinds, states and times. A step's `label` (it holds the command or the file) is included only when the owner sets `MAKA_CLOUD_TIMELINE_CONTENT=1`; message text and step outputs are never in it.
- **Route.** `GET /v1/tasks/:id/timeline` answers `{timeline}`, owner-scoped (404 for another owner's task, 401 for a wrong token), under the control rate limit. `CloudClient.timeline(task)` reads it.
- **Cost.** Spend is recorded on the top-level task of a tree, so a child's timeline has none.

### Not built

- **Tokens** (cached input too). The log holds dollars only; the gateway's journal does too. Tokens would need the runner to report them with its usage; they are listed as a known gap in section 8.
- **A web or phone view.** The data and the client call exist; drawing them is the apps' lane.

## 8. Drills, known gaps and the bench

### The scripted CLI

`cloud-runners/src/__tests__/fake-sdk-cli.ts` is a stand-in for `claude` that the real Agent SDK drives. In `tools` mode it makes the tool calls listed in `tools.json` (`call <tool> <input>`), asking the SDK's hooks before and after each one; anything else it says is echoed. A tool can also `fail`, `hang` (the CLI stays inside the tool) or `spawn` a shell command as a child in a process group and session of its own, which is what a stop of the run's group does not reach.

### The kill-inside-a-`never`-step drill

`drill.test.ts` (set up in `drill.ts`). The CLI makes a safe call (`Read`), then a `never` one (`Bash: deploy --now`) whose child lives on in a group of its own. A second orchestrator takes over the same log and sandbox while the first is still alive, as a driver that lost its lease would be. It checks, with the real SDK, hooks, step log and process groups:

- the second process stops the old run by task id and resumes the task in its recorded session;
- the `never` step ends as `interrupted` and the CLI is never asked to run it again (`ran.log` holds each call once); the safe step stays `done`;
- the recovery note names the finished step and the cut-off one in words;
- the first process, still holding its epoch-1 step log, can neither settle the step nor start another, and writes nothing.

The drill fails if the takeover stops marking open steps interrupted (checked by removing it).

### Known gaps

Each is a test in `known-gaps.test.ts` that states what should hold and is expected to fail. When the owner closes the gap the test fails with "the gap is closed" until its entry and its row here are removed.

| Gap | Owner |
|---|---|
| A child that left the run's process group (its own `setsid`) outlives the stop of its task, and its late write lands in the workspace. The step log fences the log, not the files; workspace files are not transactional. | T27 (stopping or replacing the whole box) |
| A turn that makes no tool call never reads a message sent to it. The owner is told it was not seen (`task_steer_unseen`). | T28, agent side |
| The Codex runner takes no messages for a running task. | T27 |
| A runner's usage report carries dollars only: no input, output or cached tokens, so neither the log nor the timeline can show them. | T28 follow-up |

### The bench

Measured once, offline, with a fake runner: what durability adds (the SQLite log, the step log, the takeover), not a sandbox or a model. The method is durable-harness's: the median of per-round differences, warm-up rounds (5) left out, 25 rounds counted. Both are tests, so a regression fails them (`bench.test.ts` in `cloud-server`, and the drill in `cloud-runners`).

| Gate | Limit | Measured (this machine) |
|---|---|---|
| First token of a durable task (delegate until the first progress note is in the log), over a plain run | 150 ms | 12.9 ms (plain 0.03 ms, durable 12.9 ms) |
| A restart to a run going again, server stop and start included, SQLite log, fake runner | 12 s | 23 ms |
| The drill's takeover to the resumed CLI having its message (real SDK, real stop of the old run by task id) | 12 s | 305 ms |

The real figure for a box adds what a box costs (stopping the old run, waking a suspended machine, a fresh box for a lost one); T26 and T27 own those. The first-token gate does not include the model's own latency, which is the same with and without the log.
