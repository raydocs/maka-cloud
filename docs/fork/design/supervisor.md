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

Since per-invite isolation, items are listed and answered within the caller's
own conversations, and the answer stores its caller so delivery is refused once
that invite is revoked. Mutes, settings and the digest are one set for the
whole server, so the server answers 404 to them for every invite until they are
kept per owner; digests stay off client streams.

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

## As built (PR 2a, source fetcher)

`createSourceFetcher` (`src/verification/fetcher.ts`) is the only code that makes
an outbound request. A host name is resolved once per hop; if any answer is not
public the fetch is refused (a mixed answer is not trusted), and the connection
goes to the first checked address with the certificate verified for the URL's
host name (`nodeTransport`, no agent, so no cookie or credential is ever sent).
Address literals and every spelling the URL parser normalizes (decimal, hex,
short forms, IPv4-mapped IPv6) are judged by `isPublicAddress`. Only text types
are read, identity encoding only, 2 MiB and 15 s by default. Nothing calls it
until the verification engine (PR 2b) is wired.

## As built (PR 2b, independent verification)

Verification is off unless `Supervisor.start` gets a `verification` option
(evidence source, source fetcher, budget port, verifier pool). Without it a
finished task is shown as finished at once, as in PR 1.

- **Claim and queue.** When a top-level task succeeds, the feed transaction
  inserts its one `verifications` row (`UNIQUE(task_id)`). Coding is recognized
  by `changes.json` or `change.patch` in the manifest's artifacts, research by
  `report.json` (T7 exports it in #47). A task with neither is `skipped`: a
  finished item marked "not independently checked", no reads, no spend. A
  low-confidence result raises its decision at once and is checked alongside it.
- **Deterministic first, and final.** Coding: the test record says `verified`,
  every changed file's content matches its recorded git blob hash, the patch is
  not empty. Research: the exported `report.json` parses, every cited page is
  fetched once (4 at a time), and `@maka-cloud/playbooks/citations` checks that
  each quote is in its page and each number in a claim is in its quote. Claims
  the playbook already dropped (`removed` in the exported `verification.json`)
  are skipped. A 4xx page or a refused address is a failure; a page that is down
  is "could not check" and retried.
- **Model second, only if nothing failed.** The pool model of a different vendor
  than the runner (`claude-agent-sdk` is Anthropic, `codex` is OpenAI; an unknown
  runner has no eligible verifier). The request carries claims and evidence as
  JSON inside blocks closed by a random marker; the answer is validated with zod;
  the worst of repeated verdicts wins; a missing verdict is "could not check".
  A verdict can add a failure, never remove one.
- **Spend.** Before the request the supervisor reserves the upper bound (input
  at 2 characters per token, output at the cap): first against the day's cap in
  `verifier_spend` (one synchronous transaction, the day in the configured time
  zone), then in the conversation's budget (`BudgetPort`, over T5's
  `reserveSpend`/`settleSpend`). A refusal by either ends the check
  `could_not_check` with a budget message, and a refusal by the conversation
  budget releases the daily reservation. After the call both settle to the
  reported usage; a call that failed is charged at its reservation. A reservation
  left by a stopped process is settled at its bound if it had been armed (a
  request may have run) and released if not. `BudgetPort.settle` must treat an
  unknown key as a no-op.
- **Ends.** `passed` raises the finished item (independently checked); `failed`
  and `could_not_check` raise a `verification_failed` item (options: ask the
  agent to fix it, accept anyway, and for "could not check" also check again,
  which queues a new epoch). A check that could not run for a passing reason
  (source or evidence down, the model not answering, a deadline) is retried up to
  3 times with doubling backoff; `budget` and `no_verifier` are not retried.
- **Exits.** Slots (default 2), the per-attempt deadline timer and the abort
  handle are released on done, deadline, stop and throw; a stopped attempt leaves
  its row running and the next start queues it again.

## As built (PR 3a, server side)

Everything here is in `packages/cloud-server`; it imports nothing from the
supervisor package, so the two build independently and the composition code (PR
3b) joins them.

- **`supervisor` option.** `startCloudServer({ supervisor })` calls the factory
  with `SupervisorParts` after the handler exists and before the server listens,
  and gets an `InboxService` back. On close the order is: streams end, the HTTP
  server stops accepting, the supervisor stops, the handler closes, the
  orchestrator endpoint closes, the database closes last. A failed start stops
  the supervisor it already started. Without the option nothing changes and
  `/v1/inbox/*` is 404.
- **Parts.** `feed.read` is `readFeed` over all conversations with `internal`
  set, which keeps a task's runner id (the public stream still strips it; the
  supervisor needs it to pick a verifier of another vendor). `feed.subscribe` is
  the hub. `publish` writes an extension event. `answers.deliver` goes to the
  handler's `onAnswer` with the conversation's own access (`not_found` for an
  unknown conversation or a handler that takes no answers). `messages.post` is the
  messages route's own path: idempotent on `clientMessageId`, and a new message
  reaches the handler once. `artifacts.read` reads through the artifact source
  and checks that the task's root session is the named conversation's.
  `answers.deliver` and `messages.post` refuse an already aborted signal before
  they write anything.
- **Extension feed kinds.** Schema v4 adds `extension_events` (append-only) and
  the feed kinds `inbox.item` and `inbox.digest`. The event body is stored as
  published and sent as the stream frame's data with `conversationId` added.
  Events are refused for an unknown conversation or data over 256 KiB. A
  conversation stream carries the inbox events of that conversation; digests
  (no conversation) go to unscoped streams only.
- **Routes** (`inbox.ts`), all behind the same invite as the rest of the API:
  `GET /v1/inbox/items`, `POST /v1/inbox/items/:id/answer`,
  `PUT`/`DELETE /v1/inbox/mutes/:kind`, `GET`/`PUT /v1/inbox/settings`,
  `POST /v1/inbox/digest`. The answer is 200 when the item is closed and 202
  while delivery is still being retried; refusals map `not_found` 404,
  `invalid_*`/`text_*` 400, `stale`/`closed`/`already_answered`/`question_open`
  409 (stale and already answered carry the refreshed item), `stopped` 503; a
  reason the server does not know is a 500. Writes share the control rate limit
  per invite; reads are not limited. The service decides what a settings patch
  or a mute kind means (`ok: false` is 400 or 404), so the server holds no copy
  of the supervisor's schemas.
- **Not in this PR:** the `Supervisor` to `InboxService` adapter, the notifier,
  the conversation budget and verifier model adapters, and the end-to-end test
  (PR 3b, `packages/cloud-host`).

## As built (PR 3b, host wiring)

`packages/cloud-host` joins the server and the supervisor. The server and the
supervisor still import nothing from each other.

- **Start.** `startCloud({ supervisor })` calls the factory with the server's
  parts and the conductor after the conductor exists and before the server
  listens; the stack's factory is `startInbox` (`src/inbox/setup.ts`), with the
  supervisor's database at `<data dir>/supervisor.db`. On close the supervisor
  stops before the conductor and the database (PR 3a's order).
- **Adapters** (`src/inbox/`):
  - `budget.ts`: `BudgetPort` over `Conductor.reserveSpend/settleSpend`. A refusal
    (budget, no run, conflict, bad amount) or an error reading the budget is a
    refusal with a reason; settling an unknown key is silent.
  - `evidence.ts`: artifacts through the server's artifact source (the host-side
    handoff directory), decoded as UTF-8.
  - `notifier.ts`: an interrupt becomes a conversation notice (`postNotice`), one
    per conversation for a batch, the ask clipped to 300 characters. Web push is a
    second notifier later.
  - `models.ts`: verifier and summary models over the AI SDK's `generateText`:
    one stateless request, `maxRetries: 0` (every retry is the supervisor's, and
    reserved and charged), API key only. Missing usage is charged at the bound.
    A reply that is not JSON is passed on as text and counts as no verdict.
  - `service.ts`: the supervisor as the server's `InboxService`; settings and mute
    kinds are validated by the supervisor's own schema.
- **Configuration** (`MAKA_CLOUD_VERIFIER_MODELS`): a JSON array of
  `{vendor, model, inputPerMTokUsd, outputPerMTokUsd, maxInputChars?,
  maxOutputTokens?, baseUrl?}`. No model id or price is built in. An `openai` entry
  needs `OPENAI_API_KEY`. `MAKA_CLOUD_VERIFIER_DAILY_CAP_USD` (default 5) is the
  starting cap, changeable in the inbox settings; `MAKA_CLOUD_SUMMARY_MODEL`
  defaults to `claude-haiku-5-5`. With no pool the checks that need no model still
  run, and anything that needs one ends "could not check" instead of passing.
- **Consequence to know about:** a `claude-agent-sdk` task can only be checked by a
  non-Anthropic model, so without an `openai` pool entry those tasks are never
  shown as independently verified.
- Fork delta: the root `build` and `build:test` chains build the supervisor before
  the host (the host now depends on it), and `packages/cloud-host` gains
  `@maka-cloud/supervisor`, `ai`, `@ai-sdk/anthropic` and `@ai-sdk/openai` at the
  versions `packages/runtime` already pins (one lockfile entry, no new package).

## As built (post-merge review fixes, part C)

Four findings from the post-merge review, each with a test that fails on the code
before the fix.

- **The bound is bytes, not characters.** `inputTokenBound(request)` in
  `verification/model.ts` is the one place the input estimate lives: one token per
  UTF-8 byte of instructions and prompt, plus a 1024-token wrapper allowance. The
  old half-a-token-per-character guess undercounted dense text (CJK, emoji) by up
  to three times, so the reservation, the conversation budget and the daily cap
  could be overrun. `upperBoundUsd` adds the output cap in full and returns
  `undefined` when a price or the output cap is not a finite, non-negative number;
  the engine then ends `could_not_check` with code `budget` before reserving
  anything or calling the model. The host's fallback for a provider that reports no
  usage charges the same bound. A model gateway's reservation replaces
  `inputTokenBound`; nothing else computes the estimate.
- **An empty check is never a pass.** A research report with no claims, or with no
  claim left after the removals, is a failure. The engine also refuses to pass with
  zero claims left (`incomplete`): a guard for future preparers, not reachable by
  the two built in.
- **Text the agent wrote is never matched, it is reproduced.** `report.json` is the
  source of truth and the checked set is every claim in it. Claim ids must be
  unique, else the report is rejected. The one thing that takes a claim out is the
  playbook having dropped it from the report the human reads, and that is believed
  only if `renderFromRecord` (exported from `@maka-cloud/playbooks/citations`, the
  same renderer `cite-check` uses) makes every delivered `report.md` and
  `report.html` byte for byte from `report.json` and `verification.json`. The record
  must list exactly the claims of the report, and its `removed` flags must be what
  its own statuses give in `drop_unsupported` mode. Anything else, including a
  rendering edited after it was made, a rendering listed twice (a decoy
  `out/decoy/report.md`), a listed rendering that is missing, or a rendering with no
  usable record, ends `could_not_check` with code `unverified` and the reason
  "checks reported by agent (unverified)": never "independently checked", and no
  fetch or model call is spent past it. With no rendering listed the record
  narrows nothing and every claim is checked. Any artifact name listed more than
  once is ambiguous and treated the same way. A contract test in the playbooks
  (`run.test.ts`) keeps the record able to reproduce what `cite-check` delivers.
- **Nothing waits on a hung resolver or fetcher.** The source fetcher races its
  name resolution with the fetch's abort signal (the deadline or the caller's
  stop), and `prepareResearch` races each `fetchText` with the check's signal, so a
  fetcher that ignores the signal cannot hold a verification slot past the deadline
  or keep `Supervisor.stop()` from returning.
- **A 404 or 410 stays a 404 or 410.** `fetchText` keeps the status of an error
  answer in its failure result, so the research check reports a gone page as a
  failure instead of as a source that is merely down.
