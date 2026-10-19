# T9 — conversation workspace

React web app, entirely inside `packages/cloud-web`. One conversation brings
together messages, a live nested task tree/current step, per-task cost so far,
recommended-first decision cards, pause/resume/cancel, reports/diffs/PR links,
and opt-in background Web Push. It reuses `packages/ui`'s public `ChoicePanel`
implementation and the existing Astryx design system without changing either.

**The complete UI runs against a local mock. The merged server only implements
the base API below. Extensions are explicit integration contracts, not claims
that the server already supports these capabilities.** No provider, paid run,
real API key, real push service, or unrelated task is needed to run the demo/tests.

## Run and verify

This is deliberately a standalone package: root workspaces, lockfiles, CI and
other packages are out of scope. From the repository root, with Node 22+:

```sh
npm --prefix packages/cloud-web ci --workspaces=false
npm --prefix packages/cloud-web run demo
# Local mock/demo uses port 4173 and the non-secret demo-invite fixture.
npm --prefix packages/cloud-web run build
npm --prefix packages/cloud-web test
npm --prefix packages/cloud-web exec -- playwright install chromium
npm --prefix packages/cloud-web run test:e2e
```

Alternatively set `CHROME_PATH` to an installed Chromium executable; Playwright
does not download a browser in that case. `npm run check` inside this package
runs build, components/client tests and Playwright. Mock Playwright starts its
own dev server if needed; do not run another mock browser concurrently, since
the deterministic fixture is shared/reset between tests.

`npm run dev` is the non-mock entry: enter an invite token (memory only).
Serve `dist/` and the authenticated API on the same origin, with HTTPS for Web
Push. This package does not configure or start the real cloud server. Mock
middleware and its `/__mock/*` controls exist only with `CLOUD_WEB_MOCK=1` in the
development server; they are not part of the built client or production API.
Vite/TypeScript resolve `@maka/ui` to the existing public ChoicePanel source so
this scoped package does not need the desktop package graph built first.

## Verified merged base contract: T4 #21

[PR #21](https://github.com/raydocs/maka-cloud/pull/21) merged on 2026-10-19 as
[`8ea4b8f`](https://github.com/raydocs/maka-cloud/commit/8ea4b8f1f9fd26b73e83c76d1df7a63756d0e19c).
The actual merged `packages/cloud-server/src/http.ts`, `feed.ts`,
`conversations.ts`, and `packages/cloud-orchestrator/src/types.ts` were read and
aligned after merge. [`src/contract.ts`](src/contract.ts) separates these base
types from proposed extension types. Every route, including SSE, uses
`Authorization: Bearer <invite>`; never put credentials in URLs or local storage.

| Route | Request → response |
| --- | --- |
| `POST /v1/conversations` | Optional `{title}` → 201 `{conversationId}`. |
| `GET /v1/conversations` | 200 `{conversations:[{conversationId,title,createdAt}]}`, oldest first. |
| `POST /v1/conversations/:id/messages` | `{text,clientMessageId?}` → 202 `{messageId}`; client ID makes retry idempotent. |
| `GET /v1/conversations/:id/tasks?after=&limit=` | 200 `{tasks:TaskView[],next?:number}`. Global task-creation cursor, default limit 50, capped at 200. |
| `GET /v1/events?conversation=&after=` | Authenticated fetch SSE, filtered by conversation. |

The mock uses these same paths/statuses/payloads, distinct task-log sequences
and feed positions, message idempotency, task pagination, SSE replay/header
precedence and comment heartbeats. It is not a replacement for server tests:
SQLite persistence, quotas, stream backpressure and invite administration are
server responsibilities, not simulated infrastructure guarantees.

```text
id: <feed position, not task seq>
event: <kind>
data: <JSON below>

conversation.created  {conversationId,title,at}
message.posted        {conversationId,messageId,role:"user",text,at}
task.event            {conversationId,seq,at,event:TaskEvent}
```

`Last-Event-ID` wins over `?after=`; replay returns strictly later positions.
The client preserves the last applied feed ID across reconnects and ignores
duplicate positions. A fresh view replays from zero (there is no GET messages
route). `TaskView.progress`'s last note is the current step. Base task states
remain queued/running/succeeded/failed/cancelled; pause and cost do **not** get
silently added to base TaskView. A missing cost is “Not reported”, never zero.

## Extension integration / upstream blocker table

These are **documented proposals** implemented by the mock and typed client.
T5 PR A [#27](https://github.com/raydocs/maka-cloud/pull/27) is merged: its
`cloud-conductor/src/outbox.ts` supplies the exact message/question/answered/
notice fields below, and `conductor.ts` defines the UserAnswer body/result.
No identifiable T5 PR B was available in the inspected open/all T5 PR list at
implementation time. **Its HTTP response and SSE envelope names still need
confirmation**; do not mistake the proposed names for an existing transport.
The answer URL is the requester-specified T5 PR B integration URL.

All extension routes use the same invite authentication. IDs/references are
URL-encoded. Pending owners must confirm authorization, persistence, replay
and mutation semantics server-side before production rollout.

| Extension | Proposed wire contract used here | Responsible upstream work / status |
| --- | --- | --- |
| Discovery | `GET /v1/capabilities` → 200 optional booleans `taskCancel,taskPause,answers,artifacts,taskCost,push` | Server integration; concrete follow-up task ID **pending upstream confirmation**. |
| Assistant message | SSE `conductor.message` → `{conversationId,runId,text}` | T5 PR B server implementation of the conductor outbox; payload verified in merged PR A, event name proposed. |
| Decision | SSE `conductor.question` → `{conversationId,runId,questionId,reason,question,options:[{id,label}],recommended}`; reason is `taste\|budget_overrun\|irreversible` | T5 PR B; payload verified, envelope proposed. UI independently moves recommendation first. |
| Answer | `POST /v1/conversations/:id/answers` `{questionId,optionId,text?}` → 200 `{accepted:true,duplicate:boolean}` or `{accepted:false,reason}`. Conflicts may return 409. SSE `conductor.answered` → `{conversationId,runId,questionId,optionId,text?}` | T5 PR B. Request/outbox fields and onAnswer result verified in PR A; HTTP mapping/event name proposed, to confirm against B. |
| Notice | SSE `conductor.notice` → `{conversationId,runId?,text}` | T5 PR B; payload verified, envelope proposed. |
| Cancel | `POST /v1/conversations/:id/tasks/:task/cancel` `{}` → 204; then base task cancellation events | Server/orchestrator integration, concrete follow-up task ID **pending upstream confirmation**. Server owns descendant semantics. |
| Pause/resume | `POST /v1/conversations/:id/tasks/:task/pause` `{paused:boolean}` → 204; SSE `task.paused` `{conversationId,taskId,paused}` | Server/orchestrator integration, concrete task ID **pending upstream confirmation**. No invented base “paused” state. |
| Spend | SSE `task.cost` `{conversationId,taskId,costUsd}`; cumulative **direct** task cost, excludes descendants to avoid double counting | Server/conductor accounting, concrete task ID **pending upstream confirmation**. Must replay latest cumulative values. |
| Artifact retrieval | `GET /v1/conversations/:id/artifacts?ref=<manifest reference>` → 200 `{kind:"report"\|"diff"\|"pr",title,content?,url?}` | Server artifact store/access control, concrete task ID **pending upstream confirmation**. No browser access to internal filesystem/session credentials. |
| Web Push | `GET /v1/push/config` → 200 `{applicationServerKey:<base64url public key>}`; `POST /v1/push/subscriptions` with browser `PushSubscription.toJSON()` → 204 | Server registration, tenant binding and background completion delivery; concrete task ID **pending upstream confirmation**. Worker expects pushes only for completed tasks. |

### Clean degradation, no fake success

Discovery `false` hides that feature immediately. Older servers return 404/405
for discovery; capabilities remain unknown and an action may be tried once.
Any feature endpoint returning **404 or 405** hides its controls for the current
connection and reports “No change was made”. Neither response marks a task
paused/cancelled, records an answer, loads an artifact, or enables notifications.
Other failures remain retryable errors. Pause/cancel state changes come from
events; answers are acknowledged only after an accepted response or answered
event. Server-side semantic rejection never becomes a local answer.

The current merged T4 server lacks every extension in this table. That is a
production integration blocker owned outside this PR, **not** a blocker on
delivering the complete mock-driven UI under the updated T9 scope. No other
package was edited to simulate server support.

## Presentation and notification safety

Every displayed untrusted string passes the same presentation filter, including
messages, titles, task progress/errors, decision labels, artifacts, user drafts
and accessible names. Known model/vendor names (including the five explicitly
forbidden by T9) are suppressed after Unicode normalization. Artifact content
is inert text, not injected HTML. Links require HTTPS, no embedded credentials,
and no forbidden names in the decoded URL; internal references stay invisible.
This is a presentation policy, not a general-purpose secret-redaction system.

Push is an actual service-worker registration/subscription flow, not an
SSE-triggered foreground notification. The worker ignores all server-derived
notification text/URLs and shows a generic completion notification; clicking it
focuses a same-origin window or opens `/`. Browser permission/subscription and
server registration must all succeed before “enabled” appears. A failed
registration unsubscribes a newly-created browser subscription.

## Verification evidence

- Build/typecheck: `npm --prefix packages/cloud-web run build`.
- Components/client: `npm --prefix packages/cloud-web test` — 8 tests.
- Mocked Playwright: `npm --prefix packages/cloud-web run test:e2e` — 20 tests
  across desktop and 390px touch-emulated Chromium. Checks decisions, task
  controls, live completion, artifacts, cost, SSE Last-Event-ID/replay,
  conversation isolation, failed-send draft preservation, name suppression in
  text/a11y/URLs, and **404 and 405** control degradation/no false success.
- Push tests stub only browser push transport and notification presentation:
  real worker registration/HTTP registration, page closed, synthetic hostile
  completion delivery at the real worker boundary. This proves local worker
  behavior, **not external Web Push delivery**.
- [`evidence/`](evidence/) retains inspected desktop/phone, answered/paused,
  artifact and degraded states plus a real-pointer interaction clip for GitHub
  handoff. Phone rendering is Chromium emulation, not a physical device.
  Package-local `.gitattributes` excludes only this review evidence from source
  release archives, matching the repository's visual-evidence convention; all
  application, mock and test source remains included.
- Root CI does not install/test this standalone package; green root CI alone
  is not T9 acceptance. Package-local commands and evidence are required.

This replaces the original documentation-only blocker on the same branch and
[PR #28](https://github.com/raydocs/maka-cloud/pull/28). Actual merged #21 was
checked; no polling, schedule, external review, provider run or deployment was
used. Previously stopped unrelated tasks remain stopped.
