# What Hark does, and what Maka takes from it

Hark is the reference for how Maka should feel. This note says how Hark is built, pattern by
pattern, and turns each pattern Maka lacks into a design for our own code. It is for the
coordinator and the lanes that own the pieces named under "Where".

## Source and limits

- **What was read.** The public Android package of Hark Pro 1.0.0-36, looked at without running it:
  its manifest, library list, and the class and type names that survived the build's shrinking.
  No method bodies were recovered and none were looked for. Each statement below about Hark
  comes from names, not from a trace of the running app. The iOS app was seen only as a user.
- **What never enters this repository.** Hark's code, prompts, assets, typeface (GT Standard is
  licensed), sky data, endpoints, keys or hostnames. This repository is public. Each design below
  is our own and is built from Maka's existing pieces.
- **No further decompiling.** It is not needed for any design here, and Hark's terms very likely
  forbid it.

## How Hark is built

| Layer | Hark | Maka today |
|---|---|---|
| App shell | Native: Kotlin and Jetpack Compose on Android, a shared native core on iOS | Expo (React Native) for both phones, React and Vite on the web |
| Server-drawn widgets | A small embedded React Native runtime that draws only the widgets inside Home cards | None |
| Sections | Home, Assistant, Projects, Settings | Home, Chat, Projects, Settings |
| Home | A card feed the server owns: list, order, seen | Built on the client from the inbox, finished tasks and schedules (`HomeFeed`) |
| Look | Glass via a blur library; a sky backdrop generated from the real time of day and place | Glass tokens (`packages/cloud-design`), a fixed sky gradient |
| Conversation | A stream of typed events: messages, narration, tool panels, pauses | Messages, task events (`task_progress` is free text), questions, inbox items |
| Pauses | Approvals laid out as a document with choices and a scope; secrets, connector logins, identity checks | Questions with `reason` and a held `action`; approval bound to its exact text and a precondition hash |
| Notifications | Push with Approve and Deny actions, resolved without opening the app | Generic web push: fixed text, no server content, no actions (`cloud-web/public/sw.js`) |
| Extras | Dictation as its own stream; link safety check before opening; onboarding prompts from the server | None of these |

The expensive parts of Hark (the native shell, the generated sky) are polish. The parts that make it
feel calm and trustworthy are structural, and Maka can build them in its own stack. Those are
patterns 1 to 4 below.

## 1. Approvals that say how far they reach

**Hark.** An approval is a small document, not a yes or no string: sections (text, fields,
attachments, a banner), choices, and a scope for how far the yes reaches.

**Maka today.** `Question.action` holds the call. The card shows the exact text and the call's
arguments, the answer is bound to that text and the precondition hash, and an approval that cannot
be shown exactly cannot be approved (`questionCardModel`, supervisor R1). Every yes is for once.

**Design.**
- An approval offers up to three scopes. **This once** is today's yes. **For this task** covers
  calls with the same tool and argument pattern until the task ends. **For this repository** covers
  them until the owner revokes it.
- A wider yes is stored as a **grant** (its exact shape, with required expiry and a withdrawal list,
  is in `grok-bot-patterns.md` pattern 3): owner, repository, tool, an argument pattern (exact values
  or a closed set, never a free wildcard), scope, created at, expires at, and revoked at. The
  conductor checks grants before it asks. A call a grant covers runs and is logged with the grant
  id, so the transcript says why nothing was asked.
- Grants never cover the gates that stay human at every level: spend over a cap, egress outside the
  allowlist, deleting a branch or repository, merging when CI is not green, or anything the playbook
  marks always-ask. The scope choices are not offered on those cards.
- The card becomes sections with fixed slots: what will happen (the exact text, unchanged), what it
  touches (repository, branch, files), the held call (exact), the evidence (proof line, diff stat,
  review result) and the scope choice. Binding is unchanged: the exact text and the precondition
  hash. The scope chosen is part of the answer and of the hash.
- Settings lists the grants per repository, and each can be revoked in one tap. A reverted
  auto-merged change revokes that repository's merge grant (see `autonomy.md`, level 2).

**Why first.** This is the autonomy levels from `autonomy.md` in mechanism form. Level 2 ("merge
its own hands-off changes") is a repository grant for `merge` that only the scorecard can offer.

**Where.** Modes and cross-vendor review lane (grants and the conductor check); supervisor (answer
shape, scope in the hash); `cloud-client` `questionCardModel`; web and phone cards (design lane).
**Tests.** A grant covers only its pattern. An always-ask gate never shows a scope. Revocation stops
the next call. The scope is in the hash, so a replayed answer with another scope is refused.

## 2. Narration and live tool panels

**Hark.** The reply, a separate "what I'm doing" narration strip, and a panel per tool are three
different objects. Panels exist for shell output, web search, file writes, and coding work with a
validation report. Each panel updates in place and can be stopped.

**Maka today.** A task has `progress: string[]`, filled from free-text `task_progress` notes and
shown as one "Current step" line. The live computer view (watch and take over) exists for tasks
with a desktop. A coding task's real phases (clone, reproduction test, implement, checks, review,
fix) are known to the coding runner, but they reach the person only as words.

**Design.**
- Two new task events from the runners, with the same seq and owner rules as the others:
  - `task_narration` `{taskId, line}`: one short present-tense line ("Running the tests again after
    the fix"). It replaces the current step line. Notes stay for history.
  - `task_panel` `{taskId, panelId, kind, state, title, summary, tail?}`. `kind` is `shell`,
    `tests`, `diff`, `review` or `search`. `state` is `running`, `passed`, `failed` or `stopped`.
    `summary` is fixed per kind, for example "41 passed, 1 failed" for tests, "+12 −3 in 2 files"
    for a diff, "0 P1, 2 P2" for a review. `tail` is the last lines, at most 40 lines and 4 KiB.
- The coding runner emits panels at its phase boundaries, so no model writes the summary. The tests
  panel reads the check's own result, and the review panel reads `review.json`'s counts.
- Every panel is a **reader copy**: scrubbed with the transcript reader scrub, capped, never
  replayed to a model, never used as evidence. The proof stays `verification.json`.
- Web: the task card in the chat shows the narration line and a row of panel chips (`Tests ✓ 41`,
  `Diff +12 −3`, `Review 0 P1`). Tapping a chip opens the panel. A failed panel turns its chip red
  and says so in the narration line. Phone: the same chips, with the panel as a sheet.
- A panel for a running shell can offer **Stop**. It maps to the existing task stop, not a new
  control.

**Why.** It is the "watch it work" promise in onboarding step 3, and it is where Maka's verification
lead becomes visible. Seeing the reproduction test fail and then pass is the product.

**Where.** Coding playbook (emit), orchestrator and server (event types, replay),
`cloud-client` (`TaskView.panels`, `narration`), web and phone (design lane).
**Tests.** Panel summaries come only from check results. The scrub runs on `tail`. Caps hold. A
replayed event stream rebuilds the same panels. No panel text reaches a model.

## 3. Answer from the notification

**Hark.** Push carries Approve and Deny actions and resolves an approval without the app open.

**Maka today.** Web push is generic on purpose: fixed text, no server content, no URL from the
server. Approvals bind to their exact text, which the person must see.

**Design.** Keep both rules. Add actions only where answering does not need the exact text.
- **Phone app first** (`expo-notifications` categories; the token stays in the secure store):
  - `finished`: **Got it**
  - `suggestion`: **Not now**
  - `approval` and `decision`: **Not now**, which snoozes, and **Open**
  - There is no Approve action. Approving opens the card, because the exact text is the approval.
- The notification carries only the item id and kind. The app fetches the item, checks its
  precondition hash, and answers with the usual `answerId`. A changed item opens instead of
  answering.
- Web push stays generic. A service worker holding a token to answer is a larger attack surface
  than this is worth.

**Where.** T29 phone lane, plus the server push sender (kind and item id only).
**Tests.** No action sends an approve. A stale hash opens the item instead of answering. A
notification never shows server text.

## 4. Home cards the server owns

**Hark.** The server sends Home as ordered cards and keeps their order and what was seen. The agent
can put a card on Home beside the chat.

**Maka today.** `HomeFeed` builds Home on each client from the inbox, finished tasks and schedules.
The order is code, "seen" is the browser's last visit, and the employee cannot place a card.

**Design.**
- `GET /v1/home` returns ordered cards `{cardId, kind, ref, rank, seenAt}`, where `kind` is
  `waiting`, `suggestion`, `finished`, `scheduled` or `note`, and `ref` points at the inbox item,
  task or duty. Also `POST /v1/home/seen` and `POST /v1/home/order` (the owner moves a card).
- The server ranks: waiting first, then suggestions, then finished since the last seen, then what
  runs next. "Seen" moves to the server, so web and phone agree.
- A `note` card lets the employee say one fact outside a conversation, for example "PR #42 merged,
  CI green". It needs a template, not free model text, and the same quoting as the supervisor.
- `HomeFeed` stays as the fallback against a server without `/v1/home`.

**Where.** Server and supervisor (T28 lane), `cloud-client`, web and phone Home.
**Tests.** Ranking is stable. Seen is per owner. Another owner's cards never appear. Note cards are
template-only.

## Later

- **Sky by time of day.** Pick the background tokens from an hour band, our own palette in
  `packages/cloud-design`. No generated sky data.
- **Dictation.** On-device speech into the composer (iOS and Android system recognizers) before any
  server stream.
- **Link check.** `publicLink` already allows https only. A reputation check is a later option.
- **Onboarding prompts from the server.** The starters are fixed today. Later T30 can propose
  starters from the repository itself.
- **A native shell.** Not planned. Expo with the glass effect is the right trade-off at Maka's size.

## Order

| # | Pattern | Depends on | Lanes |
|---|---|---|---|
| 1 | Scoped approvals and grants | the launch-path fixes | Modes, supervisor, design |
| 2 | Narration and tool panels | coding runner phases (built) | Playbook, server, design |
| 3 | Notification actions on the phone | phone app on main | T29, server |
| 4 | Server-owned Home cards | none | T28, design |

Patterns 1 and 2 come before the first paid evaluation run. A level-2 grant is what the scorecard
unlocks, and the panels are how a person sees a run go well or badly without reading logs.
