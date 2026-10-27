# boat.dev as the sandbox backend

Decided 2026-10-26, confirmed 2026-10-27: every sandbox runs on boat.dev and instabox goes away.
This replaces `packages/cloud-instabox`; `docs/fork/go-live-plan.md` Phase 3.1 is the schedule. The
first live run is on boat.

## What boat is, for us

A boat sandbox is a full-root Ubuntu VM (`bx_…`) with Docker, systemd, a public URL and a desktop
stream, billed per second while it runs. A stop saves the disk as a snapshot and ends every
process; there is no pause. Resume and fork start from the newest snapshot; a saved snapshot is a
named template that never expires. API at `https://boat.dev/api/v1`, bearer keys `boat_…`.

Checked on a trial sandbox (2026-10-27): `unshare --user --map-current-user --pid --fork true` and
passwordless sudo work, `/dev/fuse` exists, Claude Code 2.1.311 and Codex 0.164.0 are preinstalled.
Commands run as `user` (uid 1000).

## How our code reaches it

The runners, the workspace executor and the egress guard use a sandbox through `SandboxApi`
(`packages/cloud-instabox/src/api.ts`), the instabox-shaped methods they call. The new
`packages/cloud-boat` gives a `BoatClient` with the same methods and the same error classes, so
nothing above it changes in the first step. Once boat runs the rehearsal and the live probes,
`cloud-instabox` is deleted, the types move to `cloud-boat` under provider-neutral names, and the box
pool is rebuilt on fork (below).

| `SandboxApi` method | boat call | Notes |
|---|---|---|
| `exec` | `POST /sandboxes/{id}/commands` | see "Commands" |
| `getFile` | `GET /sandboxes/{id}/files` | |
| `getMachine` | `GET /sandboxes/{id}` | state mapping below |
| `ensureRunning` | `POST …/resume` when `archived` or `error`, then poll `GET` | `sandbox_restoring` is retried for a few seconds |
| `putActivityLease` | `PATCH /sandboxes/{id}` `{ttlSeconds}` | the lease is the auto-stop deadline; renewing extends it |
| `deleteActivityLease` | `PATCH` back to a short `ttlSeconds` | the sandbox stops soon after the last task lets go |
| `createSnapshot`, `waitForSnapshot`, `deleteSnapshot` | `POST /saved-snapshots`, `GET` by name, `DELETE` | see "Snapshots" |

States: `provisioning`, `provisioned`, `cloning` → `starting`; `ready`, `idle`, `running` →
`running`; `archiving` → `suspending`; `archived` → `suspended`; `error` → `error`. A deleted sandbox
answers 404 and maps to `deleted`.

Errors: boat's `{ok:false, error:{code, message, details}}` becomes `InstaboxApiError` with boat's
code. `machine_not_running` keeps its name and meaning, so the runner's wake-and-retry path works
unchanged. `sandbox_starting`, `sandbox_direct_failed` with `retryable: true`, 429 and 503 (with
`retryAfterSeconds`) are retryable; everything else is not. A command is never sent twice after
it may have run (boat's own rule for `sandbox_direct_failed`).

## Commands

boat's command call takes `command`, a `cwd` relative to the work directory, `timeoutSeconds` (1 to
600) and `detached`. It has no environment and no stdin, and boat keeps every command's text and
output for 90 days. Our runners pass secrets and briefs through `envs` and `stdin`. So:

- The client writes `envs` and `stdin` to two files in a private directory (`/tmp/maka-exec`, mode
  700) through the files API, and the command it sends only sources and reads those files, deletes
  them, `cd`s to the absolute `cwd` and runs the script. **No secret is ever in a command's text.**
- Every sandbox is created with `monitoring: false`, so boat keeps no command history, no process
  output and no process list. Live output of a running command still works.
- A command longer than 600 s does not exist in our code: long runs (the CLI turns) are started
  with `nohup` by our launch script and read by the poller, as on instabox. The client refuses a
  `timeoutSeconds` above 600 instead of cutting it silently.

This is one or two more round trips per command. The poller's one-exec-per-tick design keeps that
cheap; measure it in the live probes.

## Lifecycle and leases

boat stops a sandbox one hour after create or resume unless told otherwise. A task renews its
lease (`ttlSeconds`) while it runs, as it renews instabox's activity lease today, so the sandbox
never stops under a running agent. A stop ends every process, so a lease that runs out loses the
run exactly as an instabox sleep did (`launch-notes.md`, "A close lets go of the runs"): a
resumable runner starts again from its session, and the coding runner fails the task as orphaned.

Firewall rules do not survive a snapshot. The runner already re-applies and re-checks the egress
guard before every run on a machine that may have been resumed (`machine.ts`), which is what boat
needs. Our guard blocks the agent account only, which is boat's own recommendation; the `user`
account keeps boat's WireGuard tunnel and port 8911.

## Snapshots

The fleet snapshots a machine after each turn (`keepSnapshots`, default 2) so a session can resume
on a fresh machine. On boat these are saved snapshots named `maka-<machine>-<n>`: 10 are free, then
$0.056 a day each. Taking one of a running sandbox can take minutes, so the fleet's snapshot stays
off the turn's critical path, as it is now. Open question for the live probes: whether boat's
automatic stop snapshot plus `fork` makes the per-turn snapshot unnecessary.

## One sandbox per task (replaces the box pool)

1. Per repository, a builder sandbox clones it, installs its dependencies and both CLIs, and is
   saved as `maka-setup-<tenant>-<hash>`.
2. A task creates its sandbox from that saved snapshot (`POST /sandboxes` with the snapshot), with
   `monitoring: false`, the `safe-for-third-parties` environment, and a name derived from the task
   id with an `Idempotency-Key`, so a repeated create finds the first one.
3. When the task ends the sandbox stops; it is deleted when the task's change is merged or dropped
   (`keepUntilReviewed`).

A task no longer shares a machine, so the one-task-at-a-time rule (`MAKA_CLOUD_TASKS_PER_INVITE`)
loses its reason. Starts are limited (the $20 plan: 12 a minute, 60 an hour, 200 a day, 100 at
once); the server queues a task that would pass a limit instead of failing it.

## Credentials

- Model keys stay in our gateway. The sandbox gets its per-task gateway token through the exec
  files above, never through boat's environment or credential proxy.
- The boat environment used for tasks is `safe-for-third-parties`: no secret, GitHub login or
  credential of the owner reaches a user's sandbox.
- A user's own Claude or ChatGPT plan is signed in inside their sandbox, as the agent account,
  through Anthropic's or OpenAI's own flow (AGENTS.md "Product constraints"). It stays in that
  sandbox and in the setup snapshot made from it only if the user asks.
- The boat API key is the host's only boat secret, in the settings file.

## Tests and the rehearsal

- `FakeBoat` (`@maka-cloud/boat/testing`): an in-memory boat with the same answers and errors,
  for unit tests and for the client's own contract tests.
- The rehearsal's sandbox stand-in speaks boat's API instead of instabox's.
- Live probes behind `MAKA_CLOUD_LIVE=1` and a boat key: create, exec with env and stdin, a lease
  that keeps the sandbox up past an hour, stop and resume, the egress guard after a resume, the
  check namespace as the agent account, `claude -p` under the `env -i` entry, a saved snapshot and
  a sandbox made from it.

## Order of work

1. `SandboxApi` in front of `InstaboxClient` (done in the PR that adds this document).
2. `packages/cloud-boat`: `BoatClient`, `FakeBoat`, contract tests.
3. Host settings: `MAKA_CLOUD_BOAT_API_KEY` and the sandbox per invite as a `bx_` id; the
   rehearsal on the boat stand-in; the live probes.
4. One sandbox per task from the setup snapshot; the box pool and `cloud-instabox` are deleted.

## Not decided yet

- EU regions only: the desktop stream will lag for users in Asia and the Americas.
- Whether the per-turn snapshot stays (see "Snapshots").
- The boat plan for launch ($20 a month at least; the trial allows two sandboxes at once).
