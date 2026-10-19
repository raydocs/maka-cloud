# Sandbox runners (`@maka-cloud/runners`)

Task T6. Two `Runner`s for the orchestrator (T2), `claude-agent-sdk` and `codex`, that run
the vendor CLI inside an instabox sandbox (T1). The package depends on
`@maka-cloud/orchestrator` and `@maka-cloud/instabox` only, so upstream changes cannot break it.

## Shape of a run

The CLI runs detached in the sandbox, not inside an `exec` call: `exec` collects output, caps
it at 1 MiB per stream and ends after 10 minutes at most. Per task, `<workRoot>/<taskId>/`
holds `brief.md`, `result.json`, a `workspace/` directory, and for each CLI invocation (`t1`,
`t2`, ...) a lock, script, token, pid, cancel mark and `.exit` file. The output (stdout and stderr
together, `.out`) is kept apart, see "Secrets". The exit file is written last, so its presence
means all output is on disk.

- **Idempotent start.** `exec` has no Idempotency-Key. The start script creates `<run>.lock`
  exclusively; a second start finds it and prints `ALREADY`. After a lost answer the runner reads the lock
  and starts again only if it is free.
- **Liveness.** A run is alive when its pid exists and `/proc/<pid>/environ` carries the run's
  own token (guards against pid reuse).
- **Stop.** TERM to the run's process group, a grace period, then KILL to whatever is left of the
  group, whether or not the leader is still running: a child that ignores TERM outlives the leader,
  also after a normal exit. A group is signalled only when it is the run's own (its leader is alive
  with the run's token, or a process in it carries the token), and afterwards it must be empty or
  the stop fails (`SURVIVORS`). The runner stops the task's processes at the end of every turn and
  of every run, however it ends. Used by cancel, by failure cleanup, and by `stopOrphaned`; the
  restart sweep also finds finished runs that left processes behind. A stop can overtake a start
  that is still on its way: it leaves `<run>.cancel` marks (for the current run too), and the start
  script and the run script both refuse to go on when they find one.
- **Streaming.** One polling `exec` per sandbox per tick serves every watched run, returning
  base64 slices by offset. The server holds at most 1 MiB of an unfinished output line; the rest
  of a longer line is dropped up to its next newline, with a progress note. Output quoted in a
  failure reason is cut to 300 characters per line, progress notes to 500 and failure reasons to
  2,000. Polling was chosen over SSH because the sandbox terminal WebSocket has one viewer and is
  reserved for the user handoff (T14). After 5 failed polls in a row the run fails with "sandbox
  unreachable".

## Secrets

The model key, the gateway base URL and the MCP session token travel only in `exec` `envs`.
The Claude MCP config references `${MAKA_MCP_TOKEN}` and the Codex config uses
`bearer_token_env_var`, so no secret is written to the sandbox disk. Progress notes and failure
reasons are scrubbed of those values, and then cut to length, so a cut never leaves half a secret.
That order holds everywhere the CLI's output is quoted: the vendor parsers take a redaction
function and apply it to each text before they shorten it, and the runner scrubs the lines it
quotes itself (the `MAKA_GUARD:` reason and the last raw line) before cutting them.

The CLI's raw output can still contain them (the agent may print its environment). It is written
to `<logRoot>/<taskId>/<run>.out`, default `/dev/shm/maka-logs`, never next to the run: a snapshot
holds the sandbox's files, not its memory. The run script refuses to start (exit 43,
`MAKA_GUARD:`) unless that directory is mode 0700, owned by the sandbox user and on `tmpfs` or
`ramfs`. The stop at the end of each turn deletes the run's own output file, before the snapshot
(the empty task directory stays until a task-wide stop).
What the CLI keeps in its own files (its session transcript under `$HOME`) is not covered: a tool
call that prints a key there is in the snapshot, and only the per-task key's revocation limits that.

## API keys only

Before the CLI starts, the run script unsets login-selector variables and refuses to start
(exit 42, `MAKA_GUARD:`) if a subscription credential file exists in the sandbox. Codex also gets
`forced_login_method="api"`. Nothing in this package offers or reads a claude.ai or ChatGPT login.

## Result hand-back

`result.json` is copied with `exec` as the sandbox user, never with `GET /files` (which reads
as root and would follow a task-controlled symlink). The script refuses symlinks and
non-regular files, opens with `nofollow`, copies at most 1 MiB + 1 byte, and sends it in 256 KiB
base64 chunks. The host validates the manifest, writes `resultPath` through a temp file and a
rename (mode 0600), and only then reports `finished`. If the file is missing or invalid and a
session id is known, the session is resumed once with "write it again" before the task fails.
The start script deletes the previous turn's `result.json` once it holds the run's lock (a retried
start does not reach that line), and a resumed turn is told to write it, so a turn that does no
work cannot pass for one that did.
Runner code on the host writes only `resultPath`; the runner never gets write access to the
orchestrator's handoff root.

## Snapshots and resume

After each successful turn a snapshot of the sandbox is requested. Instabox freezes files for well
under a second and does not pause the machine, so other tasks on it keep running. Memory and
running programs are not saved; files, including credentials under `/data/home`, are. A snapshot
failure is a progress note, never a task failure.

A snapshot holds the whole machine, so retention is per machine: the newest `keepSnapshots`
(default 2) are kept across all tasks on it. "Newest" is by capture order: a stamp (`snapshotAt`)
is taken right before the snapshot is requested, not when its upload finishes. A slow upload that
was requested first is the oldest, so it cannot push out the snapshots requested after it, and a
record only ever moves to a snapshot requested no earlier than the one it pointed at. When one is evicted, every record that pointed at it
moves to the machine's newest snapshot (which contains that task too), and the evicted one is
deleted only when no record anywhere points at it. Record updates and this trimming run one at a
time through `Fleet.exclusive`, so concurrent turns cannot write back a stale list. A snapshot
that was created but never filed (the wait failed or was cancelled) is deleted.

`resume(taskId, { prompt, spec })` continues by the vendor session id kept in the store, and
restores the record's newest snapshot when the sandbox is gone. Known gap: a resume that is
restoring from a snapshot at the moment retention evicts it fails and can be tried again.

An activity lease (`maka-<taskId>`) keeps the machine from idle-pausing while a run is open.

## Sandboxes and tenants

`SandboxProvider.acquire({ tenantId, taskId })` allocates per tenant. `FixedMachineProvider` and
`TenantMachineProvider` throw for a tenant with no assigned sandbox; one tenant's task never runs on
another's machine. `TenantMachineProvider` refuses a table that gives one machine to two tenants
when it is built, since snapshots and the sweep treat a machine as one tenant's. The table is
copied first and the copy is checked, so changing the caller's object afterwards changes nothing.

**Accepted risk:** tasks of the same tenant share a sandbox and run as the same sandbox user. They can
read each other's environment (`/proc/<pid>/environ`) and signal each other. That is
acceptable for a single tenant running its own tasks; a deployment that does not trust its tasks to
each other needs a sandbox per task.

## Cancel and cleanup

A run holds a model key, a sandbox lease, an activity lease with a renewal timer, a poll watch and
an open-run count. All of it is released by one memoized cleanup, started by whichever comes first:
the end of the run or a `cancel()`; every later `cancel()` awaits the same promise. A cancel aborts
a run-level signal, which cuts short whatever the run is waiting on (the key and sandbox calls, the
shared CLI install, the launch, a snapshot) without waiting for it to return. A key or lease that
arrives after that is released on arrival, and no renewal timer is started after it.

The cleanup's steps are independent and each is bounded by `cleanupTimeoutMs` (20 s): revoke the
key; stop the processes, then delete the activity lease, then release the sandbox. One that throws
(also synchronously) or hangs is reported through `onCleanupError` and the others still happen;
the open-run count and the event stream are always closed last. A process that survived KILL is
such a failure: the sandbox is still released, as the provider owns what happens to it next.

The orchestrator is told a run is over before its cleanup has finished, so a resume of the same
task can already be running when the old cleanup's stop goes out. The stop is therefore scoped to
the runs this run started (`MAKA_ONLY_RUNS`): their process groups, their locks and their raw output
files, never another turn of the task. Only the task-wide stop (`stopTask`, `sweepOrphans`) touches
all of a task's runs. Not scoped: the activity lease is named per task, so the old cleanup's DELETE
can remove the resumed run's lease until its next renewal (at most a third of the TTL).

## Restart recovery

The orchestrator's `restore()` calls `Runner.stopOrphaned(taskId, { signal })` for every
unfinished task, concurrently, each bounded by `orphanStopTimeoutMs` (10 s). A failure becomes a
progress note before the task is ended as failed. `sweepOrphans(knownTaskIds)` (called by the server
after `restore()`) stops live runs whose task the log does not know, and returns
`{ stopped, failed: [{ machineId, taskId?, error }] }`; an unreachable sandbox is reported, not thrown.

## Backlog (known, not fixed)

- **Activity-lease renewal race.** The renewal is a fire-and-forget PUT. A renewal that hangs makes
  the cleanup's DELETE wait for it (bounded by `cleanupTimeoutMs`) and then be skipped, and a PUT
  sent earlier can land after the DELETE and recreate the lease. The lease has a TTL
  (`leaseTtlSeconds`, 300 s), so the damage is bounded: the machine may stay awake for up to that
  long after the run. Fix when needed by giving each run a lease generation and ignoring a PUT
  after a DELETE.
- **Tracking counts attempts, not successes.** `Tracking` in the test support counts `revoked` and
  `released` when the call is made, so a revoke or release that threw is counted like one that
  worked. Add separate counters for the ones that succeeded and assert on those.

## Not verified

Nothing here has run against a real sandbox, CLI or model; tests use a fake instabox and fake CLIs.
These facts are pinned from documentation and need the first live run to confirm:

- The Claude CLI expands `${MAKA_MCP_TOKEN}` in `--mcp-config` headers.
- `forced_login_method="api"` is the accepted Codex config value.
- Stream formats of the pinned CLI versions (Claude 2.1.303, Codex 0.163.0).
- Install time and `apt`/`npm` reachability inside the sandbox.
- That `/dev/shm` in the sandbox is `tmpfs` (`stat -f -c %T`) and not part of a snapshot. If the
  first, a run fails fast with the guard message; set `logRoot` to another memory-backed directory.

The live smoke test (`src/__tests__/live.test.ts`) is gated on `MAKA_CLOUD_LIVE=1`,
`INSTABOX_API_KEY`, `ANTHROPIC_API_KEY` and `INSTABOX_MACHINE_ID`.
