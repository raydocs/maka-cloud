# Super-agent architecture (maka-cloud)

Status: the agreed product direction for turning maka-cloud into a
DeepSeek-Harness-style Super-agent, as a paid hosted product. This document is
the detailed architecture. The core that implements it lives in
`packages/cloud-superagent` (`@maka-cloud/superagent`).

It refines the signed-off design page ("hi × maka-cloud: 用 Super-agent 与
LayerFS 搭一套系统", 2026-11-01) against the code on `main` and the open pull
requests. Where the page and the code disagree, the code wins and this document
says so.

Sources of the pattern (ideas, not code unless noted):

- DeepSeek Harness article *Exploring Super-agent Design* (2026-11-01). The
  article's ablation is 31.8M → 23.2M Router cache-read tokens with
  pass-through, about **27% fewer** Router tokens (the page's earlier "37%"
  figure was the inverse).
- [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
  (MIT). Domain terms (Trigger, Thread, Eval, Mandate, Ticket, Subscription)
  may be borrowed with attribution. The prototype runs as the operator's OS
  user with `danger-full-access` and no isolation; we do not.
- [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) (MIT). Workspace
  store only, behind a feature flag, off by default, gated on a spike.
- [MAGI](https://github.com/realTaki/MAGI) (BUSL-1.1). Ideas only: fail-wake
  cap of three, background work default-zero-spend, store/test/activate/publish
  as four distinct actions. No MAGI code.

hi (the phone agent) is out of this repository. Option A from the design page
stands: hi stays an independent on-device agent. A later, default-off, read-only
"cloud hands work to a development phone" channel is not designed here.

## 1. Why this, and what it is not

A single conductor conversation that starts a new orchestrator task on every
GitHub event does not scale. The owner cannot follow more than a handful of
sessions, every follow-up spends Router tokens, and a task that opened a pull
request forgets the pull request the moment the conversation ends.

A Super-agent is one continuous employee:

- **Continuous.** The owner talks to one agent in chat and on GitHub. Sessions
  are an implementation detail.
- **Productive.** Many workers run at once. Each owns one subject.
- **Proactive.** Events drive work. The agent is quiet when nothing is worth
  doing.
- **Persistent.** Workers sleep between events, resume from durable state, and
  survive a host restart.

It is not a rewrite of Maka, not a DeepSeek Harness plugin, and not a boat.dev
product. Compute stays in `@maka-cloud/host`. Execution stays in Instabox
behind a `SandboxPort` that matches the `SandboxApi` seam of open PR #452.
Durable task logs stay in `@maka-cloud/orchestrator`. The Super-agent package
is the **event, subscription, worker-lifecycle, watchdog and safety** layer
that those packages do not have.

### 1.1 Non-goals

- Pricing, invoices, or a payment provider (metering hooks only).
- Running LayerFS, FUSE, or Docker in this slice.
- Merging or depending on the parked boat.dev PRs (#451, #453, #455).
- Commenting on, closing, or landing the open PRs this document maps to.
- hi Relay, remote unlock, or any path that lets the cloud approve a payment
  on a phone.
- A third coding vendor, Claude subscription login, or branding as
  "Claude Code".
- Silent speculative "reproduce and fix" before the first live run.
- Email, Slack, or Feishu channels.

## 2. How this maps to the code that already exists

maka-cloud already has most Super-agent parts under other names. The gap is
**subscription pass-through** and **one worker that owns a subject for its
life**.

| Super-agent part | Existing code | Gap this architecture fills |
|---|---|---|
| Router (no Bash) | `@maka-cloud/conductor`: tools are `start_playbook`, `delegate_task`, `task_status`, `task_wait`, `task_cancel`, `ask_user`, `notify`. Confirmed: no Bash. | Conductor is per-conversation, not a long-lived Router. Super-agent adds a deterministic admission + optional judge in front of it, and only calls a model for **unowned** events. |
| Workers | `@maka-cloud/runners` `SandboxCliRunner` + orchestrator tasks (T28) | A task dies with its conversation. Super-agent workers outlive a turn, sleep, and resume. |
| Triggers | `@maka-cloud/duties` webhooks + five trigger kinds; cards (T30, off at launch) | Duties start a **new** conductor run per event. Super-agent normalizes events, then routes. Duties become one Source, not the router. |
| PR follow-up | Open PR #460 (`FollowUpPorts`, `pr-follow-ups.json`, one bounded CI fix) | The first WorkItem kind. Super-agent generalizes the subject to issue and chat thread. Do not duplicate #460; wrap it. |
| Durable state | T28 step log, epoch fence, transcript mirror | Worker record adds memory, plan, transcript pointer, mandate, inbox offset. The step log remains the record of a **run**; the worker record is the record of a **subject**. |
| Watchdog | `@maka-cloud/supervisor` R1–R5 ("rules decide, models describe"); T33 stuck report is docs only (#444) | Super-agent watchdog is a second, subject-level loop: stuck, looping, over-budget, crashed. It calls supervisor-shaped escalation; it does not replace R1–R5. |
| Sandbox | `@maka-cloud/instabox` `InstaboxClient`; open PR #452 `SandboxApi` | Super-agent talks to `SandboxPort` (the #452 pick). Default adapter is Instabox. boat.dev stays parked. |
| Workspace | Fresh git clone per task in the box | Shared tenant box: git worktrees under `/work/<workerId>` from a cached base clone. `GitCloneStore` on the host. LayerFS stays off. |
| Approvals | Conductor `GrantRow` bound to exact text; T15 taint; duty `Authority` | Worker `Mandate` + Super-agent approval kinds (merge, protected push, secrets, deploy, spend). Conductor grants stay for conductor tools. |
| Isolation | `docs/fork/isolation-model.md` I1–…; one box per invite at launch | Tenant id on every Super-agent row. A worker never sees another tenant's store, sandbox, or secrets. |
| Spend | Gateway caps, duty `runBudgetUsd` / `dailyCapUsd`, orchestrator `budgetUsd` | Per-worker budgets on the Mandate; metering hooks for a later ledger (T17). |

### 2.1 Open pull requests

| PR | Role | What we do |
|---|---|---|
| #444 T33 stuck-report (docs) | Typed `ask_user` reason `stuck`; ≤2 unverified delegations; integrity scan | Watchdog findings use that shape when they escalate. Do not re-specify T33. |
| #452 `SandboxApi` | `Pick<InstaboxClient, ensureRunning \| exec \| getMachine \| snapshots \| leases>` | Super-agent's `SandboxPort` is that pick. When #452 merges, `InstaboxClient` satisfies it with no adapter. |
| #451 / #453 / #455 boat.dev | Parked | Do not import. Instabox remains the execution environment. |
| #460 PR follow-up | One worker per coding-task PR until checks speak | First subject kind. `FollowUpBridge` maps a #460 watch onto a Super-agent subject. Auto-fix stays off (`MAKA_CLOUD_PR_AUTOFIX` default). |
| #449 upstream sync | Daily merge-commit sync | Super-agent is a new `packages/cloud-*` package so the next sync does not touch it. |
| #458 viewport proof | Evidence for result cards | Out of Super-agent scope; workers may later point at a preview. |

### 2.2 Where the new code lives

```
packages/cloud-superagent/     @maka-cloud/superagent
  events, intake, router, workers, watchdog, safety,
  WorkspaceStore, SandboxPort, SuperagentStore (memory + sqlite)

docs/fork/architecture/superagent.md   this file
```

The package depends on `zod` only. It does **not** import `@maka-cloud/host`,
`server`, `conductor`, `duties`, or `runners`. Those compose it later through
ports. That keeps the next apache/maka merge cheap and lets host tests stay
unchanged until a dedicated wiring PR.

`WorkspaceStore` was proposed for `cloud-runners` in
`docs/fork/design/layerfs.md`. It starts here so P1 does not edit runners. P3
may re-export it from runners when the coding playbook starts calling
`prepare()`.

Persistence is a **package-local SQLite file** (`superagent.sqlite`), exclusive
lock, same pattern as duties and supervisor. It is **not** a `cloud-server`
schema migration. A later host PR may move the file next to the server data
dir; that still needs no server-table migration.

## 3. Components

```mermaid
flowchart TB
  gh[GitHub webhook / poll]
  chat[Chat / cloud-web / cloud-mobile]
  cron[Duties schedule / timers]
  intake[Intake: normalize, dedupe, event log]
  subs[Subscription table]
  router[Router: admission + judge]
  worker[Worker: one subject]
  box[Instabox via SandboxPort]
  ws[WorkspaceStore]
  dog[Watchdog]
  gate[Safety: mandate, budget, approval]
  owner[Owner]
  meter[Metering hooks]

  gh --> intake
  chat --> intake
  cron --> intake
  intake --> subs
  subs -->|owned: pass-through| worker
  subs -->|unowned| router
  router -->|ignore / answer| owner
  router -->|spawn + Mandate + subscribe| worker
  worker --> box
  worker --> ws
  worker --> gate
  gate -->|risky action| owner
  dog -.->|stuck / restart / escalate| worker
  worker --> meter
```

| Component | Responsibility | Must not |
|---|---|---|
| **Intake** | Turn a raw GitHub / chat / timer payload into a `NormalizedEvent`. Idempotent on `(tenantId, idempotencyKey)`. Append to the event log. Classify the `Subject`. | Call a model. Guess a malformed payload. |
| **Subscription table** | Map `subjectKey → workerId` for live workers. Fan-out is code. | Invent work. Change a Mandate. |
| **Router** | Fast path: deterministic admission (source, actor, allow-list, tenant pause). Slow path: `RouterJudge` (heuristic in tests; model later) decides `ignore`, `answer`, or `spawn`. | Execute, hold Bash, or see a subscribed follow-up. |
| **Worker** | Own exactly one subject. Durable memory / plan / transcript pointer / inbox. Sleep, wake, retire. Call `WorkerHandler` (wired to a runner in a later PR). | Talk to the owner except through Router or an approval. Cross a tenant. |
| **Watchdog** | External tick. Detect stuck, loop, over-budget, crash. Restart (capped) or escalate. | Run inside the worker handler. Use a model to decide a restart. |
| **Safety** | Mandate, budgets, approval bound to exact text, audit log, tenant scoping. | Trust a model "I am allowed". |
| **WorkspaceStore** | Prepare a workspace. Default: git clone. LayerFS: flag + spike. | Be the only copy of a kept change. |
| **SandboxPort** | Exec / ensureRunning / machine / snapshot on Instabox. | Hold `INSTABOX_API_KEY` in a worker or a box. |
| **Metering** | `record(usage)` hook. | Price anything. |

### 3.1 Two-level sessions, as they land here

The article's Router is one long-lived LLM session. maka-cloud already has a
conductor that must stay append-only (Opus 5.5 preserved thinking). We do
**not** replace that session with a second model loop in P1.

P1 Router is code: admission + `RouterJudge`. The default judge is a
heuristic. A later PR may put unowned events through the existing conductor
as a **new conversation that is only allowed the Router tool set** (still no
Bash, still no `delegate_task` that execs). That conversation is not the
owner's chat.

Workers are not conductor conversations. A worker's execution is an
orchestrator task (T28) started by a host adapter. The worker record points
at that task's transcript. When the task finishes, the worker **sleeps**; it
does not retire unless the subject closes.

## 4. Data model

Every row is scoped by `tenantId` (today: the invite id; later: the org id).
A query that omits `tenantId` is a bug.

### 4.1 Subject and Thread

A **Subject** is the thing a worker owns. A **Thread** is the event stream of
that subject. For P1 they are 1:1 (`subjectKey` is the thread key). The
subscription table is many-to-many so a later reviewer worker can subscribe
to the same PR without a migration.

```
subjectKey =
  pr:<tenant>:<repo>#<n>
  | issue:<tenant>:<repo>#<n>
  | chat:<tenant>:<conversationId>
  | check:<tenant>:<repo>:<sha>:<name>     /* correlation only; not owned */
```

| Field | Type | Notes |
|---|---|---|
| `kind` | `pull_request` \| `issue` \| `conversation` | Owned kinds. |
| `tenantId` | string | Required. |
| `repo` | `owner/name` | GitHub subjects. |
| `number` | int | PR or issue number. |
| `conversationId` | string | Chat subjects. |
| `closed` | bool | Set by a close/merge event. |

DSH allows several Tickets per Thread. The product decision here is
**one live owner per subject**. A second spawn on the same `subjectKey` is
refused (`already_owned`). The Router may later grow an `attach` decision
for a reviewer; the table already allows it, the policy does not.

### 4.2 NormalizedEvent (Trigger)

Immutable once stored.

| Field | Type | Notes |
|---|---|---|
| `eventId` | `evt_…` | Assigned at ingest. |
| `tenantId` | string | |
| `source` | `github` \| `chat` \| `timer` \| `internal` | |
| `type` | string | `pr_opened`, `pr_closed`, `issue_opened`, `issue_comment`, `review_comment`, `ci_failed`, `ci_passed`, `user_message`, `tick`, `subject_closed`, … |
| `subject` | Subject | May be absent only for `ping`. |
| `idempotencyKey` | string | GitHub delivery id; chat message id; timer slot id. |
| `actor` | `{ login, kind: user\|bot\|system }` | |
| `occurredAt` | ms | From the source when present. |
| `receivedAt` | ms | Host clock. |
| `summary` | string | **Code-built**. Numbers and fixed words only. |
| `fields` | `[label, value][]` | Other people's text. Quoted when a model sees it. |
| `closesSubject` | bool | PR merged/closed, issue closed. |

Intake drops a payload it cannot parse. It does not invent a subject.

### 4.3 Subscription

| Field | Type | Notes |
|---|---|---|
| `subscriptionId` | `sub_…` | |
| `tenantId` | string | |
| `subjectKey` | string | |
| `workerId` | string | |
| `createdAt` | ms | |
| `retiredAt` | ms \| null | Soft; unique live index on `(tenantId, subjectKey, workerId)`. |

### 4.4 Worker record (Ticket)

| Field | Type | Notes |
|---|---|---|
| `workerId` | `wrk_…` | |
| `tenantId` | string | |
| `subject` | Subject | Frozen at spawn. |
| `state` | see §6 | |
| `generation` | int | Increments on restart. Watchdog cap is 3. |
| `mandate` | Mandate | Frozen at spawn. A wider scope is a new worker. |
| `memory` | string | Durable notes the handler wrote. |
| `plan` | string | Current plan text. |
| `transcriptPointer` | string \| null | Orchestrator task id or transcript path. |
| `sandboxRef` | string \| null | Instabox machine id. |
| `workspaceRef` | string \| null | `WorkspaceHandle.id`. |
| `lastEventId` | string \| null | Last consumed event. |
| `lastProgressAt` | ms | Watchdog W2. |
| `lastHeartbeatAt` | ms | Watchdog W1. |
| `lastStepSignature` | string \| null | Watchdog W3. |
| `stepRepeats` | int | |
| `nudges` | int? | W2: one nudge already delivered. JSON only; no schema bump. |
| `doneClaim` | claim? | Worker "done" is a claim until signals read back. JSON only. |
| `reviewReceipts` | receipt[]? | CLEAR/BLOCK pinned to a head SHA. JSON only. |
| `pausedFrom` / `pausedVerified` | state? / bool? | Owner pause, only after a verified stop. JSON only. |
| `lastLive` | facts? | Last live PR/CI snapshot the lead re-read. JSON only. |
| `usage` | `{ tokens, usdMicros, wallMs }` | |
| `createdAt` / `updatedAt` / `retiredAt` | ms | |

Inbox is a separate table: `(workerId, seq, eventId, deliveredAt, consumedAt)`.

### 4.5 Mandate

Frozen at spawn. Default intensity is **`observe`**.

| Field | Type | Notes |
|---|---|---|
| `policyVersion` | string | e.g. `maka-superagent.1`. |
| `scope` | `{ repos: string[]; paths?: string[] }` | |
| `intensity` | `observe` \| `act` \| `autofix` | `autofix` is never the default. Maps to `MAKA_CLOUD_PR_AUTOFIX` for PR subjects. |
| `authority` | `read-only` \| `open-pr` \| `merge-when-green` | Same ladder as duties / conductor. A worker cannot raise it. |
| `budgets` | `{ tokens?, usd?, wallMs? }` | Hard. Exceeding → W4, worker stops. |
| `strength` | `explicit` \| `inferred` | From the article / DSH. Inferred work stays `observe` unless a person raises it. |
| `allowNoCi` | bool? | Scratch / no-CI repos only. Merge treats an empty Checks/Statuses list as green when set; default refuse. |
| `ownerPause` | bool? | Owner may pause this worker. Default true. `false` refuses `Superagent.pause`. |

### 4.6 Approval and audit

| Field | Type | Notes |
|---|---|---|
| `approvalId` | `apr_…` | |
| `kind` | `merge` \| `push_protected` \| `secrets` \| `deploy` \| `spend` \| `other_irreversible` | |
| `boundText` | string | Exact text the owner saw. Approve must match. Merge binds `Merge pull request #N in repo at <sha>` so a new push invalidates the approval. |
| `state` | `pending` \| `approved` \| `denied` \| `expired` | |
| `expiresAt` | ms | Default 24h. |

Audit rows are append-only: ingest, route, spawn, sleep, wake, approve, deny,
watchdog finding, retire, usage. They are the product's proof that a paid
tenant can ask "what did it do, and who allowed it".

### 4.7 SQLite schema (package-local, version 1)

Not a `cloud-server` migration. New file. Additive later versions of this
file are allowed in follow-up PRs and must be called out.

```
events(event_id, tenant_id, idempotency_key, subject_key, source, type,
       occurred_at, received_at, json)
UNIQUE (tenant_id, idempotency_key)

subscriptions(subscription_id, tenant_id, subject_key, worker_id,
              created_at, retired_at)
UNIQUE live (tenant_id, subject_key, worker_id) WHERE retired_at IS NULL

workers(worker_id, tenant_id, subject_key, state, generation, json,
        created_at, updated_at, retired_at)

inbox(worker_id, seq, event_id, delivered_at, consumed_at)
PK (worker_id, seq)

approvals(approval_id, tenant_id, worker_id, kind, bound_text, state,
          created_at, decided_at, json)

audit(audit_id, tenant_id, worker_id, kind, at, json)

usage(tenant_id, worker_id, tokens, usd_micros, wall_ms, updated_at)
PK (tenant_id, worker_id)
```

`PRAGMA locking_mode=EXCLUSIVE` at open. A second process fails immediately
(`SuperagentDatabaseInUseError`). Unknown `user_version` is refused, not
guessed.

## 5. Event flow

### 5.1 Ingest and route

```mermaid
sequenceDiagram
  participant Src as Source
  participant In as Intake
  participant Log as Event log
  participant Sub as Subscriptions
  participant W as Worker
  participant R as Router
  participant H as Handler

  Src->>In: raw delivery
  In->>In: parse / normalize
  alt duplicate idempotencyKey
    In-->>Src: duplicate
  else unparsable
    In-->>Src: rejected
  else new
    In->>Log: append
    In->>Sub: lookup subjectKey
    alt live subscriber
      Sub->>W: enqueue, wake if sleeping
      W->>H: handle(event, durable state)
      Note over R: judge calls = 0
    else unowned
      In->>R: admit
      alt admission drop
        R-->>Src: ignored (no model)
      else
        R->>R: judge(event)
        alt ignore / answer
          R-->>Src: recorded
        else spawn
          R->>W: create + Mandate + subscribe
          W->>H: handle(first event)
        end
      end
    end
  end
```

The point of the subscription table is the article's result: follow-ups on an
owned subject **do not enter the Router**. Tests assert `judgeCalls === 0` on
that path.

### 5.2 GitHub

Intake accepts a wider set than duties (`ACCEPTED_EVENTS`), because a worker
must see close/merge and PR open:

| GitHub event | Normalized type | Subject |
|---|---|---|
| `ping` | `ping` | none |
| `pull_request` opened / reopened | `pr_opened` | `pr:…#n` |
| `pull_request` closed / merged | `pr_closed` (`closesSubject`) | `pr:…#n` |
| `pull_request` synchronize | `pr_updated` | `pr:…#n` |
| `issues` opened | `issue_opened` | `issue:…#n` |
| `issues` closed | `issue_closed` (`closesSubject`) | `issue:…#n` |
| `issue_comment` | `issue_comment` | PR or issue, from payload |
| `pull_request_review` / `_comment` | `review_comment` | `pr:…#n` |
| `workflow_run` completed failure | `ci_failed` | PR if `head_branch` maps; else unowned |
| `workflow_run` completed success | `ci_passed` | same |

Duties still verify the HMAC (`readDelivery`). Super-agent Intake assumes a
delivery that already passed that gate, **or** is a test fixture. Host wiring
must not call Intake with an unverified body.

Self and bot actors never spawn (same rule as duties `isSelfOrBot`). They
**do** pass through to an existing worker, except the worker's own comments,
which Intake marks `actor.kind = bot` and the handler may ignore. This is how
#460 avoids a CI-fix loop.

### 5.3 Chat and timers

A user message in an existing conversation whose worker is live is
pass-through (steer). A message in a conversation with no worker goes to the
Router. A timer with no subscriber is ignored unless a duty Source marked it
as needing a judge (P1: timers without a subscriber are `ignore`).

### 5.4 Correlation

A `workflow_run` may not name a pull request number. Intake puts the event on
`check:<tenant>:<repo>:<sha>:<workflow>` and lists **correlated**
`subjectKey`s when the branch is `maka/…` or matches an open worker's repo +
branch. Correlation **never routes on its own**. Routing uses the owned
subject when one correlates; otherwise the event is unowned and usually
ignored (unowned CI is noise).

## 6. Worker lifecycle

```mermaid
stateDiagram-v2
  [*] --> spawning: Router spawn
  spawning --> running: handler start
  running --> sleeping: inbox empty
  sleeping --> waking: pass-through event
  waking --> running: state restored
  running --> awaiting_approval: risky action, no grant
  awaiting_approval --> running: approve exact text
  awaiting_approval --> retiring: deny / expire
  running --> stuck: watchdog W2 / W3
  running --> crashed: handler throw / heartbeat lost
  stuck --> running: restart generation+1
  crashed --> running: restart generation+1
  stuck --> retiring: max restarts / person stop
  crashed --> retiring: max restarts
  running --> retiring: subject closed / person stop
  sleeping --> paused: owner pause after verified stop
  running --> paused: owner pause after box stopped
  awaiting_approval --> paused: owner pause
  paused --> sleeping: explicit resume
  paused --> awaiting_approval: explicit resume to pausedFrom
  retiring --> retired: sandbox released, sub retired
  retired --> [*]
```

Rules:

1. A worker owns **one** subject for its life. It does not steal another
   worker's subject.
2. Sleep writes durable state first, then may ask `SandboxPort` to suspend.
   Instabox already auto-suspends (300–1800 s). Sleep is a worker state, not
   a box state.
3. Wake restores memory, plan, transcript pointer, then consumes the inbox
   in `seq` order.
4. A host restart calls `restore()`: `running` / `waking` / `awaiting_approval`
   stay; `spawning` retries start; `crashed` waits for the watchdog;
   `sleeping` stays asleep; `paused` stays paused until an explicit
   `resume()`.
5. Subject close → `retiring`. The handler gets one `subject_closed` event to
   write a last note. It cannot open a new PR on the way out.
6. A person stop withdraws the Mandate. Resume after stop requires a new
   Router spawn (new Mandate). DSH lets a human message reopen an ended
   Ticket under the same Mandate; we do **not**, because a paid product must
   not silently regain `act` after the owner stopped it.
7. Intensity `observe` may read and comment; it may not push, merge, or spend.
8. Owner pause is a verified stop (`pausedVerified`), not a prompt. Drain
   and the watchdog do not run the worker while it is paused. Only
   `Superagent.resume` ends it. See §18.

### 6.1 Assignment (execution)

DSH separates Ticket (domain) from Assignment (executor instance). We keep
that split without the name:

- The **worker record** is the Ticket.
- An **execution** is an orchestrator task + optional sandbox lease. The
  worker stores `transcriptPointer` and `sandboxRef`.
- A restart ends the execution (new generation) and keeps the worker.

P1's `WorkerHandler` is a port. The default test handler records events. The
host adapter (later PR) starts `delegate_task` / `SandboxCliRunner` and writes
the transcript pointer back.

### 6.2 Relationship to #460

```
coding playbook opens PR
        │
        ▼
#460 FollowUpStore watch (pr-follow-ups.json)
        │
        ▼
FollowUpBridge.subjectOf(watch) → pr:<tenant>:<repo>#n
        │
        ▼
Super-agent worker (if not already owned)
        │
        ├─ CI event → pass-through (no Router)
        ├─ review comment → pass-through
        └─ intensity=act + MAKA_CLOUD_PR_AUTOFIX → one bounded fix
           (still the #460 cap; Super-agent does not add a second fixer)
```

Until #460 merges, Super-agent still owns a PR subject created by the
Router (for example an issue that became a PR). The bridge is additive.

## 7. Router

### 7.1 Fast path (admission)

Deterministic, no model. Drops:

- `ping`
- source not in the tenant's allow-list
- actor in `selfLogins` or `bot` **when the event is unowned**
- tenant paused / over its daily cap (metering hook returns `stop`)
- before spawn: live Instabox workers at `maxBoxes`, or tenant ledger at `spendCapUsd`
- subject already closed and unowned
- unowned `ci_*` (noise; owned CI pass-through already happened)
- inferred strength when the Policy says "explicit only"

Everything dropped is still in the event log (`disposition: filtered`).

### 7.2 Slow path (`RouterJudge`)

```ts
type RouterDecision =
  | { action: 'ignore'; reason: string }
  | { action: 'answer'; text: string }
  | { action: 'spawn'; mandate: Mandate; title: string };
```

P1 ships `HeuristicJudge`:

- Chat that asks for status and names no new work → `answer`.
- `issue_opened` / `pr_opened` from an allowed actor → `spawn` at
  `observe` unless the text contains an explicit work request the tenant
  marked as `act` (P1: spawn at `observe`).
- Everything else → `ignore`.

`ModelJudge` takes an injectable `JudgeClient`. `FetchJudgeClient` speaks
the same Anthropic Messages API as the host gateway (`/v1/messages`,
`x-api-key`, `anthropic-version`). HeuristicJudge stays the default;
`MAKA_CLOUD_SUPERAGENT_JUDGE=model` opts in. A missing client throws. A
bad or failed completion falls back to the heuristic. The conductor is a
candidate, but only with the Router tool set (no `delegate_task` that
starts a sandbox from the Router turn).

### 7.3 Batching

The article batches Triggers that arrive during one Router turn. Unowned
events are still judged one by one. A worker drain coalesces that worker's
pending inbox into **one** `handler.handle` call (approval_granted wins
over the latest row; a close event still retires). Pass-through already
removes the Router burst that made batching necessary in the article.

## 8. Watchdog

External. Driven by `Superagent.tick(at)`. No model decides a restart.
Supervisor principle: **rules decide, models describe**.

| Id | Finding | Condition | Action |
|---|---|---|---|
| W1 | `crashed` | `state=running` and `now - lastHeartbeatAt > heartbeatAfterMs`, or handler threw | Restart if `generation < maxRestarts` (3), else escalate |
| W2 | `stuck` | `running`/`waking` and `now - lastProgressAt > stallAfterMs` | Nudge once (enqueue `watchdog_nudge`, do not mark stuck). Escalate on the next stall. A worker whose memory or plan self-reports `waiting` is exempt. A `paused` worker is skipped (no nudge). |
| W3 | `looping` | `lastStepSignature` repeated `loopRepeat` (3) times without progress | Escalate; optional restart once |
| W4 | `over_budget` | usage ≥ any Mandate budget | Stop handler, escalate, no restart |
| W5 | `subject_closed` | close event not yet retiring | Force `retiring` |
| W6 | `awaiting_expired` | pending approval past `expiresAt` | Deny, retire if the action was required |
| W7 | `stream_silence` | no tokens/events on a model stream for 4 minutes | Retry the same endpoint; discard any partial |
| W8 | `time_limit` | the response hit a hard time limit | Retry; stop after 2 attempts |
| W9 | `empty_turns` | 3 consecutive turns with no visible output | Stop |
| W10 | `repeat_tools` | 3 identical tool calls (name+args) | Nudge; 6 stops. New results (CI poll) continue |

Defaults: `stallAfterMs = 15m`, `heartbeatAfterMs = 2m`, `loopRepeat = 3`,
`maxRestarts = 3` (MAGI idea: wake at most three times, then a person).
Bounded-autonomy thresholds are configurable; the defaults above match
Factory Droid 1.0. Compaction summaries are budgeted at 16k tokens.
Every stop / retry / nudge is a `usage_events` row (`kind`
`autonomy_*`), a watchdog finding, and a progress `reason` the lead
speaks.

Worker model requests are append-only so the provider cache stays warm:
newly loaded tools are appended at the end of the request, not inserted
into the tool list, and volatile facts (git status, clocks) live in a
tail segment. A cache-break monitor diffs each request against the
previous one and records which segment broke the prefix. Cache-hit share
is `cache_read_input_tokens / (read + creation + input)` from Anthropic
usage. A failed request retries the same provider endpoint.

Escalation is a structured finding the host turns into a supervisor inbox
item / `ask_user` `stuck` (T33). Super-agent does not send chat itself.

The watchdog **never** runs in the same call stack as `WorkerHandler.handle`
except for the usage check the handler already does. `tick()` is the host
cron.

## 9. Safety, approval, tenancy

This is the paid-product difference. The DSH prototype says its wrappers are
not a security boundary.

### 9.1 Layers (do not collapse)

| Layer | Who enforces | What it stops |
|---|---|---|
| Tenant row | Super-agent store | Cross-tenant read/write |
| Mandate | Safety, at spawn and before each action | Wider scope, raised authority, `autofix` by default |
| Conductor grant / T15 taint | `@maka-cloud/conductor` | Outside text driving a write |
| Duty authority | `@maka-cloud/duties` + conductor gate | A standing duty merging |
| Super-agent approval | Safety | merge, protected push, secrets, deploy, spend |
| Isolation model | instabox + runners | Agent account, egress, no long-lived keys in the box |
| Gateway cap | `@maka-cloud/gateway` | Vendor spend |

A model cannot skip a layer.

### 9.2 Approval kinds (always human, even at `merge-when-green`)

`merge-when-green` on a duty still goes through the conductor's existing
path. Super-agent **additionally** holds:

- merge of a PR
- push to a protected branch
- reading or injecting a secret value into a prompt or a log
- deploy
- spend outside the Mandate budget (the overflow itself is W4; a person may
  raise the budget with a bound-text approval)

Approve is `boundText` byte-identical to the pending row, same as conductor
grants. A changed diff needs a new approval. Merge additionally lists
Checks + Statuses for that SHA and refuses failed, pending, or all-skipped
runs. An empty check list is never green unless the mandate sets
`allowNoCi`. `HttpGitHost.merge` sends `sha` on `PUT /pulls/N/merge` so
GitHub rejects a moved head.

Merge approval also requires a **review receipt**: a fresh, non-interactive
reviewer session pinned to that exact head SHA that printed `VERDICT: CLEAR`
or `VERDICT: BLOCK` as its last verdict line. A missing `VERDICT` line is
not a receipt. `Safety.gate` returns `review_required` until a CLEAR
receipt for that SHA is on the worker; the receipt is written to audit.
`evaluateMergeGate` refuses the GitHub merge without it.

`observe` workers cannot reach these actions; the gate refuses before an
approval is even opened.

### 9.3 Secrets

P4 work. Until then: the worker never receives a raw secret. Instabox Org
Secrets (placeholder in the box, header on the proxy) are assumed available
and must be confirmed against the plan. The isolation model already forbids
vendor keys in the box.

### 9.4 Tenancy

- Every Super-agent API takes `tenantId` as an explicit argument, not from
  the event body.
- `listWorkers(tenantId)` cannot return another tenant's rows.
- Sandbox acquire is already `tenantId`-keyed in `@maka-cloud/boxes`.
  Super-agent passes that id through `SandboxPort` metadata.
- One box per invite at launch (`isolation-model.md` §8). Super-agent does
  not invent a shared pool.
- Billing: `MeteringHooks.record({ tenantId, workerId, tokens, usdMicros,
  wallMs, at })`. No prices. T17 / a billing.md later.

## 10. WorkspaceStore and the LayerFS spike

```ts
interface WorkspaceStore {
  readonly kind: 'git-clone' | 'layerfs';
  prepare(spec: WorkspaceSpec): Promise<WorkspaceHandle>;
  snapshot(handle: WorkspaceHandle): Promise<SnapshotRef>;
  exportPatch(handle: WorkspaceHandle): Promise<string>;
  release(handle: WorkspaceHandle): Promise<void>;
}
```

`GitCloneStore` is the default. It clones (or, in tests, clones a local
repo), snapshots with `rev-parse`, and exports `git diff` so a crash cannot
lose a kept change.

`LayerFsStore` is compiled, **off**, and does not start a server, FUSE, or
Docker. It records branch/commit/fork metadata and throws
`LayerFsMountUnsupportedError` on a live mount. That is as far as P1 goes.

### 10.1 Spike plan (from the signed-off page, tightened)

The existing gates in `docs/fork/design/layerfs.md` stand. Run them on
**Instabox**, not boat.dev.

| Gate | How | Pass | Fail |
|---|---|---|---|
| 0. Device | One disposable Instabox: `/dev/fuse`, `docker info`, fs is ext4/xfs/btrfs | all three | stop, write the reason into `layerfs.md` |
| 1. Isolation | Every invariant in `isolation-model.md`; agent account has no `CAP_SYS_ADMIN`; from a container, 169.254.169.254 and RFC1918 are refused | all refused | stop. FUSE privilege that exceeds the model is a stop. |
| 2. Gain | maka-cloud + one other real repo: wall time to first test, disk per task, vs clone+install (~9.5 min today) | ≥3× first-test | keep the interface, drop the adapter |
| 3. Correctness | Two workers fork one baseline and edit the same file → conflict, not overwrite; `kill -9` the daemon → `exportPatch` still complete | both | fix or stop |

LayerFS Store is Disposable (WAL, `synchronous=OFF`). Official guidance: not
the only copy. Kept changes waiting for the owner are **also** a plain
patch. Maka's append-only step log stays the record of truth; a LayerFS
commit id is a pointer in that log.

Pin a release in `docs/fork/THIRD_PARTY.md` only if gate 0–3 pass and code
is taken. Android / hi: never.

## 11. Sandbox (Instabox, not boat.dev)

```ts
type SandboxPort = Pick<
  /* InstaboxClient, and #452 SandboxApi */
  { ensureRunning; exec; getMachine; createSnapshot; deleteSnapshot;
    waitForSnapshot; putActivityLease; deleteActivityLease },
  /* those names */
>;
```

Workers on that box share **one host process** (`BoxDaemon`). Each worker
is a lightweight session (worktree cwd, env, `AbortController`), not a
new maka process. Per-session RSS is a small fraction of the ~232–278 MiB
idle maka process baseline.

`BoxPool` gives each tenant **one** long-lived Instabox box (mandate size,
default 4/8192) shared by up to N workers (default 4). Admission still
caps spend. Each worker execs with cwd `/work/<workerId>` (a git worktree
of a cached base clone) and its own env (`npm_config_cache` is shared).
Cross-worker paths are refused. Secrets stay on the host.

Lifecycle: an activity lease is held and renewed while any worker is
active. When all are idle, leases drop and the box suspends after 5
minutes (or Instabox auto-suspends). `deleteAfterSeconds` is only a 7-day
backstop, not a 30-minute kill. The next event `ensureRunning` / wakes
the box and reports progress phase `waking` with the measured time. A
gone or erroring box rebuilds from the latest base snapshot (taken after
the base install), else a fresh create.

Box id, state, and last wake/suspend times live in store JSON (a reserved
retired worker row). No sqlite `user_version` bump. A box stuck in
`suspending`/`resuming`, or a lease that was not released, is W-rule
`box_stuck`. Cold create, wake, and snapshot-restore timings go on
`usage_events` as `__box__:create|wake|restore`.

The API key stays on the host. Isolation model I-series still apply. Super-agent
does not add a second egress path. LayerFS stays off.

T32 (own computer) is after launch and is another `SandboxPort`. Not in P0–P3.

## 12. Failure modes and recovery

| Failure | Detection | Recovery |
|---|---|---|
| Host process dies | Exclusive lock released; next process `restore()` | Workers in `running`/`waking` keep inbox; executions fenced by T28 epoch |
| Second host on same file | `SuperagentDatabaseInUseError` | Refuse. Same as duties/supervisor. |
| Handler throws | W1 | Restart ≤3, then escalate |
| Box dead | `getMachine` error / exec fail | New execution, same worker; transcript from mirror (T28) |
| LayerFS store lost | N/A until spike | `exportPatch` already on the side; step log intact |
| Duplicate webhook | unique `(tenantId, idempotencyKey)` | `duplicate`, no second worker |
| Two Routers race to spawn | unique live subscription | second spawn `already_owned` |
| Prompt injection in an issue | T15 taint on the conductor path; Super-agent `fields` are quoted | No grant from issue text |
| Worker over budget | W4 | Stop, no restart |
| Approval text edited | byte compare | refuse; new row |
| Tenant A id in tenant B event | API takes tenant from the host session, not the payload | ignored / 404 |
| Upstream sync conflict | Super-agent is a new package | cheap; only `package.json` / lock / AGENTS.md fork delta |

## 13. Observability

Minimum counters (log lines or a future metrics port):

- `ingest_total{source,result=stored|duplicate|rejected}`
- `route_total{path=passthrough|router,decision}`
- `router_judge_calls` (the ablation number)
- `worker_state{state}`
- `watchdog_findings{rule}`
- `approval_total{kind,state}`
- `usage_tokens` / `usage_usd_micros` per tenant and worker

Audit log is the human-readable trail. Do not put `fields` bodies into
metrics labels.

## 14. Rollout (P0–P5)

Effort is in subsystems, not calendar time. Each phase has an exit test.

### P0 — one live Instabox run, queue hygiene

**Exit:** one real coding task on a scratch repo: brief → Instabox → tests →
cross-vendor review → PR → CI green, under the spend cap. `#452` can merge
for the seam; boat PRs stay parked. `#460` merge with autofix off is
useful but not required for Super-agent P1.

Not this package. Owner keys and DNS. Super-agent must not block it.

### P1 — events, subscriptions, workers (this implementation)

**Code:** `@maka-cloud/superagent`: normalize, subscription table, Router,
worker state machine, sqlite + memory stores, watchdog, safety hooks,
`WorkspaceStore` + git default, LayerFS adapter without a server.

**Exit tests (in-package, fakes only):**

1. A CI failure on a subscribed PR is delivered to that worker;
   `judgeCalls === 0`.
2. The same Trigger twice creates one worker.
3. Process restart from sqlite resumes the inbox and the durable plan.
4. A looping handler produces a W3 finding within the injected clock.
5. `merge` / `push_protected` / `secrets` / `deploy` without a matching
   grant leave the worker `awaiting_approval`.
6. Tenant A cannot read tenant B's worker.

**Not in P1:** host wiring, model judge, LayerFS mount, billing, conductor
tool changes.

### P2 — Mandate defaults, T33 stuck report as code, duties as a Source

Wire Intake behind duties' `readDelivery`. Host `startStack` creates one
`Superagent` and ticks the watchdog. Escalations become supervisor items
in the T33 shape. Heuristic judge can be replaced by a cheap model behind
the gateway.

**Exit:** a fake runner that spins is a stuck card in N minutes; a comment
from a non-allowed actor does not spawn.

### P3 — WorkspaceStore in runners + LayerFS spike

Removed again: nothing on the coding path called the fleet's
`WorkspaceStore` or `prepareHostWorkspace()`; sandbox clones are
`CLONE_SCRIPT`. `WorkspaceStore` stays in `@maka-cloud/superagent`, and
`@maka-cloud/runners` no longer depends on that package.

### P4 — paid layer

Per-tenant usage ledger is package-local SQLite (`usage_events` in
`superagent.db`, schema 2). Additive; **does not need a cloud-server
migration**. Org Secrets: `OrgSecretPort` plus `EnvOrgSecrets` (env / JSON
file; never returns a raw secret). `UnconfiguredOrgSecrets` remains the
default inside the core until the host or local loop passes the env
implementation. Workers emit evidence blocks. Inline & Spill keeps
`worker.memory` under 4k and stores older chunks on `WorkerRecord.spills`
(json column, no schema bump). Pricing stays unimplemented unless the
owner picks a provider.

### P5 — optional hi evaluation

Out of this repo. Interface only (`HiDevicePort` / `OffHiDevice`). Default
off. No remote unlock. Cloud-originated payment stays
`approval_unavailable`. See `docs/superagent/p5-hi-device.md`.

## 15. What is implemented vs stubbed

Filled in by the implementation PR; kept accurate here:

| Piece | Status |
|---|---|
| Event normalization (GitHub, chat, timer) | implemented |
| Event log + idempotency | implemented |
| Subscription table + pass-through | implemented |
| Router admission + `HeuristicJudge` | implemented |
| `ModelJudge` | injectable `JudgeClient` + `FetchJudgeClient`. Superagent constructor stays heuristic (no keys). `createJudgeFromEnv` uses ModelJudge with a heuristic prefilter when a key is present; `=heuristic` / `=model` force one path. Decisions log `confidence` and source. Optional read-only `RouterInspect` (`git log`, CI URL) |
| Worker state machine, inbox, sleep/wake/retire | implemented. `paused` is a first-class state (existing `state` column; no schema bump) |
| Durable memory / plan / transcript pointer | implemented |
| Sqlite restore | implemented |
| Watchdog W1–W6 | implemented. W2 nudges once before escalate; `waiting` in memory/plan is exempt |
| Drain coalesce | implemented: one handler call per backlog; `approval_granted` wins |
| Spawn admission | `maxBoxes` (live sandboxRef workers) and `spendCapUsd` (tenant ledger) before spawn |
| Mandate + approval gate + audit | implemented. Merge also needs a CLEAR receipt at the head SHA |
| Tenant scoping | implemented |
| Metering hooks | implemented; P4 append-only tenant ledger in `superagent.db` (`usage_events`, schema 2). **No cloud-server migration** |
| Org Secrets | `OrgSecretPort`; `UnconfiguredOrgSecrets` default; `EnvOrgSecrets` for local/env. Never returns a raw secret |
| Evidence blocks | `HandlerResult.evidence` → worker output / stuck card |
| `WorkspaceStore` + `GitCloneStore` | implemented in `@maka-cloud/superagent` only; runners and the coding playbook do not use it |
| `LayerFsStore` | metadata adapter; live mount throws; no env flag selects it |
| `SandboxPort` | interface + `FakeSandbox` + `HttpSandbox` (Instabox HTTP). `createSandboxFromEnv`: fake when no key; throws if key without `INSTABOX_MACHINE_ID`; live when both set. Contract-tested against a mocked HTTP server |
| Host / duties / conductor wiring | P2: `startStack` creates one in-process Superagent; duties `readDelivery` is the GitHub Source; watchdog escalations are T33 stuck cards. Host passes `instaboxSandboxPort`, `EnvOrgSecrets`, `createJudgeFromEnv` |
| Local loop | `npm ci` + `npm run build -w @maka-cloud/superagent` + `npm run local-loop -w @maka-cloud/superagent`. CI smoke: `local-loop.test.ts` with fakes |
| Live Instabox smoke | `npm run live-smoke -w @maka-cloud/superagent` (env `INSTABOX_API_KEY`; template defaults to `universal`). Creates 2 vCPU / 4096 MiB, `echo live-smoke`, always deletes. Not run in CI |
| Real loop | `CodingLoopHandler`: repo is materialized **in the box** (public `git clone`, or host tarball for private/scratch). Host-side coder files are written in the box; install/test run in the box; `git diff --cached` is pulled back and applied to a clean host checkout before publish. CLI prints per-phase timings, Messages API input/output tokens + estimated USD (ledger), and box exec stdout/stderr/exit. Empty GitHub repos seed `main` when `MAKA_CLOUD_LOOP_SEED=1`. Checks/Statuses with no runs are `no-checks`. Merge approval binds the head SHA; `PUT /pulls/N/merge` sends it; ungreen / empty / all-skipped checks refuse unless `mandate.allowNoCi`. Live GitHub stops at merge-held. `npm run real-loop`. Live only with `MAKA_CLOUD_LOOP_LIVE=1` + keys (never in CI) |
| Metrics harness | `npm run metrics -w @maka-cloud/superagent -- --n 3 --parallel 2 --out /tmp/sa-metrics`. FakeSandbox only. JSON + markdown: success rate, time-to-green, humans, $/PR, wasted Router wakeups |
| `#460` follow-up engine | not copied; `FollowUpBridge` only |
| `#452` InstaboxClient adapter | structural; used when host passes a client |
| Pricing | not implemented (owner must pick a provider) |
| Inline & Spill / Chain of Recall | implemented (`spillMemory` / `recallMemory`; spills on worker json, no schema bump) |
| P5 hi device | interface + `OffHiDevice` only; not wired |
| Speculative silent fix | not implemented (explicit non-goal) |
| Done-signal contract | implemented. Kinds: merged / closed / published / command / file / url. Unpushed work refuses retire. Applies to PR, issue, and conversation subjects |
| Review receipts | implemented. `FakeReviewer` in tests; hosts inject a non-interactive reviewer. Missing VERDICT = no receipt |
| Owner pause | implemented. Verified stop, no W2 nudge, explicit resume only |
| Freshness + lead channel | implemented. `reportToLead` re-reads live PR/CI; `LeadPort` is the only user channel; worker `userMessage` is dropped |
| First-class progress | implemented. Named phases on worker JSON; ETA from phase samples / usage ledger / defaults; lead speaks on phase change, every 5 min on a long phase, and once when past ETA+margin (W1/W2); waiting on CI/review/human ≠ stuck. CLI `npm run status`; JSON/SSE `GET /v1/superagent/progress` |
| Scheduler / admission queue | implemented. Task queue between Router spawn and worker. Priority + aging, size, deps, footprint conflict, reserved human slot, async start. States on ledger + `queue` in the progress snapshot. JSON document, no schema bump. See `docs/superagent/scheduler-router.md` |
| Two-layer tunable Router | implemented. Fast Path (deterministic, zero model) then Slow Path (cheap router model) for new threads only. Modes off/observe/auto; observe is the new-tenant config default. Feedback few-shots. Per-layer drop metrics. Subscribed threads pass through with no Slow Path. `triggerId → threadId → workerId` recall query |
| Cross-source merge + graded escalation | implemented. Programmatic same-ticket merge (path / fingerprint / ref / commit) then optional fuzzy Slow Path; observe suggests, auto attaches, split undoes. Cheap value/urgency/risk score; low archives, medium assigns, high is a waiting-human card on the progress snapshot. See `docs/superagent/intake-merge.md` |

## 16. Open questions — decisions recorded (revisit with the owner)

Taken from the defaults already in this document. Revisit if the owner
overrides them.

1. **Instabox through launch.** Yes. boat.dev PRs stay parked. P0 still needs
   the owner's Instabox credentials and DNS.
2. **One live owner per subject.** Keep. A reviewer worker on the same PR is
   not added in P2.
3. **Stop then later comment.** A later human comment starts a **new** Mandate
   (this doc), not DSH resume of the withdrawn one.
4. **Instabox Org Secrets.** Not assumed. Local/env `EnvOrgSecrets` is
   available; a real Instabox org-secret injector still needs the owner.
5. **Unowned `issue_opened`.** Spawn at `observe` (P1 heuristic). A standing
   duty is not required.
6. **Host wiring.** Same stack process, exclusive sqlite next to the server
   dir (`superagent.db`). Not a side process.
7. **CI runner.** GitHub-hosted remains the default. Super-agent tests stay
   in the ordinary workspace lane.

## 17. Attribution

- Article and prototype: DeepSeek Harness team; Yujia Qiao et al. MIT
  prototype. Concepts used: two-level Router/Worker, Trigger / Thread /
  Subscription pass-through, Mandate, Eval gate + assessment, Ticket
  lifecycle, compute/state/environment split, external Watchdog. No
  prototype source files are copied.
- LayerFS: Ephemeral AI Lab, MIT. Interface only in P1.
- MAGI: realTaki, BUSL-1.1. Restart cap and default-zero-spend background
  work as ideas. No code.
- maka-cloud isolation, approvals, T28, duties, supervisor, #444, #452,
  #460: this fork, already in-tree.
- [dori-superagent](https://github.com/sisyphuslabs/dori-superagent) (MIT,
  sisyphuslabs). Ideas only: verifiable completion, review receipts, owner
  pause, freshness, lead-only voice. No dori source is copied. See §18.

## 18. Lessons from dori

Source, ideas only (no code copied):
[sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent)
README, `src/harness.ts`, `src/store.ts`, `prompts/*.md`,
`skills/dori-mode/references/{done-protocol,sessions}.md`, and
`scripts/src/{done-flow,pause,freshness,host-guard,heavy-slot}.ts`.

dori is a production harness on herdr + omo: one lead session talks to the
human, each task is a lane, READY needs evidence, merge needs a CLEAR
review receipt at the exact head plus green checks. The five rules below
are now structural in `@maka-cloud/superagent`, not prompt text.

### 18.1 Verifiable completion

A worker `done` is a **claim**. `HandlerResult.done` is stored on the
worker and is not retirement. `verifyDone` re-reads a Done-signal
contract before the worker may retire:

| Kind | Live check |
|---|---|
| `merged` | PR is merged and a merge SHA is present |
| `closed` | Issue (or thread subject) is closed |
| `published` | Package + version is on the registry the host injected |
| `command` | Exit 0, optional stdout match |
| `file` | Path exists; optional sha256 / JSON path |
| `url` | HTTP status (default 200) and optional body match |

An empty signal list or empty evidence string is refused. If the claim
names a `workspaceDir` and `DoneWorld.unpushed` reports dirty or unpushed
commits, retirement is refused. This applies to **non-PR subjects**
(Q&A and research conversation threads use `file` / `url` / `command` /
`closed`) the same way it applies to a pull request.

Default `DoneWorld` only reads the local filesystem and `git` status.
Hosts inject `pull` / `issue` / `published` / `command` / `fetch`.

### 18.2 Review receipts

A merge approval is invalid without a receipt. `Superagent.review` (and
auto-review when a merge is proposed) runs a **fresh, non-interactive**
`ReviewerPort` pinned to `{ repo, number, sha }`. The last line matching
`VERDICT: CLEAR` or `VERDICT: BLOCK` becomes the receipt. **No VERDICT
line means no receipt** — the reviewer's prose is not enough.

`Safety.gate` on `merge` returns `review_required` until
`hasClearReceipt(receipts, repo#n, sha)`. `evaluateMergeGate` and
`HttpGitHost.merge` / `FakeGitHost.merge` refuse without a CLEAR receipt
at that exact SHA. The receipt is appended to `worker.reviewReceipts` and
audited as `review_receipt` or `review_no_verdict`. A later push changes
the SHA, so the old receipt no longer matches.

### 18.3 Owner pause

`paused` is a first-class `WorkerState` (same sqlite `state` column; no
schema bump). `Superagent.pause`:

1. Refuses when `mandate.ownerPause === false`, or when the worker is
   retired.
2. If the worker has a sandbox, reads `getMachine`. A still-running box
   is asked to `suspend`, then re-read. Still running → `box_still_running`.
3. Without a box, `spawning` / `running` / `waking` → `still_active`.
4. Records `pausedFrom`, `pausedVerified: true`, audits `paused`.

Drain returns immediately on `paused` (inbox stays queued). The watchdog
skips W1–W3 nudge/escalate while paused (subject-closed and over-budget
still apply). **Only `Superagent.resume` ends a pause.** Resume restores
`pausedFrom` unless that would jump back into an executing state, then
drains.

### 18.4 Freshness

The lead must not report cached worker memory as current. `reportToLead`
re-reads live facts (`liveFacts` hook and/or `DoneWorld.pull`) and
compares them to `worker.lastLive`. A moved head, changed CI, a PR that
merged since the last report, or a snapshot older than 15 minutes is
flagged `STALE` in the lead message and in audit (`lead_report`).

### 18.5 Lead-only-speaks-to-human (structural)

This is not a prompt rule.

- `WorkerContext` has no `LeadPort` and no `speak`.
- `HandlerResult.userMessage` is dropped and audited
  `worker_outbound_refused`. The lead is not called.
- Router `answer` and `reportToLead` are the user-facing paths; both go
  through `LeadPort.speak`.
- Tests inject `RecordingLead`. Production default is `SilentLead` until
  the host wires chat.

### 18.6 Remaining dori items (not implemented)

These stayed out of this pass. They are real gaps, not implicit next
work.

| dori piece | What it does | Why it is still a gap |
|---|---|---|
| Nudge at 10 / 20 / 40 minutes | Duty loop; escalate to the lead at 40 | We nudge once, then escalate. No timed schedule. |
| herdr pane status | Read idle/working/blocked/done before send or done | We have Instabox `getMachine`, not a pane agent-state. Busy-pane queue-until-idle is drain coalesce, not herdr. |
| LOST pane | Duty reports a vanished pane | No pane process to lose. |
| READY evidence links as a CLI gate | `dori ready` refuses without `--evidence` | We verify signals at retire time; there is no separate READY command. |
| Receipts on disk | `~/.dori/receipts/` | Receipts live on the worker JSON. |
| Full-text answer ledger | `Lane.final` / `Lane.log` | Evidence blocks + audit; no per-lane answer file. |
| host-guard | Refuse host-mutating lane commands | Isolation is Instabox + Mandate; no dori host-guard script. |
| heavy-slot | Serialize expensive jobs | Spawn admission is `maxBoxes` / `spendCapUsd`, not a heavy-slot queue. |
| 5-minute claim window | (sessions / done-flow) | Not ported. |
| dori telemetry | Anonymous OTLP counts | Out of scope; never send tenant text. |

### 18.7 Remaining DSH gaps

Diff of this document against
[DSH *000-philosophy*](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)
and the article / prototype mapping already in §1–§16.

Already aligned: two-level Router/Worker, subscription pass-through,
Mandate, external watchdog, observe-by-default, one live owner per
subject, honest merge/CI (now plus receipts), least-attention Router
(unowned events only).

Still open, on purpose or not yet built:

| DSH / article | Our state |
|---|---|
| Feishu (and other chat) Source | GitHub + in-process chat/timer only. Email/Slack/Feishu remain a non-goal (§1.1). |
| Router-turn batching of unowned Triggers | Unowned events are still judged one by one. Owned drain coalesces. |
| Panel that shows only what needs a person | No product panel. Stuck cards + pending approvals are the stand-in. |
| Written team-rule proactive work | We do not start work nobody asked for. There is no "record-only proactive" rule file. |
| One concrete question at a time | Approvals are bound-text; there is no structured one-question UX. |
| Reopen an ended Ticket under the same Mandate | Explicitly refused (§6 rule 6). |
| Admission `maxWorkers` default 3 | We have `maxBoxes` and `spendCapUsd`, not a global worker cap of 3. |
| Prototype `danger-full-access` on the operator OS user | We do **not**. Untrusted work stays in Instabox. |

No sqlite table migration in this pass. New data lives on the worker
JSON (`doneClaim`, `reviewReceipts`, `pausedFrom`, `pausedVerified`,
`lastLive`, `nudges`, `progress`). `paused` is a new value of the existing `state`
column. Flag if a later change needs `user_version` 3.

### 18.8 First-class progress

A 40–50 minute silent run looks stuck. Each worker carries a step plan
(`waking`, `materialize`, `edit`, `install`, `test`, `push`, `pr`, `ci-wait`,
`review-wait`, `merge-held`) on `worker.progress` (JSON only). The
runtime emits structured views: phase `k/N`, percent, elapsed, ETA
(median of completed phase samples on the tenant, else a weak mean of
`usage_events.wallMs`, else defaults), last activity, heartbeat.

The lead answers "how is it going" from that live snapshot after a
freshness re-read. It speaks on a phase change, every N minutes
(default 5) on a long phase (`still X, did Y`), and once when there is
no heartbeat or progress past the phase ETA plus a margin — the same
W1 heartbeat / W2 stall signals. Waiting on CI, review, or a human is
shown as waiting, not stuck; W2 skips it.

`npm run status -w @maka-cloud/superagent` prints a bar per live
worker. `GET /v1/superagent/progress` (JSON or `text/event-stream`) is
what cloud-server serves to cloud-web and mobile when the host injects
the snapshot.
