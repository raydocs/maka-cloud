# Cloud server (`@maka-cloud/server`)

Task T4. The process the web app talks to: HTTP API, an event stream with
resume, and the host for the T2 orchestrator. Written before the code.

## How it relates to the Maka runtime

The server does not import the runtime and has no `@maka/*` dependency, the same
rule as `@maka-cloud/orchestrator`, so an upstream sync cannot break its build.

`packages/runtime-host` already is the hosting layer. It elects one owner
process per storage root (`tryAcquireRuntimeHostLaunch`; a second owner gets
`RuntimeHostRootAlreadyOwnedError`) and exposes a client side
(`connectOrSpawnRuntimeHost`, `runHostedExecution` in `client/`) that finds or
starts that owner and talks to it over its authenticated transport. Embedding
the runtime inside the HTTP process would need new hosting code for lifecycle,
ownership and crash handling that runtime-host already has, and it would tie the
server's restarts to the runtime's. So the conductor (T5) is a client of a
runtime-host owner, and this package only exposes a port for it:

```ts
interface ConversationHandler {
  onUserMessage(message: { conversationId; messageId; text }, conductor: ConductorAccess): void | Promise<void>;
}
```

`ConductorAccess` gives T5 the orchestrator MCP URL and a conductor token for
that conversation (rotated on request, never sent over the public API). With no
handler the server stores the message and nothing replies. Wiring T5 is T5's
job.

## Storage

One SQLite file (`node:sqlite`), opened by exactly one process.

| Table | Contents |
|---|---|
| `task_log(seq, at, task_id, event)` | The orchestrator's `TaskStore`. `seq` is assigned `max + 1` inside the append transaction, so it is exactly 1, 2, 3, ... |
| `task_index(n, task_id, session_id, root_session_id, parent_task_id, state, created_at)` | Projection of the log for the store's index lookups. Rebuildable from `task_log` (`rebuildTaskIndex`). |
| `conversations`, `messages` | Append-only. `messages` has a unique `(conversation_id, client_message_id)` so a retried POST stores once. A conversation owns one orchestrator session id. |
| `feed(id, kind, conversation_id, ref, at)` | The order of everything a client can stream. A conversation row, a message or a `task_log` row is inserted together with its `feed` row in one transaction. |
| `sessions(session_id, token_sha256, parent_task_id, created_at)` | The orchestrator's `SessionStore`. Digests only. |

Invite tokens (`invites`: id, SHA-256 digest, label, created and revoked times)
live in a second SQLite file. The main database belongs to the one running
server, while invites are created and revoked from the command line at any time;
a separate file lets both happen without the CLI ever touching the exclusive
lock. The server reads it on every request, so a revoke takes effect at once.

`task_log`, `messages` and `feed` have `BEFORE UPDATE` and `BEFORE DELETE`
triggers that abort, so append-only is enforced by the database.

`feed` is separate from `task_log` because the orchestrator requires `seq` to
count task events only. SSE ids come from `feed.id`.

### One writer per database

The write chain, the session cache and the archive cache all assume one writer.
`openDatabase` sets `locking_mode=EXCLUSIVE` and takes the lock before anything
else; a second process (or a second open in the same process) fails at once with
`DatabaseInUseError` instead of waiting. The lock belongs to the kernel, so a
crashed server never leaves a stale lock file.

## HTTP API (`/v1`, JSON)

Every route, the stream included, needs `Authorization: Bearer <invite token>`.
Invite tokens read `mki_<inviteId>.<secret>`; the id picks the row and digests
are compared with `timingSafeEqual`. Missing, malformed, unknown and revoked
tokens all get the same 401. There is no route that creates invites; the CLI
(`cloud-server invite create|list|revoke`) does, and prints the token once.
Single tenant: every invite sees every conversation. Accounts replace this in T17.

| Route | Behavior |
|---|---|
| `POST /v1/conversations` | `{title?}` -> `{conversationId}`. Creates the conversation and its orchestrator session. |
| `GET /v1/conversations` | Conversations, oldest first. |
| `POST /v1/conversations/:id/messages` | `{text, clientMessageId?}` -> 202 `{messageId}`. Stores, emits, then calls the handler. A repeated `clientMessageId` returns the first message's id and emits nothing. |
| `GET /v1/conversations/:id/tasks?after=&limit=` | Task views for the conversation's trees, in creation order, paged. |
| `GET /v1/events?conversation=&after=` | Server-sent events. `id:` is the feed id. |

Unknown or malformed ids are 404. Bodies over 64 KiB are 413; message text is
capped at 32,000 bytes.

### Event stream

Events are `conversation.created`, `message.posted` and `task.event` (the
`TaskEvent` plus its log `seq`). Resume with the `Last-Event-ID` header (what a
browser sends on reconnect) or `?after=`; the header wins.

A connection holds a position, not a buffer. It reads the next page of rows
after that position from SQLite, writes them, and repeats while the table moves.
A commit only tells connections to look again; nothing is copied per connection.
Because a row is committed before anyone is told, and a connection re-reads
until a pass finds nothing, there is no window where an event can be missed or
sent twice, whether it arrives during replay or after.

Backpressure is the memory bound: the next page is not read until the socket
drained. A client that does not drain within 30 s is closed and resumes later
from its last id. A comment line goes out every 15 s.

## Limits

| Limit | Scope | Default |
|---|---|---|
| Open event streams | invite | 4 |
| Open event streams | server | 256 |
| Message posts | invite, token bucket | 30 per minute |

Over a limit: 429 with `Retry-After`, nothing stored. Orchestrator quotas (tasks,
waits, MCP connections) are configured through the same `quotas` option and
documented in `orchestrator.md`.

## Startup and shutdown

1. Open the database (exclusive lock, migrations). Failure here ends startup.
2. `Orchestrator.create` over the SQLite stores. It ends every task the log
   still lists as unfinished by appending `task_failed` "orphaned" (or
   `task_cancelled`), and those events enter the feed, so a client resuming from
   an old id sees them.
3. `sweepOrphans(knownTaskIds)` from the runners package, if one was given: it
   finds and stops remote runners left behind by the previous process. It gets
   every task id in the log. `Orchestrator.create` has already stopped leftover
   runs of the tasks it ended by id, so the sweep is for runs the log does not
   know. Its failures (each names a machine, and a task when known) are reported
   through `onWarning`; it never blocks startup.
4. The orchestrator's MCP endpoint listens on loopback, then the public API.

`close()` reverses it: stop accepting, end event streams, close the MCP
endpoint, close the database (which releases the lock). The database and the
invite file are closed even if an earlier step throws, and a second `close()`
returns the first one's result. A start that fails part-way undoes the steps
it had completed. Event streams give back their slot, feed subscription and
heartbeat timer on every exit (client gone, server shut down, feed read failed,
slow client dropped after the drain timeout, failure while opening), and a slow
client's socket is destroyed, not left holding buffered data.

## Not here

The conductor (T5), real runners (T6), the web app (T9), accounts (T17), TLS and
reverse-proxy settings for the stream (deployment concerns), and a `serve`
command: composing runners and the conductor is done by whoever owns the
deployment.
