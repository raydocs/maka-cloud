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
server's restarts to the runtime's. So this package only exposes a port for the
conductor (T5):

```ts
interface ConversationHandler {
  onUserMessage(message: { conversationId; messageId; text }, conductor: ConductorAccess): void | Promise<void>;
  onAnswer?(answer: { conversationId; questionId; optionId; text? }, conductor: ConductorAccess): Promise<AnswerOutcome>;
  close?(): void | Promise<void>;
}
```

The conductor turned out not to be a runtime-host client: runtime-host adds a
per-turn runtime context and reactive compaction, and T3 requires neither (the
history must stay append-only). T5 runs Maka in-process (SessionManager and the
AI SDK backend) inside the handler instead, and still has no import edge into
this package.

`ConductorAccess` gives T5 the orchestrator MCP URL and a conductor token for
that conversation (rotated on request, never sent over the public API). With no
handler the server stores the message and nothing replies. `createHandler`
builds the handler after the database opens and hands it a
`ConversationPublisher`. Through it, the conductor posts assistant messages
(`message.posted`, role `assistant`), notices (`conductor.notice`), questions
(`conductor.question`) and answers (`conductor.answered`) into the feed, each
idempotent by the event's stable id. `POST /v1/conversations/:id/answers`
(`{questionId, optionId, text?}`) exists only when the handler has `onAnswer`,
and maps its outcome to 200 `{accepted, duplicate}`, 404, 409 or 400. On
shutdown `close()` runs while the orchestrator endpoint is still up, so the
conductor can cancel its tasks.

## Storage

One SQLite file (`node:sqlite`), opened by exactly one process.

| Table | Contents |
|---|---|
| `task_log(seq, at, task_id, event)` | The orchestrator's `TaskStore`. `seq` is assigned `max + 1` inside the append transaction, so it is exactly 1, 2, 3, ... |
| `task_index(n, task_id, session_id, root_session_id, parent_task_id, state, created_at)` | Projection of the log for the store's index lookups. Rebuildable from `task_log` (`rebuildTaskIndex`). |
| `conversations`, `messages` | Append-only. `messages` has a unique `(conversation_id, client_message_id)` so a retried POST stores once. A conversation owns one orchestrator session id. |
| `feed(id, kind, conversation_id, ref, at)` | The order of everything a client can stream. A conversation row, a message or a `task_log` row is inserted together with its `feed` row in one transaction. |
| `sessions(session_id, token_sha256, parent_task_id, created_at)` | The orchestrator's `SessionStore`. Digests only. |
| `push_subscriptions(endpoint, invite_id, p256dh, auth, since_feed_id, created_at)`, `push_deliveries(endpoint, task_id, state, at)` | Web Push. Mutable, unlike the log tables. `since_feed_id` is the feed position when the device subscribed. Schema step 7. |

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

Each invite is a principal and sees only what it owns. A conversation stores the
invite that created it (`conversations.owner`, schema v5); its tasks, artifacts,
inbox items and feed rows belong to that owner. Every list, read and stream is
filtered by owner, and every write is checked against it. Another owner's object
answers 404 exactly like a missing one, never 403. Writes check the invite again
after the body is read and right before their effect; control operations check
invite and owner once more inside the orchestrator's write chain; an approved
irreversible call checks its approver once more right before it runs (the
conductor's `approverAuthorized`, fed by `createHandler`'s `authorized`). Feed
rows of no conversation (the supervisor's digest) belong to nobody and are not
streamed. Conversations from before v5 have no owner and are invisible until
`cloud-server conversation adopt --db <file> --invites <file> <inviteId>`, run
with the server stopped, gives them to an invite. Accounts replace invites in T17.

| Route | Behavior |
|---|---|
| `POST /v1/conversations` | `{title?}` -> `{conversationId}`. Creates the conversation and its orchestrator session. |
| `GET /v1/conversations` | The caller's conversations, oldest first. |
| `POST /v1/conversations/:id/messages` | `{text, clientMessageId?}` -> 202 `{messageId}`. Stores the message with a pending delivery, emits, then hands it to the handler. A repeated `clientMessageId` returns the first message's id, emits nothing, and retries a delivery still pending. |
| `GET /v1/conversations/:id/tasks?after=&limit=` | Task views for the conversation's trees, in creation order, paged. |
| `POST /v1/tasks/:taskId/{cancel,pause,resume}` | Acts on a task as its conversation, after checking the invite. 200 `{task}` (the public view). 404 unknown task; 409 `invalid_state` (finished, not paused, pause still under way) or `pause_unsupported`; 429 over the control limit. Cancel of a finished task is a 200 no-op. Pause and resume wait for the runner's answer (15 s at most). |
| `POST /v1/tasks/:taskId/messages` | The owner's message to the agent working on the task: body `{text, messageId?}` (text 1 to 4,000 characters; the key makes a resend apply once). 200 `{message: {messageId, state}}` with `state` `pending`, `delivered` (the agent has read it), `withdrawn` or `unseen`. 400 bad body; 404 unknown task; 409 `steer_unsupported` (the task's runner takes none), `invalid_state` (task ended); 429 over the control limit or 20 unread messages. The agent reads it after the step it is in, not at once (design: durable tasks, section 6). |
| `DELETE /v1/tasks/:taskId/messages/:messageId` | Takes a message back before the agent reads it. 200 `{message}`; 404 unknown; 409 `invalid_state` once it was read. |
| `GET /v1/tasks/:taskId/artifacts` | `{artifacts: [{index, name, kind, url?}], total}` from the task's manifest (first 500). `kind` is `file` or `link`; `image: true` marks a file named like a picture (png, jpg, jpeg, webp, gif; never svg). |
| `GET /v1/tasks/:taskId/artifacts/:index` | A file's bytes as an attachment, or `{url}` for a link. 404 for anything that is not readable (one answer for every reason), 413 over 2 MiB, 429 over the download limit. |
| `GET /v1/tasks/:taskId/sources` | `{sources: [{index, url, site, label}], total}`: the pages the task opened (first 20), from the server's own log. Nothing is fetched to answer. `label` is one of `source`, `docs`, `alternative`, `pull_request`, `preview`, `test_report`. |
| `GET /v1/tasks/:taskId/sources/:index/preview` | `{site, title?, image}` for one page of that list, fetched by the server. `image` says whether the next route has bytes. 404 for an index not in the list; 429 over the preview limit (60 a minute per invite) or when the server is already fetching as much as it allows (`retry-after: 2`). |
| `GET /v1/tasks/:taskId/sources/:index/image` | The page's own preview image (png, jpeg, webp or gif by its first bytes, at most 1 MiB), with `nosniff`, a sandboxing CSP and `private, no-store`. 404 when the page has none. |
| `GET /v1/push/key` | `{publicKey}`, the VAPID public key. 404 when push is not configured (so are the next two). |
| `POST /v1/push/subscriptions` | `{endpoint, keys: {p256dh, auth}}` from `PushSubscription.toJSON()` -> 201, or 200 when the endpoint was already registered. 400 `invalid_endpoint` / `invalid_keys`; 429 `too_many_subscriptions` (10 per invite, 1000 in all). |
| `DELETE /v1/push/subscriptions` | `{endpoint}` -> 204. Only the invite that registered it can remove it; otherwise 404. |
| `GET /v1/home` | The caller's Home as the server keeps it: `{cards: [{cardId, kind, ref, rank, seenAt, at, state?, text?}]}` (see "Home cards"). |
| `POST /v1/home/seen` | `{cardIds}` (at most 100): the person saw these cards and left Home. Records the ones that are on this Home and moves the caller's visit to now. 200 `{seen, visitedAt}`. |
| `POST /v1/home/order` | `{cardId, after}`: moves a card to just after `after` (first when null) inside its kind. 200 `{cards}`; 404 a card that is not on this Home; 400 `after` in another kind, itself, or not there. |
| `GET /v1/settings` | `{language}`: what the server writes to the caller's invite in, `zh-Hans` (the default) or `en` (see "Language"). |
| `PATCH /v1/settings` | `{language}` -> 200 `{language}`. 400 for any other value or field; 429 over the control limit. |
| `GET /v1/events?conversation=&after=` | Server-sent events. `id:` is the feed id. |

Unknown or malformed ids are 404. Bodies over 64 KiB are 413; message text is
capped at 32,000 bytes.

### Home cards

`home.ts`. Home is a list of cards the server builds for one invite from that invite's own conversations, projects and
rows, and keeps the order and what was seen (schema v12: `home_visits`, `home_seen`, `home_order`, `home_notes`).
A card is `kind:what it points at` (`waiting:<inbox item>`, `finished:<task>`, `scheduled:<duty>`), so the same thing is
always the same card. `ref` says where to read it (an inbox item, a task of a conversation, a duty of a project, a note);
clients resolve it as they already do, and `HomeFeed` keeps building Home from its own parts on a server without
`/v1/home`.

- **Order.** Waiting (open inbox items that are not suggestions; one that interrupts first, then the longest-waiting),
  suggestions (newest first), finished (top-level tasks that ended after the caller last left Home, or in the last day on a
  first visit; newest first, at most 8), notes (newest first, at most 5, for a week), scheduled (duties on a schedule
  that are on, soonest first, at most 5). Ties break on the card id, so the list is a function of its input.
- **Seen.** `POST /v1/home/seen` records the cards shown and moves the caller's visit; what finished before the visit is not
  new any more, on every device. A tab that goes to the background sends it too, so what it showed is gone from Home
  for good: clients should send it when the person leaves, not on every hide they cannot tell from leaving. Per invite: another invite's cards, seen times and order are never read or written. Only a card on
  the caller's Home is recorded, and the rows are capped (1,000 seen for 30 days, 500 ordered).
- **Moving.** A card moves inside its kind, never across (waiting always leads). The moved cards keep the owner's order;
  a card that arrives later comes before them in the kind's own order.
- **Notes.** The one card the employee writes. `CloudServer.addHomeNote(owner, note)` takes a template (`pull_request_merged`,
  `checks_failed`) with typed parameters (a repository name from a fixed alphabet, a number, one of a few words) and
  stores exactly that; the words are the server's and are made when the card is read. Free text, extra keys and anything
  that does not fit the alphabet are refused, so nothing a model or another person wrote can reach a note. Nothing
  calls it yet: the duties engine can once it reports a merge.

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

A file named like a picture is sent as `image/png`, `image/jpeg`, `image/webp` or `image/gif`
only when its own first bytes say the same type (this is what a delivery card shows as its visual
proof, a screenshot taken in the box). A name that claims a picture over other bytes, and picture
bytes under another name, are sent as text like any other file. Otherwise bytes are sent as
`text/plain` (`application/json` for `.json`) with
`X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` and a
sandboxing CSP, so a browser never renders them. At most 8 reads run at once
(429 beyond), and each invite gets 60 downloads a minute.

### Sources and the preview proxy (T24)

The browser never contacts a site a task read. `CloudServer.recordOpenedPages(taskId, pages)`
is how trusted in-process code (a tool result in the transcript, a pull request the employee
opened) puts a page on a task's list; only plain public https URLs are kept, once each, at most
20 a task, with one of a fixed set of labels. That list (`opened_pages`, schema v9) is the only
thing the proxy fetches: not a link in a manifest, not a URL in model text, not a markdown image,
and the path carries an index into the list, never a URL. Nothing records pages yet; T28's
transcript mirror will, so until then the list is empty.

The fetch goes through `createSafeFetch` (`safe-fetch.ts`, `public-address.ts`): https on port 443
only, every address a name resolves to must be public, the socket connects to the address that was
checked, redirects are followed by hand (3 at most) and re-checked each hop, one deadline and a byte
cap cover the whole request, and nothing of ours is sent. The page is read to 512 KiB (its start
only), its title and `og:image` are read with bounded patterns, the title is cut to one printable
line without vendor names, and the image address goes through the same fetcher (1 MiB). An image
is kept only if its first bytes say png, jpeg, webp or gif and agree with the type the site
declared (never SVG). Results are cached for an hour (failures for 5 minutes) in a cache bounded by
256 entries and 24 MiB of image bytes; one fetch per page at a time; at most 4 page fetches run at
once. Images are not checked for pixel dimensions.

### Web Push

Off unless `CloudServerOptions.push` is set; `pushConfigFromEnv()` builds it from
`CLOUD_PUSH_VAPID_PUBLIC`, `CLOUD_PUSH_VAPID_PRIVATE`, `CLOUD_PUSH_SUBJECT` and
optionally `CLOUD_PUSH_ALLOWED_HOSTS`. In the host stack, `readStackConfig` checks
them at start (a partial set is a configuration error) and `startStack` passes the
result on. The private key lives in memory only: it is
not logged, not stored, and bad settings fail startup with a message that does
not contain them. Encryption (RFC 8291) and VAPID signing (RFC 8292) are the
`web-push` package's; the server only builds the request with it and sends it
itself.

When a top-level task (no parent) ends, every device registered by the invite
that owns its conversation gets one message, while that invite is active:
`{type: "task.finished", conversationId, taskId, state, lang, title, body}`. A
conversation another invite owns, or one nobody owns yet (before `conversation
adopt`), reaches no device. Nothing a task or a model wrote goes in it, and there
is no model name or vendor name: `title` and `body` are fixed words from the
server's catalogue in the invite's language (`lang`), and a client may show its
own words for `type` instead. A spend alert is `{type: "spend.alert", lang, title, body}`.

What is left to send is computed from the database: a terminal event of a
top-level task that came after the subscription (`since_feed_id`) and has no
`push_deliveries` row. A restart therefore sends what it missed and never sends
twice. A `404`/`410` deletes the subscription; `429`, `5xx`, a timeout and a network
error are retried (3 attempts, 5 s times the attempt number apart); other `4xx`
and an exhausted retry record the message as `dropped`. A revoke made through this
server's invite store deletes the invite's devices and aborts sends to them that are
under way; one made from the command line is seen at the next send, which records
`revoked` instead of sending.

The server fetches a URL a client chose, so: the endpoint must be `https`, on port
443, without credentials, on a host in the allow-list (FCM, Mozilla autopush,
Apple, Windows by default); no redirect is followed; the address is checked when
the socket connects (non-public addresses are refused, and so are IP literals); a
send ends after 10 s or when the server closes; and the response is read to 4 KiB.

### Language

`i18n.ts`. Each invite has a language, `zh-Hans` or `en`, in the invites file
(`invites.language`, null until set, which reads as `zh-Hans`). An account made
by `/v1/auth/claim`, or by linking the first identity, gets `en` when the first
entry of the request's `Accept-Language` is English and `zh-Hans` otherwise; a
language already set is kept. `/v1/settings` reads and changes it.

What the server says in it, from one typed catalogue with an English fallback:
the sign-in mail (the account's language when the address has one, else the
request's), the words of a push, Home note cards, the asks the supervisor's rules
build (each carries `askTemplate`, its fixed sentence and parts, which the server
says in the reader's language and never sends on), and the "Needs you" notice. An
approval's card, the conductor's own words and every option label and id stay as
they are; the apps translate known option ids.

The conversational agent gets one paragraph at the end of its system prompt for a
`zh-Hans` reader (`languageInstruction`): reply in Simplified Chinese unless the
person writes in another language, keep code, commands, file names and quoted
text as they are, and keep delegated briefs, commit messages, pull request titles
and code in English. It is read when a conversation's conductor session is made
and kept with it, so a conversation's prompt never changes and its history is
never edited; a language changed later applies to new conversations.

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
from its last id. A comment line goes out every 15 s, through the same drain
wait, so a stalled idle client is dropped too.

A stream belongs to its invite. Before each frame and each heartbeat the invite
is read again; a revoke through the server's own store ends its streams at once,
and one from the command line (another process) is seen within
`revokeCheckMs` (1 s) through SQLite's `data_version`, so no frame goes out
after the revoke is visible.

### Message delivery

The message and a `message_deliveries` row are committed in one transaction.
The row is marked delivered only when the handler's promise resolves; a failure
is retried with a doubling delay (1 s up to 60 s), and whatever is pending at
start is tried again, so a crash between the commit and the handler loses
nothing. One attempt per message runs at a time and the handler dedupes by
`messageId` (the conductor admits a message id once). Messages from before v5
have no row and are not replayed.

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
