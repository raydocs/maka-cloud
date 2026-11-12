# Super-agent decisions, must-ask policy, and routing rules

This package adds three modules next to the existing Router, Safety gate, and
progress snapshot. The product is a paid, multi-tenant cloud employee: the
person decides once; the agent does not ask twice; a short whitelist of
irreversible actions always waits.

No sqlite `user_version` change. Decisions persist in memory, an optional JSON
file, and the existing `audit` table (`decision_recorded` / `decision_revoked`
/ `rule_matched`). That is enough to hydrate after a restart without a
documents table (the table #474 adds on its own branch).

## 1. Decision ledger (`decisions.ts`)

Scoped by **tenant + repo**. Two polarities:

| Polarity | Meaning |
|---|---|
| `decided` | 已定的事 — the person said to do it |
| `refused` | 定了不做的事 — the person said not to |

A row stores the person's **verbatim** words, the date, the **source event
id**, and a **scope** (category + optional object / path / tags). `origin` is
always `human`. Agent inferences, bots, and the watchdog cannot write
(`human_only`).

Newest programmatic match wins (`supersededBy`). A person can revoke
(`revokedAt`). Router and worker call `consultBeforeAsk` **before** opening a
card:

- exact `decided` → do that, cite `entryId` on progress (`followed decision dec_…`)
- exact `refused` → refuse the action, do not ask again, cite the same id
- fuzzy (same category, different object/path/tag) → hint only, still ask
- three always-ask categories ignore a prior `decided` and ask every time
  (see below)

Public API on `Superagent`: `recordHumanDecision`, `revokeHumanDecision`,
`decisionBook()`, `consultAction`. Owner `approve` / `deny` also append a
standing row (verbatim = bound text).

## 2. Must-ask whitelist (`must-ask.ts`)

One policy module. A hit **must** wait for a person. Defaults:

| Category | Examples |
|---|---|
| `delete_data` | drop table, wipe, `rm -rf` |
| `delete_branch` | delete / `-D` a branch |
| `stop_service` | scale to 0, undeploy |
| `deploy` | deploy / rollout / release |
| `spend_over_budget` | raise the cap, spend past the mandate |
| `outbound_message` | comment, email, IM |
| `product_direction` | pivot, kill a feature, change the roadmap |
| `rotate_secrets` | new or rotated keys |
| `change_permissions` | IAM, workflow, signing, CODEOWNERS |
| `db_migration` | migrate, alembic, prisma migrate |
| `force_push` | `git push --force` |

Everything else the agent finishes itself (still subject to Safety: merge,
protected push, review receipt, `observe` intensity).

**Always-ask** (never skipped by a ledger hit): `delete_data`,
`rotate_secrets`, `spend_over_budget`.

A tenant overlay may **add** always-ask categories or extra patterns. It
cannot disable a default (`cannot_loosen`).

### Alignment with Safety and #475

Do not open a second card when something else already blocked the action.

| Existing check | How we align |
|---|---|
| `Safety.gate` hold (`merge`, `push_protected`, `secrets`, `deploy`, `spend`, `other_irreversible`) | Must-ask classifies, then **one** `gate()` call. Pending must-ask stores the `approvalId`. |
| `mandateBlocks` (`intensity_observe`, `review_required`) | Applied first. Not a decision card. |
| #475 `speculative_blocked` | Duck-typed: unaccepted `worker.speculative` outbound → `already_blocked`, no card. We do not re-implement `Safety.gate`'s speculative branch. |

`consultBeforeAsk({ gate })` short-circuits when the caller already has a
Safety / speculative reason, so #477 can ask the policy after `gate` without
duplicating UI.

## 3. Declarative routing rules (`rules.ts`)

File: `superagent.rules.json`. Schema:
`packages/cloud-superagent/superagent.rules.schema.json` (zod + JSON Schema).

Each rule matches an **event envelope** and sets model, reasoning depth,
skills, one-run-per-object, max parallelism, and when to notify the person.

### Envelope

`source`, `type`, `object` (kind / id / repo / path / tags), one-line
`summary`, `backlink` (html url or `event:<id>`). Built from
`NormalizedEvent` (`envelopeOf`). No model in intake.

### Hot reload

`RulesEngine.maybeReload()` stats the file. A valid parse replaces the
in-memory set. A failed parse **keeps the last good file** and records
`rules_invalid` on the audit log. Missing / empty file → no rules → existing
Router (`HeuristicJudge` / `ModelJudge`).

### Hit vs miss

- **Hit:** audit + decision-book `ruleHits` (`rule_matched`). Skip the
  Router judge (`judgeCalls === 0`). Spawn with `worker.routeRule` (JSON on
  the worker row, no schema bump). `oneRunPerObject` / `maxParallel` refuse
  extra live workers. `notifyHuman: always` returns `must_ask` and waits.
- **Miss:** existing Router path, unchanged.

#474's `RouterRule` (allow/deny in the tenant `'router'` document) is a
different filter. This file is the product default for model / skills /
concurrency / notify. They compose: #474 can drop an event before this
engine sees it.

## 4. Wiring to #477 decision cards

#477 (`cursor/superagent-intake-merge-51be`) adds graded escalation:

```ts
interface DecisionCard {
  cardId: string;
  tenantId: string;
  eventId: string;
  threadId: string;
  title: string;
  reason: string;
  band: 'high';
  score: { value: number; urgency: number; risk: number; reason: string };
  state: 'pending' | 'accepted' | 'archived' | 'rejected';
  at: number;
  resolvedAt?: number;
  resolution?: 'accept' | 'archive' | 'reject';
}

statusSnapshot.decisions?: DecisionCard[]   // pending cards only
resolveDecisionCard(tenantId, cardId, option)
```

This branch does **not** add `statusSnapshot.decisions` (that name is
reserved for #477). It adds:

| This branch | #477 hook |
|---|---|
| `statusSnapshot.mustAskPending` | Map each row with `cardDraftFromMustAsk(pending)` and `addCard`. Field names on the draft match `DecisionCard`. |
| `statusSnapshot.decisionCitations` | Progress cites a standing `entryId` after a ledger hit. Cards stay for *open* asks. |
| `recordFromCardResolution(book, { card, option, actor, verbatim, … })` | Call from `resolveDecisionCard` after `resolveCard`. `accept` → `decided`, `reject` → `refused`, `archive` → no standing row (`archive_not_standing`). |
| `consultBeforeAsk` | Call from `tryEscalate` / Slow Path before creating a high-band card. Exact ledger hit → do not escalate. Always-ask → still escalate. |
| `Superagent.resolveMustAsk` | Stand-in until #477 lands. `accept` records and may spawn; host should still `approve(approvalId, boundText)` when `pending.approvalId` is set. |

Suggested merge order: land this PR, then in #477 (or a follow-up) one
runtime call:

```ts
// inside resolveDecisionCard, after resolveCard:
recordFromCardResolution(this.decisions, {
  card,
  option,
  actor: { login: 'owner', kind: 'user' },
  verbatim: card.title,
  at,
  repo: event?.subject?.repo,
  category: /* from card.reason or pending */,
});
```

and when building the snapshot:

```ts
decisions: [
  ...pendingCards(escalateState),
  ...this.pendingMustAsks(tenantId).map((row) => ({
    ...cardDraftFromMustAsk(row),
    cardId: row.pendingId,
    state: 'pending' as const,
    at: row.at,
  })),
]
```

Do not treat `StuckCard` (watchdog) or `ApprovalRecord` (Safety) as ledger
rows. Only a person's accept/reject/approve/deny/recordHumanDecision writes
the book.

## 5. Parallel branches

| PR | Relationship |
|---|---|
| #474 scheduler-router | Tenant `RouterRule` allow/deny + queue. Different from `superagent.rules.json`. Status may grow `queue` / `intake`; we only add `mustAskPending` / `decisionCitations`. |
| #475 BYOM + speculative | `speculative_blocked` — we duck-type and align, we do not edit `Safety.gate`. |
| #476 watchdog duplex | Conversational status. Decision citations ride on `waiting.decisionEntryId` / `formatProgressLine`. |
| #477 intake-merge | Cards. See §4. |
| #478 learning-review | Lessons from audit. Orthogonal; lessons never write this ledger. |

## 6. What this PR does not do

- No cloud-server route, no deploy script, no keys, no billing.
- No sqlite `user_version` bump (stays 2).
- No merge of the parallel branches.
- No weakening of existing Safety / Router tests: empty rules and an empty
  book leave those paths byte-identical for current fixtures.
