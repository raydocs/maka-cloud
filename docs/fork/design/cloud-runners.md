# Sandbox runners (`@maka-cloud/runners`)

Task T6. Two `Runner`s for the orchestrator (T2), `claude-agent-sdk` and `codex`, that run
the vendor CLI inside an instabox sandbox (T1). The package depends on
`@maka-cloud/orchestrator` and `@maka-cloud/instabox` only, so upstream changes cannot break it.

## Shape of a run

The CLI runs detached in the sandbox, not inside an `exec` call: `exec` collects output, caps
it at 1 MiB per stream and ends after 10 minutes at most. Per task, `<workRoot>/<taskId>/`
holds `brief.md`, `result.json`, a `workspace/` directory, and for each CLI invocation (`t1`,
`t2`, ...) a lock, script, token, pid, `.out` (stdout and stderr together) and `.exit` file.
The exit file is written last, so its presence means all output is on disk.

- **Idempotent start.** `exec` has no Idempotency-Key. The start script creates `<run>.lock`
  exclusively; a second start finds it and prints `ALREADY`. After a lost answer the runner reads the lock
  and starts again only if it is free.
- **Liveness.** A run is alive when its pid exists and `/proc/<pid>/environ` carries the run's
  own token (guards against pid reuse).
- **Stop.** TERM to the process group, a grace period, then KILL. Used by cancel, by failure
  cleanup, and by `stopOrphaned`.
- **Streaming.** One polling `exec` per sandbox per tick serves every watched run, returning
  base64 slices by offset. Polling was chosen over SSH because the sandbox terminal WebSocket
  has one viewer and is reserved for the user handoff (T14). After 5 failed polls in a row the run
  fails with "sandbox unreachable".

## Secrets

The model key, the gateway base URL and the MCP session token travel only in `exec` `envs`.
The Claude MCP config references `${MAKA_MCP_TOKEN}` and the Codex config uses
`bearer_token_env_var`, so no secret is written to the sandbox disk. Progress notes and failure
reasons are scrubbed of those values.

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
Runner code on the host writes only `resultPath`; the runner never gets write access to the
orchestrator's handoff root.

## Snapshots and resume

After each successful turn a snapshot of the sandbox is requested. Instabox freezes files for well
under a second and does not pause the machine, so other tasks on it keep running. Memory and
running programs are not saved; files, including credentials under `/data/home`, are. A snapshot
failure is a progress note, never a task failure. Each task keeps its newest 2, and a snapshot that
any record in the `RunnerSessionStore` references is never deleted.

`resume(taskId, { prompt, spec })` continues by the vendor session id kept in the store, and
restores the latest snapshot when the sandbox is gone. Known gap: a snapshot dropped by one
record while another record still referenced it is not revisited later, so it can outlive both.

An activity lease (`maka-<taskId>`) keeps the machine from idle-pausing while a run is open.

## Sandboxes and tenants

`SandboxProvider.acquire({ tenantId, taskId })` allocates per tenant. `FixedMachineProvider` and
`TenantMachineProvider` throw for a tenant with no assigned sandbox; one tenant's task never runs on
another's machine.

**Accepted risk:** tasks of the same tenant share a sandbox and run as the same sandbox user. They can
read each other's environment (`/proc/<pid>/environ`) and signal each other. That is
acceptable for a single tenant running its own tasks; a deployment that does not trust its tasks to
each other needs a sandbox per task.

## Restart recovery

The orchestrator's `restore()` calls `Runner.stopOrphaned(taskId, { signal })` for every
unfinished task, concurrently, each bounded by `orphanStopTimeoutMs` (10 s). A failure becomes a
progress note before the task is ended as failed. `sweepOrphans(knownTaskIds)` (called by the server
after `restore()`) stops live runs whose task the log does not know, and returns
`{ stopped, failed: [{ machineId, taskId?, error }] }`; an unreachable sandbox is reported, not thrown.

## Not verified

Nothing here has run against a real sandbox, CLI or model; tests use a fake instabox and fake CLIs.
These facts are pinned from documentation and need the first live run to confirm:

- The Claude CLI expands `${MAKA_MCP_TOKEN}` in `--mcp-config` headers.
- `forced_login_method="api"` is the accepted Codex config value.
- Stream formats of the pinned CLI versions (Claude 2.1.303, Codex 0.163.0).
- Install time and `apt`/`npm` reachability inside the sandbox.

The live smoke test (`src/__tests__/live.test.ts`) is gated on `MAKA_CLOUD_LIVE=1`,
`INSTABOX_API_KEY`, `ANTHROPIC_API_KEY` and `INSTABOX_MACHINE_ID`.
