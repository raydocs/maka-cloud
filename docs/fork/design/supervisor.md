# Supervisor and "needs you" inbox (`@maka-cloud/supervisor`)

Task T20. Written before the code, against the T4 server as built in PR B (#21)
and the T5 conductor plan. Status: proposal. Where T5 is not merged yet, the
contract this package needs from it is listed under "What T20 needs from T5" and
is checked again when T5 lands.

A person running dozens of agent sessions cannot watch them all, and an agent's
own report of success is not proof. The supervisor watches every conversation,
checks finished work with a model other than the one that did it, and asks the
human only under explicit rules. Everything else goes into a digest.

## Principles

1. **Rules decide, models describe.** Whether something interrupts the human is
   decided by deterministic code from events. A model (Claude Haiku 5.5) only
   writes the digest summary and orders items. Its output is validated and can
   never remove an item or change an interrupt decision.
2. **Noise limits change when we tell the human, never whether an item exists.**
   The hourly cap, quiet hours and mutes hold back the push, not the inbox row,
   and never answer or unblock anything on the human's behalf.
3. **The supervisor adds no authority.** It holds no orchestrator token. It has
   exactly two ways to write into a conversation: answer a question the
   conductor asked, and post a user message the human chose to send from the
   inbox. Cancelling or retrying is still the conductor's call. No auth, token or
   sandbox-isolation model changes.
4. **Absence of proof is not proof.** A finished task is shown as finished only
   after its claims were checked. Unverifiable is not a pass.
5. **Answers act once, on the state the human saw.** One answer per item,
   delivered exactly once, and only if the state the item was based on still
   holds (same rule as T16).

## Where it runs

Beside the conductor, in the server process. `locking_mode=EXCLUSIVE` means no
other process can open the T4 database, so the supervisor cannot read the feed
from outside, and polling our own public SSE would spend an invite and a stream
slot for data that sits in memory. The server hands it a host (below). The
package depends on no `@maka/*` package and does not import `@maka-cloud/server`
(it declares the ports it needs structurally, like the conductor), so an
upstream sync or a server refactor cannot break its build. It imports types from
`@maka-cloud/orchestrator` (`TaskEvent`, `ResultManifest`).

```ts
// Provided by cloud-server; structurally typed in the supervisor package.
interface SupervisorHost {
  feed: {
    read(after: number, limit: number): FeedEntry[];   // readFeed(db, after, limit), all conversations
    subscribe(listener: () => void): () => void;       // FeedHub.subscribe
  };
  publish(entry: { kind: 'inbox.item' | 'inbox.digest'; conversationId: string | null; data: unknown }): void;
  notifier: { interrupt(i: Interrupt): void | Promise<void> };   // conversation notice now, web push later
  answers: { deliver(a: QuestionDelivery, signal: AbortSignal): Promise<QuestionOutcome> };   // T5's answers route
  budget: {                                            // PR 2, over T5's Conductor.reserveSpend / settleSpend
    reserve(r: { key: string; conversationId: string; taskId: string; maxUsd: number }): { ok: true } | { ok: false };
    settle(key: string, actualUsd: number): void;      // releases the unused part
  };
  messages: { post(conversationId: string, text: string, clientMessageId: string): Promise<{ messageId: string }> };
  onWarning(message: string, detail?: unknown): void;
}
```

`startCloudServer` gains one option,
`supervisor?: (host: SupervisorHost) => Promise<SupervisorService>`, started after
`Orchestrator.create` (so orphan failures are already in the feed) and before the
public API listens, and stopped before the database closes, so no loop outlives
the lock. Without the option nothing changes for T4 or T5.

`SupervisorService` is what the routes call: `listItems`, `answer`, `setMute`,
`getSettings`/`setSettings`, `digest`, `stop`.

## What it reads

The T4 feed, all conversations, by position: `task.event` (a `TaskEvent` plus
`seq`), `message.posted`, `conversation.created`, plus the conductor events T5
adds. It keeps a cursor and processes entries in order. It ignores its own
`inbox.*` entries.

### What T20 needs from T5

The T5 plan names `conductor.question` and `conductor.notice` feed events and
`POST /v1/conversations/:id/answers {questionId, optionId}`. T20 needs these
properties, checked against the merged code before any T20 package code:

| Need | Why |
|---|---|
| `conductor.question {questionId, reason (taste \| budget_overrun \| irreversible), question, options[{id,label}], recommended, actionRef?}` | The three conductor-raised interrupt rules read `reason` as given by code. T20 never infers a reason from text. |
| `conductor.answered {questionId, by}` when any route answers | Closes the inbox item when the human answered inline in the web app. Without it T20 would parse the "Answer to q_…" user message, which is brittle. |
| The answers route is idempotent per `questionId` | Re-delivery of the same answer returns success with `applied:false`; a different answer to a closed question returns 409 `already_answered` with the stored one. T5 already checks "open question" in its write chain; this makes retries safe. |
| Free text with an option on the answers route | **As merged:** the text accompanies a chosen option; there is no text-only answer. Option-only (no text) for `irreversible` and `budget_overrun`. |
| A way for T20 to put a notice into a conversation | `host.notice`, wired to the same outbox as `notify`. |
| A ledger entry other than model spend and child reservations: `reserve(key, conversationId, taskId, maxUsd)` and `settle(key, actualUsd)` | Verification spend counts against the budget of the run that delegated the task (win, 2026-10-19). The reservation is one synchronous check-and-reserve in T5's ledger, idempotent by `key`, and still allowed after that run's turn has ended (a task can finish after its turn). Refused when the run's remaining budget is below `maxUsd`. |

The adapter that maps T5's feed payloads to the supervisor's internal events is
one file (`conductor-events.ts`). A mismatch is fixed there, nowhere else.

## State

The supervisor owns one SQLite file (`supervisor.db`, `node:sqlite`, WAL, opened
with the same one-process lock as T4), next to the conductor's file. It does not
touch the T4 schema. The supervisor's tables:

| Table | Contents |
|---|---|
| `cursor` | Last feed id processed. |
| `tasks` | Projection of task events: id, conversation, parent, runner, title, state, `last_activity_at`, failure key. Rebuildable from the feed. |
| `questions` | Conductor questions by id and whether they are open. |
| `items` | The inbox. Kind, conversation, task, dedupe key, ask, options (recommended first), evidence, route, precondition hash, state (`open`, `answering`, `closed`) and close reason, `version`. |
| `item_events` | Append-only audit (created, refreshed, notified, answered, delivered, closed); triggers reject UPDATE and DELETE, as in T4. |
| `answers` | One row per item (`UNIQUE(item_id)`): answer id, choice or text, delivery state, attempts. |
| `verifications` | One row per task (`UNIQUE(task_id)`): state, attempts, structured result, internal audit of which model checked (never sent to clients). |
| `verifier_spend` | Append-only ledger of verification spend, keyed by `verification id + attempt`: `reserve` (upper bound), `settle` (actual), `release`. The daily cap is the sum of a day's `reserve`/`settle` rows. Digest model calls are recorded here as kind `digest` for visibility; only verification is capped. |
| `deliveries` | Each push, digest and held-back notice with time, for the hourly cap. |
| `settings` | Mutes, quiet hours, cap, digest schedule, thresholds. |
| `feed_outbox` | `(item_id, version)` pairs not yet published to the T4 feed. |

### Exactly-once derivation

Processing one feed entry is one synchronous transaction: update the projection,
evaluate the rules, upsert items, enqueue effects (push, verification), advance
the cursor. A crash re-reads from the cursor and repeats nothing, because the
effects and the cursor commit together. There is no `await` between a check and
its write anywhere on these paths; anything slow (models, evidence, delivery)
runs outside, from rows that were claimed first.

## Attention items

| Kind | Raised by | Interrupts | Route of an answer |
|---|---|---|---|
| `decision` | Conductor `ask_user` with `reason: taste`. Also a task finished with `confidence: low`. | yes | question (conductor); message (low confidence) |
| `approval` | Conductor `ask_user` with `reason: irreversible` (an irreversible action is held). | yes | question, option only |
| `budget` | Conductor `ask_user` with `reason: budget_overrun` (T5 raises it when a step would exceed its budget). | yes | question, option only |
| `blocked` | The same step failed twice, or a task made no progress for the configured time. | yes | message |
| `verification_failed` | Independent verification found a mismatch, or could not check. | yes | message, or accept locally |
| `finished` | A top-level task ended, verification passed. | never | acknowledge locally |

Each item stores a one-line ask, 2 to 4 options with the recommended one first,
and evidence links (manifest, test output, PR, citations) as references into
data the server already holds or a URL; it never embeds large content.

Asks for conductor questions are the conductor's own `question` text. Asks for
rule-raised items come from fixed templates filled with ids and counts. Task
titles and manifest text come from agents, so they are shown as quoted data:
length-capped, control characters stripped, never interpreted. No field a client
receives names a model or vendor (T9 rule); the verifier's identity is in the
internal audit column only.

## Escalation rules

Pure functions over the projection, in `rules.ts`, with a table-driven test per
rule. Anything not matched here is not an interrupt.

| # | Rule | Condition | Notes |
|---|---|---|---|
| R1 | Conductor asked | `conductor.question` | Kind from `reason` (decision, approval, budget). Covers the spec's "ask_user", "step would exceed its budget" and "irreversible action waiting": T5 already turns the last two into questions with a code-set reason. |
| R2 | Same step failed twice | Second `task_failed` with the same step key | Step key = (conversation, parent task or root, runner, title). With no title the key also needs the same normalized failure reason (digits and ids removed), so two unrelated untitled tasks do not pair. Reasons `orphaned` (a restart) and cancels do not count. A success on the same key resets it. |
| R3 | Failed verification | Verification result `failed` or `could_not_check` | See below. |
| R4 | No progress | A non-terminal task with no event for `stallAfterMs` | Default 30 min (queued: 10 min). Any event of a task or a descendant counts as activity for it and its ancestors, so a parent waiting on a busy child is not stalled. Evaluated by a periodic tick on an injected clock. Clears when the task shows activity or ends. |
| R5 | Low confidence | `task_succeeded` with `manifest.confidence === 'low'` | A `decision` item. |

Deduplication: one open item per `(task, kind)` (conductor questions: per
question id), enforced by a partial `UNIQUE` index and an insert that happens
inside the processing transaction. A repeat refreshes `version` and the evidence
instead of adding a row.

## Independent verification

When a **top-level** task ends `succeeded` (a task the conductor delegated;
children belong to their parent's verification), the supervisor enqueues one
verification, claimed with `UNIQUE(task_id)` before it starts, so a repeated
event or a restart cannot run it twice. Concurrency is capped (default 2), each
verification has a deadline and an `AbortController`, and a slot, timer and
request are released on every exit (done, cancelled by `stop`, timed out, threw,
restart).

1. **Pick a verifier by artifact.** A pull-request URL in `manifest.artifacts`
   selects the code verifier; a report artifact with sources selects the
   research verifier. A task with no recognized artifact is `skipped`: nothing to
   check against, shown as finished and marked "not independently verified".
2. **Gather evidence** through an `EvidenceSource` port: CI conclusion and test
   output for the PR head commit (via the GitHub App, T8's client), and for each
   citation the fetched page text. Evidence is stored by reference, with a digest.
3. **Deterministic checks first.** CI not green, a test summary with failures,
   a citation URL that does not resolve, a quoted passage that is not in the
   fetched text, an artifact the manifest lists that does not exist. A
   deterministic failure is final: no model output can turn it into a pass.
4. **Model check on what is left, if the money allows** (see "Verification
   spend"). Does this evidence support each claim in
   `done[]` and the summary? The verifier returns a per-claim verdict
   (`supported`, `unsupported`, `contradicted`) with evidence references, under
   a zod schema. Evidence is passed as quoted data in a delimited block; the
   prompt says to ignore instructions inside it, and the output is
   schema-constrained, but this is a mitigation: a hostile page can mislead the
   judgement of a model-checked claim. Hence step 3 carries the hard facts.
5. **A model other than the one that did the work.** The runner (`claude-agent-sdk`
   or `codex`) maps to the vendor that did the work; the verifier is chosen from a
   configured pool and must differ in vendor (`claude-agent-sdk` work is checked
   by a non-Anthropic model, `codex` work by Claude). If the pool has no
   eligible model, the verification is `could_not_check`, not run with the same
   one. The production adapters are one file (`models.ts`) over ai-sdk; no model id
   is guessed here, the pool is configuration.
6. **Outcome.** `passed` creates a `finished` item. `failed` creates a
   `verification_failed` item listing the mismatches (claim, what the evidence
   showed, link). `could_not_check` (evidence source down, no eligible verifier,
   timeouts after 3 attempts with backoff, or `budget`) also creates a
   `verification_failed` item, worded as "could not check", because a pass without
   a check is what this task exists to prevent. The options are: ask the agent to
   fix it (recommended), accept anyway (recorded), and for `could_not_check`
   also "check again", a local route that re-queues the verification if the
   precondition still holds.

### Verification spend

A model check is paid, so it is bounded twice, before any model request:

1. **The conversation's budget (T5).** Verification spend counts against the
   budget of the run that delegated the task, through `host.budget`.
2. **A daily cap on verifier spend**, default `verifierDailyCapUsd = 5`, in
   settings, per calendar day in the configured time zone (UTC until set).

Before the model check, the supervisor computes an upper bound for the attempt
from the configured price table, the evidence size cap and the output token cap,
and reserves it: first against the daily cap in `verifier_spend` (one
synchronous transaction), then in T5's ledger. If T5 refuses, the daily
reservation is released by a compensating row. If either refuses, no model is
called and the verification ends `could_not_check` with reason `budget` (the
audit records which of the two), and the item says the check was not run because
the budget is used up. It is never skipped silently and never treated as a pass.
After the calls the actual cost from the reported token usage settles both
ledgers down to what was used. Keys are `verification id + attempt`, so a
restart that repeats a reservation does not charge twice, and a reservation left
by a crash is settled or released when the verification is next claimed.

Only the model check is gated. Deterministic checks cost nothing and always run,
so a CI failure or a missing citation quote is reported as `failed` even when the
budget is gone. A task with nothing to check is `skipped` and spends nothing.
Retries reserve again, each attempt against both limits.

### Evidence fetching is outbound egress

Citation URLs are chosen by an agent that read untrusted pages. Fetching them
from the server is an SSRF risk, so the fetcher is its own module with its own
tests: `https` only, no credentials or cookies, DNS resolved once and the
connection pinned to that address, loopback, private, link-local and metadata
ranges refused on the first request and on every redirect (max 3), a time and
size cap, and a content-type allowlist. Quote matching works on the extracted
text. Reviewed with the rest of the PR; the coordinator is told that T20 adds
this egress.

Model calls are stateless one-shot requests (no multi-turn Claude history is
kept, so the append-only rule has nothing to break), API key only, never the
subscription provider.

## Delivery and noise limits

Items exist from the moment a rule fires. Delivery decides how loudly.

- **Interrupt:** a push through the `Notifier` port. v1 channels are the
  conversation notice (`host.notice`, the conductor's `notify` path) and the
  `inbox.item` SSE event. Web push is a second `Notifier` once T9 has it.
- **Digest:** open items, plus what closed or finished since the last digest,
  ranked and summarized by Haiku 5.5. A schedule (default daily 08:00 in the
  user's time zone, default UTC until set) and on request. The due digest slot is
  claimed in one transaction, so a restart or two ticks send one.
- **Limits**, each with a test: one open item per task and kind; at most
  `maxInterruptsPerHour` pushes (default 6, sliding window from `deliveries`; the
  check and the recording of the push are one transaction, so parallel items at
  the boundary cannot exceed it); quiet hours (local window, default off); a
  per-kind mute. An interrupt held back by a limit appears in the inbox as usual
  and in the next digest, and when the window opens a single batched "N items
  need you" push goes out. Mute never answers anything: a muted `budget` item
  still blocks its conversation and is still listed.
- A push is at-most-once per item (claimed before sending). A lost push is
  covered by the inbox and the digest, which list every open item.

### Summarizer and ranker

Input: item ids, kind, ask, age. Output: an ordered list of ids and a short
summary text. The code accepts the order only after validating it: ids the model
invented are dropped, missing ones are appended in the deterministic order
(priority, then age), duplicates are dropped. Any failure (timeout, bad JSON,
refusal) falls back to the deterministic order and a template summary. The model
never receives interrupt flags and cannot change them.

## Answers

`POST /v1/inbox/items/:id/answer` with `{answerId, optionId, text?, preconditionHash}`.

1. **Claim, in one synchronous transaction:** the item is `open`, the hash
   matches, no answer exists. Insert the answer, set the item `answering`. A repeat
   with the same `answerId` returns the stored outcome; a different `answerId`
   on an answered item is 409 `already_answered` with the stored answer.
2. **Catch up first.** Before the check, the supervisor processes the feed to its
   current head, so the hash is compared against the present state, not the
   last tick.
3. **Stale?** The hash differs: nothing is delivered. The item is recomputed
   (new ask, options, hash, `version`), or closed `condition_cleared` if what it
   was about is gone, and the response is 409 `stale` carrying the refreshed
   item. The human answers again on what is true now.
4. **Deliver outside the transaction**, by route, with an idempotency key that
   is the answer id: a `question` route calls the answers route (the question id
   is the key; T5 makes it idempotent); a `message` route posts a user message
   with `clientMessageId = answerId`, which T4 already makes idempotent. The
   message is built by code: a fixed template, the task id and a capped, quoted
   title, and the human's text after a delimiter. A `local` route (accept,
   acknowledge, keep waiting) records the decision and sends nothing.
5. **Retry with backoff** while the item is `answering`; on success close it
   (`answered`). 409 `already_answered` from the conductor with a different
   choice closes it `handled_elsewhere` and shows what was chosen. The same
   choice counts as delivered. A crash between delivery and the close repeats the
   delivery, which the key makes a no-op.

Precondition hash = sha256 of a canonical JSON of the state the item depends on:

| Kind | State hashed |
|---|---|
| question kinds | question id, question still open, the conversation's current open question id |
| `blocked` (stalled) | task id, state, `last_activity_at` |
| `blocked` (failed twice) | step key, the failed task ids |
| `verification_failed`, low confidence | task id, manifest digest, evidence digests |
| `finished` | task id |

The hash is a guard on the supervisor side. The conductor's own open-question
check (T5, inside its write chain) is the final arbiter for question answers.
`approval` and `budget` accept an explicit option id only, never free text.

## HTTP and events (on the T4 server, same invite auth)

| Route | Behavior |
|---|---|
| `GET /v1/inbox/items?state=open&after=&limit=` | Items, with version and precondition hash. |
| `POST /v1/inbox/items/:id/answer` | As above. 202 on claim, 409 `stale` / `already_answered`. |
| `PUT /v1/inbox/mutes/:kind`, `DELETE …` | Mute and unmute a kind. |
| `GET` / `PUT /v1/inbox/settings` | Quiet hours, hourly cap, stall time, digest schedule, daily verifier cap. |
| `POST /v1/inbox/digest` | Build and return a digest now. |
| SSE `inbox.item` on `GET /v1/events` | Item snapshot with `version`. Clients list on connect, then apply events by `(id, version)`. |

The item rows live in `supervisor.db`, the stream lives in the T4 feed. They are
joined by `feed_outbox`: every item version is recorded with the item, and a
publisher loop appends it to the feed through `host.publish` and marks it
published. A crash between the two republishes on start; clients ignore a version
they have. T4 gains a generic extension feed kind (or reuses the one T5 adds for
`conductor.*`), so nothing about the supervisor is baked into the feed schema.
The `cloud-web` inbox view is built if T9 has merged when the server PR is ready;
otherwise it is a follow-up.

## Every exit

Handles the package opens: the feed subscription, the tick interval, the
publisher loop, the delivery loop, up to N verification requests with their
timers and abort controllers, model requests. `stop()` unsubscribes, clears the
timers, aborts what is in flight, waits for loops to finish, and is safe to call
twice. Each of: end, `stop`, abort, timeout, throw, and restart has a test that
checks the counts are zero afterwards. Restart marks `running` verifications
`queued` again (the check is read-only) and `answering` items resume delivery.

## Tests (fakes only, no live model or network)

`node --test` on `dist`, with a fake `SupervisorHost` over an in-memory feed, a
scripted fake model, a fake `EvidenceSource` and a fake clock.

- Every rule fires on its event, and a table of non-events (a single failure, a
  cancel, `orphaned`, a progressing parent, a high-confidence success) interrupts
  nothing.
- Duplicates: a repeated feed entry, a repeated question, a restart mid-stream
  produce one item and one push.
- Limits: the hourly cap holds with parallel items at the boundary (handshake);
  quiet hours hold and release as one batch; a muted kind stays listed.
- Answers: exactly once under a double submit, a retry after a lost response, a
  crash between delivery and close (explicit crash points), and an inline answer
  racing the inbox answer; a stale item refreshes and delivers nothing.
- Verification: a manifest claiming passing tests while CI shows failures
  becomes `verification_failed` even when the scripted model says "supported";
  a citation whose quote is not in the page fails; same-vendor verifier is never
  chosen; `could_not_check` is not a pass; a hostile page cannot flip a
  deterministic failure.
- Spend: over the conversation budget, and over the daily cap, each end
  `could_not_check` with reason `budget` and the fake model is never called; a CI
  failure is still `failed` with the budget gone; two verifications at the cap
  reserve exactly once (handshake at the barrier); a refusal by T5 releases the
  daily reservation; the actual cost settles down; a restart between reserve and
  settle charges once; a retried attempt is checked against both limits again;
  the cap rolls over at the day boundary in the configured time zone.
- Fetcher: loopback, private, link-local, redirect-to-private, DNS answering a
  private address, oversize and slow bodies are refused.
- Summarizer: invented, missing and duplicate ids, a timeout and bad JSON never
  change the set of items or any interrupt.
- Exits: one test per exit, as above.
- Races are tested with explicit handshakes, never sleeps, and each fix has a
  test that fails on the old code.
- The T4 server PR adds tests for the routes, the SSE event, auth on every new
  route, and an end-to-end run: a scripted conversation raises a question, the
  inbox lists it, the answer reaches the conductor once.

## Delivery in two PRs

1. **Package `packages/cloud-supervisor`**, against fake ports. Starts when T4
   PR B and T5 are merged.
2. **Server wiring in `packages/cloud-server`:** the `supervisor` option, host,
   routes, the SSE kind, tests. Then, if T9 has merged, the `cloud-web` inbox
   view as its own PR.

Upstream files touched: root `package.json` (workspace, build chain) and
`package-lock.json` (the new workspace entry), recorded in the AGENTS.md fork
delta. No other upstream file.

## Not here

Per-user scoping (T17 adds accounts; items then carry a user), the gateway ledger
that replaces the price table (T17), web push (T9), suggestion cards (T16 reuses the item
store, delivery and limits), live model or network runs, and any new authority
for the supervisor over tasks or sandboxes.

## As built (PR 1, core inbox)

Where the package differs from the sketches above, now that T5 has merged:

- T5 already exposes `Conductor.reserveSpend`/`settleSpend` and a notice path, so
  the budget port (PR 2) and the notifier are thin adapters. Text always
  accompanies an option; a user message dismisses an open question and emits no
  event, so the supervisor closes its question items on a user message and on
  refused deliveries (`not_open`, `closed`), and never posts a message over an
  open question (`question_open`).
- The stall options are check, cancel and "keep waiting" (local, no message);
  there is no snooze. A low-confidence manifest is a `decision` item.
- `stop()` does not wait for a notifier or publisher that never returns: those
  calls carry no signal, so the supervisor stops waiting for them on abort.
- Task history from before the supervisor's first start updates the projection
  but raises no items; a question that is still open does.
- The digest's `open` count excludes `finished` items, which never ask anything of the human.
