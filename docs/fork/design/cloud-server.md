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
| `push_subscriptions(endpoint, invite_id, p256dh, auth, since_feed_id, created_at)`, `push_deliveries(endpoint, task_id, state, at)` | Web Push. Mutable, unlike the log tables. `since_feed_id` is the feed position when the device subscribed. Schema step 3. |

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
| `POST /v1/tasks/:taskId/{cancel,pause,resume}` | Acts on a task as its conversation, after checking the invite. 200 `{task}` (the public view). 404 unknown task; 409 `invalid_state` (finished, not paused, pause still under way) or `pause_unsupported`; 429 over the control limit. Cancel of a finished task is a 200 no-op. Pause and resume wait for the runner's answer (15 s at most). |
| `GET /v1/tasks/:taskId/artifacts` | `{artifacts: [{index, name, kind, url?}], total}` from the task's manifest (first 500). `kind` is `file` or `link`. |
| `GET /v1/tasks/:taskId/artifacts/:index` | A file's bytes as an attachment, or `{url}` for a link. 404 for anything that is not readable (one answer for every reason), 413 over 2 MiB, 429 over the download limit. |
| `GET /v1/push/key` | `{publicKey}`, the VAPID public key. 404 when push is not configured (so are the next two). |
| `POST /v1/push/subscriptions` | `{endpoint, keys: {p256dh, auth}}` from `PushSubscription.toJSON()` -> 201, or 200 when the endpoint was already registered. 400 `invalid_endpoint` / `invalid_keys`; 429 `too_many_subscriptions` (10 per invite, 1000 in all). |
| `DELETE /v1/push/subscriptions` | `{endpoint}` -> 204. Only the invite that registered it can remove it; otherwise 404. |
| `GET /v1/events?conversation=&after=` | Server-sent events. `id:` is the feed id. |

Unknown or malformed ids are 404. Bodies over 64 KiB are 413; message text is
capped at 32,000 bytes.

### Public view

Task views and `task_created` events leave out `runner`: the runner id names the
vendor behind a run, and clients have no use for it. `costUsd` is present only
once a run reported spend, never `0`. Titles, progress and manifests are written
by models and pass through unchanged.

### Artifacts

A manifest's `artifacts` are strings the task wrote, so they are hostile input.
A plain `https:` URL without credentials is a link: the client gets the URL back
and the server never requests it, so there is no SSRF surface. Everything else is
a path for the `ArtifactSource` port. The default source (`FileArtifactSource`)
reads only inside `handoffRoot/<taskId>`: relative paths with no empty, `.` or
`..` component, every component `lstat`ed (no symlinks, directories on the way,
a regular file at the end), the resolved path inside the task directory, the file
opened with `O_NOFOLLOW | O_NONBLOCK` and checked again on the descriptor, and a 2 MiB cap
(read one byte past it, so a file that grew is still refused). It never goes
through instabox `GET /files`, which reads as root. Content for runs inside a
sandbox plugs in later through the same port, using exec as the dev user with
symlinks refused and a size cap.

Bytes are sent as `text/plain` (`application/json` for `.json`) with
`X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` and a
sandboxing CSP, so a browser never renders them. At most 8 reads run at once
(429 beyond), and each invite gets 60 downloads a minute.

### Web Push

Off unless `CloudServerOptions.push` is set; `pushConfigFromEnv()` builds it from
`CLOUD_PUSH_VAPID_PUBLIC`, `CLOUD_PUSH_VAPID_PRIVATE`, `CLOUD_PUSH_SUBJECT` and
optionally `CLOUD_PUSH_ALLOWED_HOSTS`. The private key lives in memory only: it is
not logged, not stored, and bad settings fail startup with a message that does
not contain them. Encryption (RFC 8291) and VAPID signing (RFC 8292) are the
`web-push` package's; the server only builds the request with it and sends it
itself.

When a top-level task (no parent) ends, every registered device whose invite is
still active gets one message: `{type: "task.finished", conversationId, taskId,
state}`. Nothing a task or a model wrote goes in it, and there is no title.

What is left to send is computed from the database: a terminal event of a
top-level task that came after the subscription (`since_feed_id`) and has no
`push_deliveries` row. A restart therefore sends what it missed and never sends
twice. A `404`/`410` deletes the subscription; `429`, `5xx`, a timeout and a network
error are retried (3 attempts, 5 s times the attempt number apart); other `4xx`
and an exhausted retry record the message as `dropped`. An invite revoked
meanwhile records `revoked`.

The server fetches a URL a client chose, so: the endpoint must be `https`, on port
443, without credentials, on a host in the allow-list (FCM, Mozilla autopush,
Apple, Windows by default); no redirect is followed; the address is checked when
the socket connects (non-public addresses are refused, and so are IP literals); a
send ends after 10 s or when the server closes; and the response is read to 4 KiB.

### Control and cost

The server acts on a task as the conversation that owns it (the root session
found from the task id), never with the conductor's MCP token, which nothing in
the public API reads, rotates or returns. The invite is checked when the request
arrives and again inside the orchestrator's write chain through
`OperatorAccess.authorize`, together with the conversation, so the check and the
action are one step.

Cost is per task. The orchestrator records each run's spend as `task_cost`
events on the top-level task of its tree, and the task view's `costUsd` is the sum
of the most each run reported, so it never goes down. The server only reads it:
`costUsd` on task views is absent until the first event, never `0`. A `task_cost`
frame on the stream carries the one run's figure and `totalCostUsd`, the task's
total as of that event, computed from the log the way the reducer does it.

### Event stream

Events are `conversation.created`, `message.posted` and `task.event` (the
`TaskEvent` plus its log `seq`). A `task_cost` event also carries
`totalCostUsd`, what the task has cost so far. Resume with the `Last-Event-ID`
header (what a browser sends on reconnect) or `?after=`; the header wins.

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
| Cancel, pause and resume | invite, token bucket | 30 per minute |
| Artifact downloads | invite, token bucket | 60 per minute |
| Artifact reads at once | server | 8 |

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
