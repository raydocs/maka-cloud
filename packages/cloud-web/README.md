# T9: conversation workspace

React web app, entirely inside `packages/cloud-web`. The first screen is one
sentence: the user types what they want done, and the conversation starts. From
there one view holds the messages, the live task tree with its current step,
the cost so far, recommended-first decision cards, pause/resume/cancel, and the
results of finished tasks (reports, changes, pull-request links). It reuses
`packages/ui`'s public `ChoicePanel` and the Astryx design system without
changing either.

The app speaks to the real `packages/cloud-server` API and nothing else. There
is no mock server: tests start the real server (SQLite in a temporary
directory, the real orchestrator and event stream) with a fake runner as the
only "model", so no key, provider, paid run or network is involved.

## Run and verify

Needs Node 22+. The tests start the built server and orchestrator, so build
those once from the repository root after `npm ci`:

```sh
npm --workspace @maka-cloud/orchestrator run build
npm --workspace @maka-cloud/server run build
npm --prefix packages/cloud-web ci --workspaces=false
npm --prefix packages/cloud-web run check      # build, vitest, Playwright
```

- `npm test` runs the component tests and `tests/integration/real-api.test.ts`,
  which drives the client and the event reducer against the real server.
- `npm run test:e2e` runs Playwright (desktop and a 390px touch-emulated phone)
  against the real server and the dev server. Install a browser with
  `npm --prefix packages/cloud-web exec -- playwright install chromium`, or set
  `CHROME_PATH` to an installed Chromium.
- `npm run stack` starts only the test stack (real server on port 4174, a
  control API on 4175 that plays the conductor and the runners). With it
  running, `CLOUD_WEB_API=http://127.0.0.1:4174 npm run dev` serves the app on
  port 4173 and proxies `/v1` to the server, so the page and the API share an
  origin. The control API prints nothing secret; it exists only in the test
  stack.

Against a deployed server: serve `dist/` and the API on one origin (HTTPS, for
Web Push later) and enter an invite token. The token lives in memory only.

## The API the app uses

Every route needs `Authorization: Bearer <invite>`, including the event stream
(fetch-based SSE, since `EventSource` cannot send the header). An object another
invite owns answers 404, the same as one that does not exist.

| What | Route |
| --- | --- |
| Conversations | `GET`/`POST /v1/conversations` |
| Say something | `POST /v1/conversations/:id/messages` `{text, clientMessageId}`: a retry with the same id is one message |
| Task list | `GET /v1/conversations/:id/tasks?after=&limit=` |
| Pause, resume, cancel | `POST /v1/tasks/:id/(pause\|resume\|cancel)` |
| Results | `GET /v1/tasks/:id/artifacts` (names and kinds), `GET /v1/tasks/:id/artifacts/:index` (a link as JSON, a file as an attachment) |
| Answer a question | `POST /v1/conversations/:id/answers` `{questionId, optionId, text?}` |
| Notifications | `GET /v1/push/key` → `{publicKey}`; `POST`/`DELETE /v1/push/subscriptions` with `{endpoint, keys:{p256dh, auth}}` / `{endpoint}`. All three are 404 until the server has its signing key |
| Live updates | `GET /v1/events?conversation=` with `Last-Event-ID` |

Event frames the view uses: `message.posted` (role `user` or `assistant`),
`task.event`, `conductor.notice`, `conductor.question`, `conductor.answered`.
The view is built from the replayed stream (a fresh view replays from the
start; there is no "list messages" route) and reconnects with the last event id.
After a task ends or a stop is owed, it reads the task list once more for the
flags only the server works out (`costUsd`, `budgetExceeded`,
`treeStopPending`).

What the UI does with the answers:

- **Cost.** Spend is recorded on the top-level task and covers its subtasks
  (`costUsd` on the view, `totalCostUsd` on `task_cost` frames). Subtasks show no
  cost of their own. A task that has not reported shows "Not reported", never
  zero, and a total over only some tasks says "not all reported".
- **Stops.** A task whose run is not known to have stopped (`stopPending`,
  `treeStopPending`) says it is still stopping and that the cost may change.
  `budgetExceeded` says the budget was reached.
- **Control errors.** `409 pause_unsupported` hides Pause for that task;
  `409 invalid_state`, `404`, `429` and the answer codes (`conflict`, `not_open`,
  `closed`, `unknown_option`) each get a plain sentence. Nothing is shown as
  done until the stream says so, except an answer the server accepted.
- **Revoke.** A 401 on any request or on the stream returns to the invite screen
  and drops everything held for the conversation.

## Presentation safety

Every untrusted string (messages, titles, task text, decision labels, artifact
names and contents, drafts, accessible names) passes one filter
(`src/presentation.ts`) that suppresses known model and vendor names after
Unicode normalization. The server scrubs error text the same way, and never
sends the runner id. Artifact content is inert text, never HTML. Links need
HTTPS, no credentials, and no forbidden name once decoded. This is a
presentation policy, not a secret-redaction system.

A result is never described as checked or verified by this app: it shows what
the server and the runner sent, and nothing it infers.

## Needs you (inbox)

The server's supervisor raises items that need a person: a finished task to
acknowledge, and approvals, budget and other decisions. The app shows them in
the conversation under "Needs you (n)", most urgent first, from the
`inbox.item` frames of the same event stream. An item the supervisor already
raised as a conversation question is shown once. Each card shows the
supervisor's sentence exactly as sent (the app adds, infers and rewords
nothing, so "(independently checked)" or "(not independently checked)"
appears only when the supervisor wrote it, and is absent when the server has
no verification configured), its evidence, and its options with the
recommended one first and filled. An answer carries the item's
`preconditionHash` and a client-chosen `answerId` that a retry reuses, so a
double click or a dropped connection answers once. A refusal (`stale`,
`already_answered`, `stopped`, ...) is shown in words and the refreshed item
the server sent with it replaces the card. Answered items move to a "Done"
list. The server publishes item changes on its maintenance tick (15 s by
default), so the app applies the answer's response at once and the stream
confirms later.

## Not done yet

- **Web Push is wired to the server's routes** and tested end to end against the
  real server with a throwaway signing key and a fake transport (nothing
  leaves the machine). The browser's own push transport is stubbed in the
  Playwright tests, so a real browser receiving a real message is not verified.
  The registration state is held for the session only: after a reload the
  button shows again, and registering again is harmless. On a server without
  push the button is replaced by a plain sentence.
- **Inbox settings, mutes and digest** answer 404 on the server until they are
  stored per owner; the app does not call them.
- Conversations created before the owner column exist stay hidden until
  `cloud-server conversation adopt` runs.
- Root `ci.yml` does not install or test this package (its dependency versions
  differ from the root workspaces). `.github/workflows/fork-cloud-web.yml`
  builds the server, then runs this package's build, vitest and Playwright
  suites on every pull request and on main.
