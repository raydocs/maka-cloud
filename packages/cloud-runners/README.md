# @maka-cloud/runners

`Runner` implementations for the orchestrator (`@maka-cloud/orchestrator`) that run the
Claude CLI (the one the Claude Agent SDK drives) and Codex inside an
[instabox](https://api.instabox.sh/v1/openapi.json) sandbox. Models are reached with API keys
only. Design and decisions: `docs/fork/design/cloud-runners.md`.

```ts
import { createCloudRunnersFromEnv } from '@maka-cloud/runners';

// INSTABOX_API_KEY, INSTABOX_MACHINE_ID, optional INSTABOX_API_URL,
// ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL for a gateway), OPENAI_API_KEY
const cloud = createCloudRunnersFromEnv();
const orchestrator = await Orchestrator.create({
  store,
  runners: new RunnerRegistry(cloud.runners), // names: claude-agent-sdk, codex
  handoffRoot,
});
// create() restores the log and stops leftover runs of unfinished tasks by task id.
// Afterwards, stop runs in the sandbox whose task the log does not know at all:
await cloud.sweepOrphans(knownTaskIds);
```

For production pass `createCloudRunners({ client, sandboxes, modelAccess, sessions })`:
`sandboxes` decides which sandbox a tenant's task runs in, `modelAccess` issues the per-task
key (and gateway base URL) and is told to revoke it when the run ends, `sessions` (use
`JsonFileSessionStore`) remembers session ids and snapshots so a task can resume after a restart.

## What one run does

1. Issues model access, acquires the tenant's sandbox (or restores the latest snapshot).
2. Installs the CLI once per sandbox and version (a detached job, shared by concurrent tasks).
3. Copies the brief into `<workRoot>/<taskId>/brief.md` and starts the CLI detached, at most once.
4. Streams output by polling (one `exec` per sandbox per tick for every watched run).
5. Copies `result.json` back with `exec` as the sandbox user, validates it, writes `resultPath`
   on the host, reports `finished`. A missing or invalid result gets one repair turn by resume.
6. Snapshots the sandbox after each successful turn (best effort; keeps the newest 2 per sandbox,
   across its tasks).

The CLI's raw output is kept in `/dev/shm/maka-logs` (`logRoot`), which must be memory-backed so
that snapshots never contain it, and is deleted when the turn ends. A turn that finishes stops
every process it started.

Cancel, failure and unreachable sandboxes all stop the CLI and its children, delete the activity
lease, revoke model access and release the sandbox, each step independently and within a time limit. `resume(taskId, { prompt, spec })` continues a session.

## Tools in the sandbox

`sandboxTools: [{ name, content }]` puts programs on every run's PATH (`$HOME/.maka-cli/bin`). Each is
one self-contained file with a shebang, installed once per sandbox and again when its content
changes (the sandbox keeps the sha256 as a marker, and the file is checked against it before it
is renamed into place). Runners does not depend on the packages that build tools; the wiring
passes them in. The research playbook's `cite-check` is one:

```ts
import { citeCheckSandboxTool } from '@maka-cloud/playbooks/sandbox-tool';
const cloud = createCloudRunnersFromEnv(process.env, {
  sandboxTools: [await citeCheckSandboxTool()],
  inputs: sameConversationInputPolicy(orchestrator), // see below
});
```

## Files from other tasks

A brief starts with `maka-inputs: <taskId> <path> [<path> ...]` lines to receive files of
finished tasks. Before the CLI starts, the runner copies those paths of that task's workspace into
`workspace/inputs/<taskId>/` and says so in the prompt. Only the leading block of the brief counts;
the same line anywhere else fails the task. Without `inputs` configured, a brief that asks for
files fails. The policy decides who may read whom; `sameConversationInputPolicy(orchestrator)` allows
tasks of the same conversation that have ended. The runner itself also requires the same tenant and
the same sandbox. Any refusal fails the task before the CLI starts. Design: `docs/fork/design/cloud-runners.md`.

## Artifacts

When a task finishes, the files its manifest lists in `artifacts` (plain paths relative to its workspace)
are copied into its handoff directory under the same path, so the server can serve them. A brief can start
with `maka-artifacts: <path> ...` to name files that must exist and be listed: if one is missing, the agent
gets one repair turn, then the task fails. The runner adds a `runner-exported: <paths>` line to the
manifest's `done` (and drops any such line a model wrote), so a playbook's `verify` can tell what really
arrived. Caps: `exportLimits`, default 20 files, 2 MiB each, 8 MiB in all.

## Tests

`npm run build && npm run test:dist -w @maka-cloud/runners` runs against the in-process fake instabox with a fake `claude`
and `codex` script. `src/__tests__/live.test.ts` is skipped unless `MAKA_CLOUD_LIVE=1`,
`INSTABOX_API_KEY`, `ANTHROPIC_API_KEY` and `INSTABOX_MACHINE_ID` are all set; it spends real money.
