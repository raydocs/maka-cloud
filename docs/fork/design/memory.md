# T11: invite-scoped memory

`packages/cloud-memory` owns profile facts, result excerpts and retrieval. It has
no model client, extraction job, API key or external service dependency. Users
explicitly save facts; old chat messages and task summaries never create facts.

## Storage and ownership

`MemoryStore` uses the server's exclusively owned SQLite connection and creates
three namespaced tables, leaving the server's migration version untouched. The
server owns opening, locking and closing that connection. Every query, update,
delete and delivery idempotency key is scoped by invite ID. HTTP routes derive
that ID from the authenticated bearer token, never from a request body. Foreign
and unknown fact IDs both return 404. Writes recheck invite activity after
reading the body, immediately before applying changes.

The server passes the host two conversation-bound operations: retrieve context
and remember a delivered reply. Both resolve the conversation's actual owner
and refuse unknown, unowned or revoked conversations. No invite token is saved
in memory tables or sent to the model.

## Context and summaries

The conductor has one optional synchronous `turnContext(conversationId)` hook.
The host binds it to memory retrieval. Immediately before a new user turn is
sent, it appends a snapshot after the existing timestamp/budget line and user
text. Facts are in creation order, followed by the five newest eligible task
summaries. An empty profile still emits a snapshot, so deletion is explicit.
The snapshot is persisted as part of that new user turn. It is **not** a Maka
request-only context, system-prompt edit or mutation of any previous message.
Subsequent tool steps replay the same snapshot, not a newly retrieved one.

The host records up to 600 characters of each delivered conductor result,
idempotently by its outbox event ID. These are result excerpts, not semantic
summaries or independent verification of success. Retrieval is a bounded
profile (50 facts of at most 500 characters, plus five excerpts), not vector or
model-ranked search. New results appear when the Memory panel is reopened.

## Edits and deletion

Changes apply on the next turn that starts after the write, including another
conversation owned by the same invite. Running work keeps its existing snapshot.
An edited or deleted value is normalized (Unicode NFKC, lowercase, collapsed
whitespace) into a private suppression record. It cannot be saved again, and
future result excerpts containing it are excluded. Edit/delete clears older
summaries conservatively, since an excerpt may contain only half of a fact.
Equivalent duplicate active facts are removed with the retired value.

This is **not erasure of chat history**: earlier turns must remain byte-identical
to preserve thinking and caches (T3). The latest snapshot tells the conductor
not to restore absent facts from older snapshots. The suppression ledger retains
the normalized old value in SQLite; it is never returned through the API or new
context. Paraphrases are not recognized, and no fake-only test can guarantee a
live model will never repeat information still present in old chat history.
There is no background extraction or inference to resurrect facts.

## API and web

All routes require an active invite:

| Route | Result |
| --- | --- |
| `GET /v1/memory` | `{facts, summaries}` for the caller only |
| `POST /v1/memory/facts` `{text}` | Save a fact (identical additions deduplicate) |
| `GET /v1/memory/facts/:id` | Read one own fact |
| `PATCH /v1/memory/facts/:id` `{text}` | Replace one own fact |
| `DELETE /v1/memory/facts/:id` | Forget one own fact |

The web app's collapsible Memory section is available before a conversation
exists and offers add, inline edit, cancel, delete, and recent result excerpts.
It uses the existing presentation filter and clears with the invite session.
It states next-turn semantics and suppression/history limitations.

## Checks

- `npm run typecheck -w @maka-cloud/memory`
- `npm run test:dist -w @maka-cloud/memory` (after build)
- `node --test --test-concurrency=1 packages/cloud-host/dist/__tests__/e2e.test.js packages/cloud-conductor/dist/__tests__/history.test.js`
- `npm --prefix packages/cloud-web run check`
- `node --test --test-concurrency=1 scripts/ci-test-plan.test.mjs scripts/ci-workflow-policy.test.mjs`

All model, runner and sandbox activity in the tests is fake. The host regression
checks actual fake Anthropic request bodies across edits, deletion and restart:
strict history prefixes, stable system/tools, preserved signed/redacted thinking,
and cross-invite API and context isolation. No live model or paid check is needed.
