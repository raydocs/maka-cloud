# MakaEngine

Status: in the tree as `@maka-cloud/maka-engine`. `TsInProcessEngine` is the
production implementation. `RustHostEngine` is types only.

Upstream plans to replace `main` with `rust-preview` around late November 2026.
On that line `packages/core`, `runtime`, `runtime-host` and `storage` no longer
exist, and the Host speaks length-prefixed JSON over IPC or WebSocket. Cloud
packages used those TypeScript packages in-process. This seam is how they stop
doing that, without a migration of stored sessions.

## What the package is

`MakaEngine` is the session-host surface our cloud packages actually use:

- create a session
- send a turn and stream events
- stop a session
- recover sessions a previous process left running
- compact (history-integrity checks only)
- rebuild the manager over the same stores (harness restart)

`TsInProcessEngine` is a move of today's construction: `SessionManager` plus
Maka's SQLite session, run and runtime-event stores, plus a prepared `ai-sdk`
backend factory. Callers still build `AiSdkBackend` themselves. Behavior is
unchanged.

The same package re-exports the types and helpers those call sites need, so no
file outside this package imports `@maka/core`, `@maka/runtime`, `@maka/storage`,
`@maka/runtime-host` or `@maka/eval`. A scanner
(`scripts/cloud-maka-engine-boundary.mjs`) enforces that.

Workspace-executor helpers (instabox) and `@maka/eval` (cloud-evals) are
re-exports, not methods on `MakaEngine`. They are TypeScript-line APIs. On
rust-preview the workspace becomes Host file methods; eval has no Host
equivalent yet.

## Call sites

| Package | What moved |
|---|---|
| `cloud-conductor` `maka-host.ts` | `SessionManager`, stores, `AiSdkBackend` wiring, model-call metering |
| `cloud-conductor` `conductor.ts`, `config.ts`, `pricing.ts`, `tools.ts` | `SessionEvent`, `ModelCallAttempt`, `ThinkingLevel`, `LlmConnection`, `MakaTool` |
| `cloud-conductor-checks` `harness.ts` | same host construction, plus context-budget, summarizer, tool-result archive, compact, restart |
| `cloud-conductor-checks` `conversation.ts` | `MakaTool` |
| `cloud-instabox` `executor.ts`, `facts.ts`, builtin-tools test | `WorkspaceExecutor` and the grep/image/read helpers |
| `cloud-evals` | `@maka/eval` (`parseExperimentSpec`, `FileAttemptStore`, `expandExperiment`, `runMakaEvalCli`, …) |

## Transport (rust-preview)

Source of truth:

- [platform/transport/README.md](https://github.com/apache/maka/blob/rust-preview/platform/transport/README.md)
- [ARCHITECTURE.md](https://github.com/apache/maka/blob/rust-preview/ARCHITECTURE.md)
- [plugins/agent/api/README.md](https://github.com/apache/maka/blob/rust-preview/plugins/agent/api/README.md)
- [plugins/agent/session-import/README.md](https://github.com/apache/maka/blob/rust-preview/plugins/agent/session-import/README.md)

Local IPC and WebSocket carry complete JSON frames with a four-byte unsigned
big-endian length prefix. There is no separate whole-message quota. Startup
and opening requests use the same framing. A trusted local client starts
through `maka_host_runtime::application::host::startup::connect` against an
absolute Maka CLI path; it reuses a live Host or asks that CLI to start one.

`RustHostEngine` records that mapping as types. It does not open a socket.

## Method mapping

`MakaEngine` / `MakaSessionRuntime` → rust-preview `agent` service
(`packages/plugin-sdk/src/generated/methods.ts` on that branch):

| Our method | Host method | Mode | Notes |
|---|---|---|---|
| `createSession` | `agent.create` | mutation | Receipts stay with the original call. |
| `sendMessage` | `agent.send` | mutation | Admits work and returns its identity. Streamed progress is `agent.watch`, not the send reply. |
| `stopSession` | `agent.stop` | mutation | Names that exact invocation. |
| `compactSession` | `agent.compact` | mutation | One-shot prompt override; `setCompactionPrompt` is the durable setting. |
| `recoverInterruptedSessions` | (none) | Host-owned | The Host recovers on restart. Clients reconnect and read `history` / `watch`. They do not resend. |
| `restart` | (none) | Host-owned | A new Client session against the same Root. Accepted work stays. |
| event stream | `agent.watch` | subscription | Resume from the last `nextAfter`. Pair with fenced `history`. |

Related Host methods we do not call yet, but a later client will: `history`,
`resumable`, `resume`, `pendingInteractions`, `respond`, `fork`, `diagnostics`.

## Event mapping

The conductor switches on `SessionEvent.type`. rust-preview does not emit that
union. `agent.watch` yields `AgentDeliveryPage` rows fenced by `through` /
`nextAfter`.

| `SessionEvent.type` we read | rust-preview |
|---|---|
| `tool_start` | watch delivery: tool activity |
| `tool_result` | watch delivery: tool result |
| `text_complete` | watch delivery: assistant text |
| `error` | watch delivery and/or `agent.diagnostics` |
| `complete` | watch delivery: execution completed |

`ModelCallAttempt` (spend metering) is a TS run-ledger row. On rust-preview,
usage is a Host observation (`settings.usage` / execution diagnostics), not an
in-process callback. The conductor's `onModelCall` hook will have to subscribe
instead of wrapping `recordModelCallAttempt`.

## Session import

rust-preview import is a Host transaction, not a SQLite copy:

| Our need | Host method |
|---|---|
| Discover sources | `agent.imports` |
| Browse import directories | `agent.importDirectories` |
| Publish a session | `agent.import` |

`plugins/agent/session-import` normalizes Claude, Codex and OpenCode
transcripts to `Transcript`. The Agent service validates the source and
publishes the transcript and the new Session in one transaction. Retries
verify the original records. This package does not implement that, and we are
not migrating stored TS sessions onto it.

## Workspace and eval

Instabox implements Maka's TS `WorkspaceExecutor`. On rust-preview, workspace
reads are `agent.listFiles`, `agent.readFile`, `agent.watchFiles`,
`agent.fileCandidates`, plus bound `files` / process services. A later
`RustHostEngine` would expose those, not a TS executor interface.

`@maka/eval` is a TypeScript experiment runner. rust-preview has no replacement.
Keep the re-export until eval is rewritten or dropped.

## What this is not

- Not a migration of session or run SQLite.
- Not a Host client.
- Not a change to Claude history rules. `TsInProcessEngine` still does what
  maka-host did: prepared factory, stored system prompt, no request-only
  contexts, no compaction on the conductor path.
- Not a license to import `@maka/core` (and the rest) from a new cloud package.

When the fork tracks rust-preview, implement `RustHostEngine` against the
mapping above and switch the conductor's default engine. Leave
`TsInProcessEngine` until that line no longer builds.
