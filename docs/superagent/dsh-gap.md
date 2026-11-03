# Super-agent vs DSH 001–003: reliability gaps

`executor-decision.md` moves our effort to the Super-agent layer's
reliability, following deepseek-ai/dsh-superagent-prototype docs
001-domain, 002-authorization and 003-execution. This page lists what those
docs require, what `packages/cloud-superagent` has today, and what is still
missing. Written 2026-11-03 against the `superagent/executor-recovery`
branch; each "have" names the file that does it. Order is by risk, not by
DSH doc.

Legend: **have** (in code with tests), **partial** (some of it, or not
wired), **gap** (not built).

## Restart and stored work

| DSH requirement | Status | Where / what is missing |
|---|---|---|
| Decisions are stored first and executed afterwards (003) | partial | Events are stored before handling (`runtime.ts`, `store.ts`); outside actions are not yet routed through the stored outbox. |
| Relays and notices are retried from 2 s doubling to 1 min (003), outgoing messages from 5 s to 300 s, per Ticket and conversation in order, a failed one holding back later ones until it fails 3 times (003) | partial | `outbox.ts` (#487) stores items, retries with backoff and keeps per-session order. It is not wired into the runtime or the GitHub writer yet. |
| Restart: running Assignments end with "host restarted"; new ones start with a recovery note to check directory, git history and GitHub before repeating outside actions (003) | partial | `ExecutorCoder` with `StoreExecutorSessionStore` (`executor.ts`) keeps each worker's executor session in the tenant's store document. The first turn after a restart is `resume` with `RECOVERY_NOTE` ahead of the brief. A session from a rebuilt box starts over. Missing: the host does not yet build its coder through `createCoderFromEnv(..., { sessions })` (the coding loop is not in `cloud-host`), and recovery happens on the worker's next event, not proactively, oldest first, at boot. |
| Waiting/ready/blocked/failed Assignments stay as they are after restart unless an Input arrived after their Report (003) | have | Worker state is stored; `executorStopped` in `loop.ts` keeps needs-person/blocked as `review-wait` waiting on a human, which survives a restart. |
| Input read tracking: a message cut off before history counts as unread and is re-delivered exactly once (003) | gap | We record events, not which ones reached the executor's history. Needs a per-session "delivered through turn N" mark. |
| Source read position stored; restart never replays events (001) | have | Deliveries dedupe on `idempotencyKey` (`runtime.ts`, `eventByIdempotency`). |
| Accepting the same Trigger twice creates one Ticket (001) | have | Same idempotency check. |

## Follow-ups and ownership

| DSH requirement | Status | Where / what is missing |
|---|---|---|
| A follow-up on a Ticket's Thread goes to that Ticket's Executor, in the same Session (002) | have | `ExecutorCoder.apply`: CI (`ci_failed` → `ci`), review (`review_*` → `review`) and other follow-ups go through `send` into the worker's session. With the store-backed session store this now survives a restart. |
| The Executor may hand a message back once, when it is out of scope or belongs to another Ticket; it then goes to a fresh Eval with the Executor's reason (002) | gap | The status line has `ready`, `needs-person`, `blocked`, `failed`; there is no `handback` status, and no path from a worker back to the judge with a reason. Smallest step: a `handback` status-line value that ends the turn and re-queues the event for the judge with the reason. |
| While an Executor owns a message, the main session may only stop it (002) | gap | Not modelled; the judge can see every event. |
| At Ticket end, unanswered messages return to Eval if no other Ticket owns them (002) | gap | |

## Concurrency and holds

| DSH requirement | Status | Where / what is missing |
|---|---|---|
| At most one Eval per Thread; Triggers arriving meanwhile merge into the next batch (001) | partial | The scheduler serializes tasks per subject (`runtime.ts`, "scheduler serialized"); batching of queued Triggers into one Eval is not built. |
| Slot limit with one extra slot reserved for a person's message (003) | have | `scheduler.ts` `reservedHumanSlots`. |
| Background shell jobs and subagents: 30 min limit after each turn, killed jobs reported as `waiting` (003) | gap | Executors run one turn at a time; per-turn wall time is capped by the Assignment budget (`executor-budget.ts`), not by a background-job limit. |
| Failure hold: after `blocked`/`failed` no automatic Input; CI and bot messages are recorded but not delivered until a person writes or a retry (003) | partial | `blocked` waits on a human. `failed` reports no progress and the watchdog retries, so CI events can still reach a failed worker. |
| Transient provider/network errors (408, 429, 5xx, resets) are retried 3 times with growing backoff (003) | partial | Executor `failed` events carry `retryable`; nothing retries them with backoff yet. |
| Retry starts a new Assignment in the same Session, directory, branch and PR (003) | partial | The same worker keeps its session and branch; there is no explicit person-triggered Retry action. |
| Pause stops dispatch, Evals, deliveries and replies; a running turn is not interrupted (003) | partial | `pause.ts` pauses workers and verifies they stop; a pause that lets the running turn finish and holds deliveries is not built. |

## Authorization

| DSH requirement | Status | Where / what is missing |
|---|---|---|
| Mandate is immutable; records the Policy version it was accepted under (002) | have | `Mandate.policyVersion` (`types.ts`). |
| A Policy version change sends a policy-changed Input to each affected live Ticket, saying what changed; unaffected Tickets get nothing; Mandates are not revoked (002) | gap | The version is recorded but nothing compares it or tells running workers. |
| Revalidation before a person's message resumes an ended Ticket (002) | gap | |
| Accept modes `off` / `observe` / `auto`; inferred candidates need an assessment that judges each enabled rule once (002) | partial | Intensity `observe` / `act` / `autofix` and admission `allowActors` exist (`types.ts`, `rules.ts`); the per-rule assessment and `unavailable` decision are not modelled. |
| Eval timeouts: two retries, then `unavailable`; health lists unresolved ones (002) | gap | |
| Merging follows the delivery prompt; default no auto-merge (003) | have | `safety.ts` gate holds merges; the executor bench (`executor-bench.ts`) reads the gate and stops at `held`. |

## Next steps, smallest first

1. Wire the outbox (#487) for GitHub comments and PR updates, so outside
   actions are stored before they run and retried in order.
2. Build the host's coder with `StoreExecutorSessionStore` once the coding
   loop moves into `cloud-host`, and at boot resume running workers oldest
   first with `RECOVERY_NOTE`.
3. Add a `handback` status-line value: the turn ends and the event goes back
   to the judge with the executor's reason.
4. Compare `Mandate.policyVersion` on each event and send one policy-changed
   notice to affected live workers.
5. Failure hold: do not deliver CI/bot events to a `failed` worker until a
   person writes or retries; retry `retryable` executor failures 3 times with
   backoff.
