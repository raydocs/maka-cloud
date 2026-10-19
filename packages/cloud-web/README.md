# T9 web app — blocked on the public API

Status: **not implemented**. This directory currently preserves the contract
inspection and delivery blocker, not a working app or a mock implementation.

The T9 implementation is restricted to `packages/cloud-web`. The delivery
instruction explicitly requires stopping if completing the scope needs changes
elsewhere. Do not invent API routes or events in a mock to make missing server
capabilities appear implemented.

## Contract inspected

The source is [T4 PR #21](https://github.com/raydocs/maka-cloud/pull/21), still
open when inspected, at
[`abe9f0d`](https://github.com/raydocs/maka-cloud/commit/abe9f0d69f61ef90f35de0023b29c9891dd26e0b).
This is a proposed contract, not evidence of a merged API.

All public routes, including SSE, require `Authorization: Bearer <invite>`.
The exhaustive dispatcher is
[`http.ts`, lines 118–147](https://github.com/raydocs/maka-cloud/blob/abe9f0d69f61ef90f35de0023b29c9891dd26e0b/packages/cloud-server/src/http.ts#L118-L147).

| Route | Request and response |
| --- | --- |
| `POST /v1/conversations` | Optional `{title}`; 201 `{conversationId}`. |
| `GET /v1/conversations` | 200 `{conversations: [{conversationId, title, createdAt}]}`; oldest first. |
| `POST /v1/conversations/:id/messages` | `{text, clientMessageId?}`; 202 `{messageId}`. Repeated client IDs return the original message without emitting another event or invoking the handler again. |
| `GET /v1/conversations/:id/tasks?after=&limit=` | 200 `{tasks: TaskView[], next?: number}`. Creation-order cursor; default limit 50, maximum 200. |
| `GET /v1/events?conversation=&after=` | SSE, optionally filtered to one conversation. |

SSE framing is `id: <feed position>`, `event: <kind>`, and JSON `data:` followed
by a blank line. The feed position is distinct from a task-log `seq`.
The exact JSON shapes come from
[`feed.ts`](https://github.com/raydocs/maka-cloud/blob/abe9f0d69f61ef90f35de0023b29c9891dd26e0b/packages/cloud-server/src/feed.ts)
and `frame()` in `http.ts`:

```text
conversation.created: {conversationId, title, at}
message.posted:       {conversationId, messageId, role, text, at}
task.event:           {conversationId, seq, at, event: TaskEvent}
```

Resume returns positions strictly after `Last-Event-ID`; `?after=` is the
fallback, and the header wins if both are present. Replay starts at zero by
default. Streams send comment heartbeats, not application events. A browser
client needs an authenticated fetch stream (or another explicitly supported
authenticated transport), not a native EventSource with credentials in the URL.
Preserve the last applied feed ID on reconnect; reconstruct message history by
replaying the feed because there is no GET messages route. The upstream
[`sse.test.ts`](https://github.com/raydocs/maka-cloud/blob/abe9f0d69f61ef90f35de0023b29c9891dd26e0b/packages/cloud-server/src/__tests__/sse.test.ts)
covers resume and header precedence; those tests were read, not run here.

## Requirements versus available capabilities

The authoritative task shapes are
[`types.ts`](https://github.com/raydocs/maka-cloud/blob/abe9f0d69f61ef90f35de0023b29c9891dd26e0b/packages/cloud-orchestrator/src/types.ts).
The event union contains only creation, start, progress, success, failure,
cancel-requested and cancelled events. Task states are queued, running,
succeeded, failed and cancelled.

| T9 requirement | What the inspected contract supports / lacks |
| --- | --- |
| Conversation messages | Stored user messages can be replayed. `ConversationStore.post()` hard-codes the user role; the handler port has no assistant-message publishing method. Assistant replies need an additional server publishing path. |
| Live task tree and current step | `parentTaskId`, state and free-text progress notes support a tree and latest progress. There is no structured current-step field; do not invent one in the mock. |
| Report, diff and PR artifacts | Success manifests have optional `artifacts: string[]`. Safe public links can be rendered, but there is no typed report/diff payload or authenticated artifact-content route. Server-local paths cannot be fetched as web artifacts. |
| Recommended-first `ask_user` cards | No structured question/options/recommendation event, pending-question state, or answer operation. Ordinary user messages do not define a structured decision protocol. |
| Pause and cancel running tasks | No public mutation route for either. The internal MCP `task_cancel` tool needs a session token; invite tokens are not those tokens. Session credentials are intentionally retained server-side. Pause is also absent from task states/events. |
| Task cost so far | Neither TaskView nor TaskEvent supplies cost or usage. Missing cost is not zero. |
| Web push on background completion | No push-subscription registration, public push key, or delivery service. An SSE-triggered notification only works while the page is running and does not implement background Web Push. |
| No model or vendor names in UI | Client-side responsibility. Apply to all displayed server-derived messages, titles, progress, failures, manifests, artifacts, URLs, accessible names and notification text, not just static labels or the runner field. |

These are contract gaps, not requests to edit the server from this branch. The
internal orchestrator MCP endpoint is not a browser-facing workaround: T4's
[`cloud-server.ts`](https://github.com/raydocs/maka-cloud/blob/abe9f0d69f61ef90f35de0023b29c9891dd26e0b/packages/cloud-server/src/cloud-server.ts)
only gives its session-token rotation capability to the conductor handler.

## Delivery and resumption

This work stops at the scope boundary and is delivered as a Draft PR. No
other package, root workspace configuration, lockfile, workflow, or guidance
file is changed. No app, component tests or Playwright tests exist yet; no
visual, 390px layout, push or functional acceptance is claimed. No live
providers, keys, sandboxes or paid runs were used.

This Amp thread has an enabled, supported PR-comments subscription for #21,
which also delivers merge events. No polling or scheduled job was created.
The continuation is owned by
[the T9 thread](https://ampcode.com/threads/T-01a1534f-9658-7745-a151-19e183f00ade);
the requesting
[Puck thread](https://ampcode.com/threads/T-01a148c3-0255-77b4-bfa5-59c35ae3712b)
receives the Draft PR and blocker.

After #21 merges, inspect the actual merged dispatcher, feed payloads and task
types rather than assuming this snapshot is unchanged. If the gaps remain,
report them and keep this PR blocked: merging #21 alone is not evidence that
T9 became implementable. The smallest external action is to assign the missing
public capabilities to their server/orchestrator owners, or explicitly reduce
T9's acceptance scope; neither is authorized by this branch.

If the merged API supplies the required capabilities, continue on this one
branch/PR, rebase on main, build the React app and faithful local mocks, reuse
`packages/ui` where suitable without editing it, and run component tests and
Playwright, including SSE resume, untrusted-content name suppression, controls,
decisions, background push and 390px no-horizontal-scroll coverage. Inspect
rendered desktop/phone and interactive states. Record verification in the PR.
Merge only the completed T9 PR once CI is green and required repository gates
are satisfied; do not merge #21 or bypass protections.
