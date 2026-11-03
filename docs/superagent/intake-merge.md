# Cross-source merge and graded escalation

P1 follow-up on the two-layer Router (`docs/superagent/scheduler-router.md`).
JSON documents only. No sqlite `user_version` bump. No server, deploy, or
secret changes. New files own the logic; `runtime` / `recall-chain` /
`progress` / `ids` only grow hooks.

## Live event graph (same ticket, many sources)

Chat complaints, CI failures, issue/PR comments, and other sources land on
**one ticket** when they are the same work, and go to that ticket's worker
with the cause recorded.

```
event (after exact-subject subscribers)
  ├─ programmatic Fast signals (zero model)
  │    same repo + file path
  │    same error fingerprint / stack hash
  │    mutually referenced issue/PR (repo#N)
  │    same commit
  │    → observe: would_merge (suggestion only)
  │    → auto: subscribe source subject + inbox (coalesceInbox)
  ├─ fuzzy survivors + mergeClient
  │    shared significant tokens, same repo
  │    Slow Path JSON {"merge":true,"ticketId":"...","reason":"..."}
  └─ no hit → Fast Path / score / Slow Path as before
```

Default merge mode is **observe** (constructor and `ensureMergeConfig`).
`auto` is the only mode that attaches. `off` skips the graph.

Merges write `triggerId → threadId → workerId` plus `mergeId`,
`fromThreadId`, and `cause`. `followRecall` accepts any of those, so
"what happened to yesterday's issue" walks both directions.

`splitMerge(tenantId, mergeId)` retires the extra subscription and blocks
that source subject from rematching the same ticket.

### Collision

Two workers that would edit the same files still serialize in the scheduler
(`footprint`). The graph also stores a `CollisionHint` so the queue can show
why the second task is waiting.

## Graded escalation

When enabled (`ensureEscalateConfig` / `escalate: { enabled: true }`), a
cheap score (heuristic, or `scoreClient`) rates **value / urgency / risk**.

| Band | What happens |
|---|---|
| low | archive; no worker |
| medium | continue to the Slow Path / worker |
| high (risk ≥ `riskHuman` or composite ≥ `high`) | pending decision card |

Cards sit on `statusSnapshot.decisions` and `npm run status` as
`waiting on human`. No `LeadPort.speak`. The owner resolves with
`resolveDecisionCard(accept|archive|reject)`. That choice is stored as
feedback for later threshold tuning.

Scoring is **off** unless enabled, so existing spawn tests keep their
`judgeCalls`. Score-client tokens/$ go on `escalateMetrics`, not the
Router `judgeCalls` counter.

Default thresholds: `low=0.25`, `high=0.85`, `riskHuman=0.8`.

## Persistence

| Document | Kind |
|---|---|
| tickets, merge edges, collisions, merge mode | `graph` |
| score thresholds, cards, feedback, per-band spend | `escalate` |

`PRAGMA user_version` stays 2.

## Open questions

1. Should host `startStack` call `ensureEscalateConfig`, or keep scoring
   opt-in until thresholds have feedback?
2. After `splitMerge`, may a later hard signal rematch a *different*
   ticket, or is the source subject permanently independent?
3. Fuzzy token overlap (≥2 significant tokens) is a first cut. Do we want
   embedding similarity later, still behind `mergeClient`?
4. Accepting a high-risk card currently enqueues with `observeMandate`.
   Should accept replay the Slow Path judge instead?
