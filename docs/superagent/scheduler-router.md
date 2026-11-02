# Scheduler and tunable Router

P1 admission queue and DSH-style intake on `@maka-cloud/superagent`.
JSON documents only. No sqlite `user_version` bump. No BoxPool changes —
another lane owns shared-box pooling; this code counts Super-agent running
tasks (default cap 4) and the existing `maxBoxes` / `spendCapUsd` spawn
gates.

## Scheduler

A task sits between a Slow-Path `spawn` and a worker.

| Field | Values |
|---|---|
| priority | `urgent` / `high` / `normal` / `low` |
| size | `S` / `M` / `L` (predicted token/$ cost) |
| dependencies | other task id, PR merged, CI green |
| footprint | predicted paths on one repo |
| start | immediate, time, PR merged, CI green, label added |

Admit only when all of these hold:

1. Start condition is true.
2. Dependencies are true.
3. A worker slot is free (`maxWorkers`, default 4).
4. Per-tenant API budget (tokens/$ per UTC day and concurrent predicted cost) is not exceeded. `admission.spendCapUsd` still applies (`spend_cap`).
5. No path overlap with a running task on the same repo. Conflicts wait (`footprint`) and serialize when the holder completes.

Order: reserved human tasks, then effective priority (base + aging), then enqueue time. Aging raises rank one step every `ageEveryMs` (default 15 minutes) so a low task cannot starve.

Human chat / `user_message` / unowned `issue_comment` is `reserved`. Background work may fill every slot only while no reserved task is waiting; if one is waiting, background is capped at `maxWorkers - reservedHumanSlots` (default 3 of 4).

States (ledger + progress): `queued`, `waiting(reason)`, `admitted`, `running`, `blocked(reason)`, `done`. The snapshot shows `reason` and `waitMs`.

Queue JSON is `documents.kind = scheduler`. Restart replays it.

`cron` is the time start condition. Waiting tasks stay visible on
`GET /v1/superagent/progress` (`queue`) and `npm run status`.

## Tunable Router (two-layer intake)

Aligned with the DSH Super-agent Fast / Slow Path.

```
event
  ├─ Fast Path (deterministic, zero model calls)
  │    bots / self / ping / no subject / unowned CI / timer
  │    duplicates / already-handled ids
  │    tenant rules (repo, label, author, path, keyword)
  │    rate cap, mode=off, tenant pause
  │    → drop + ledger reason
  ├─ subscribed thread → worker inbox (coalesceInbox). No Slow Path.
  └─ Slow Path (cheap router model, new thread or coordination only)
       classify explicit / inferred / not-accepted + confidence
       modes: off (Fast Path) / observe / auto
```

**Observe** (default for a *new persisted* tenant via `ensureRouterConfig` /
`defaultTenantRouterConfig`): a positive decision is `would_accept` only.
Nothing starts. Review, then switch to `auto`.

Superagent constructor ingest default is **`auto`** so existing tests and
host wiring keep spawning. Call `ensureRouterConfig(tenantId)` for the
product default.

Sensitivity: inferred/explicit below the threshold is a Slow Path drop
(`below_sensitivity`).

Feedback: `recordRouterFeedback` or `handleRouterCommand("feedback correct|wrong <decisionId>")`.
Stored on the tenant router document and injected as few-shot + rule
suggestions on the next Slow Path prompt.

Router model ≠ worker model. Config is a `ModelRef`
(`provider`, `model`, `baseUrl`, `apiKeyEnv`). Keys stay in the
environment (`MAKA_CLOUD_ROUTER_*` preferred, then judge / Anthropic).
`fake` provider is the test client.

### Per-layer metrics

Persisted on `documents.kind = intake`:

- `fastDropped` / `slowDropped` / `slowCalls` / `slowWouldAccept` / `passthrough`
- `byReason`: `fast:bot`, `fast:rate_cap`, `slow:below_sensitivity`, …

Audit rows carry `layer`. `statusSnapshot(tenant).intake` exposes the
counters so we can see how much the Fast Path saves.

## Pass-through (subscribed thread)

If `liveSubscribers(tenant, subject.key)` is non-empty, the event is
enqueued on that worker and drained through `coalesceInbox`.
`judgeCalls === 0` and the Slow Path client is not invoked. Tests cover
this with `FakeJudgeClient` prompt counts.

## Chain of recall

Every routing outcome appends `triggerId → threadId → workerId`
(`eventId`, `subject.key`, worker id from `ids.ts`). Query:

```ts
agent.followRecall(tenantId, { triggerId })
agent.followRecall(tenantId, { threadId })
agent.followRecall(tenantId, { workerId })
```

JSON document `recall`. This is the routing chain, not memory spill.

## Persistence

| Document | Kind |
|---|---|
| queue + facts + scheduler ledger | `scheduler` |
| router mode / rules / models / decisions / feedback | `router` |
| Fast/Slow counters + handled ids | `intake` |
| trigger → thread → worker | `recall` |

Sqlite creates `documents` with `CREATE TABLE IF NOT EXISTS`.
`PRAGMA user_version` stays 2.

## Open questions

1. Should host `startStack` call `ensureRouterConfig` so live tenants
   default to observe? Constructor/host stay `auto` until that lands.
2. Always keep one empty slot for humans, or only reserve while a human
   task is waiting? Current: the latter (higher utilization).
3. Predicted size costs (`S/M/L`) are placeholders until the usage ledger
   has enough phase samples.
4. Cross-task coordination on the Slow Path is prompt context (open task
   titles) plus scheduler dependencies — not a second model tool loop.
5. Shared-box BoxPool (one Instabox per tenant, up to 4 workers) is a
   sibling lane. This scheduler only implements the 4-worker cap.
