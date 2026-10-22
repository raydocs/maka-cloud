# What Grok Bot does, and what Maka takes from it

Grok Bot is xAI's desktop agent, built on Cursor's code (the package is named `sand`, carries
`@anysphere` packages and is signed by Anysphere). It is the closest shipped example of the runtime
Maka is building: an interface, a coordinator that keeps a conversation alive, and an executor that
runs tools. This note sets each of its runtime patterns beside Maka's code and says what to adopt.
It is the companion of `hark-patterns.md`: Hark is the reference for the feel, Grok Bot for the
plumbing. Both notes are for the coordinator and the lanes named under "Where".

## Source and limits

- **What was read.** A static inspection of the Grok Bot 0.75.0 desktop package, done in the
  owner's own workspace: formatted bundles, protocol descriptors, file names and native helper
  metadata. The app was not launched, no request was sent, and no account was used. Each statement
  below is about shipped code, not observed behavior. Code being present does not mean it runs.
- **What never enters this repository.** Cursor's or xAI's code, protocol descriptors, field
  numbers, endpoints, prompts or names. Every design below is our own and is built from Maka's
  existing pieces.
- Nine native helper files do not match the archive's declared integrity, and the cause is unknown.
  Nothing here relies on them.

## How Grok Bot is built

```
React UI ── preload bridge (context isolation, sandboxed renderer) ── Electron main
                                                                     ├─ coordinator process ── backend (durable commands, transcript)
                                                                     │                       └─ execution box gateway (low-latency events)
                                                                     └─ local execution daemon ── shell, files, computer use, device apps
```

- **The interface** never holds privileged execution. It asks the main process for a message port
  to the coordinator.
- **The coordinator** is a separate process. It owns the conversation connection, retries,
  command ids, transcript cursors and cancellation.
- **Two network planes.** A backend for durable user actions (send, status, transcript), and an
  execution-box gateway for live events and tools, with a health and an echo probe.
- **The local daemon** is a third process. It runs the shell, file transfer, computer use (a native
  helper spoken to over MCP on stdio) and device apps (Notes, Mail, Calendar, Reminders, Contacts,
  Messages).

Maka's split is the same shape, server-side: the web and phone clients, the server and conductor,
and the instabox sandbox. Nothing about the shape needs to change. The value is in the contracts
below.

## The patterns, against Maka

| # | Grok Bot | Maka today | Verdict |
|---|---|---|---|
| 1 | Durable send: accepted ≠ completed; ask "did you get it?" before resending | Server dedupes on `clientMessageId`; the client reuses the id across retries until the draft changes | **Have**; one small gap |
| 2 | Event stream with a stall watchdog, echo probes, reconnect backoff 1→10 s | Resume by `Last-Event-ID`, dedupe by id, backoff 0.5→10 s, server heartbeat every 15 s | **Gap**: no stall watchdog |
| 3 | Allow / ask / refuse by action class; standing grants per action and subject; a retirement list | Tool effects and run authorities (`cloud-conductor/src/guard.ts`); approvals bound to exact text | **Adopt**, folded into the grants of `hark-patterns.md` |
| 4 | Consent and OS sandbox checked by different owners; an unsupported sandbox fails, never falls back | Conductor guard plus instabox and the egress guard | **Have**; make it a tested invariant |
| 5 | Side effects with an "uncertain" outcome; no blind retry of a timed-out write | Opening a PR looks for one on the branch first, so a retry is safe | **Have for PRs**; adopt for merge and comments |
| 6 | A long shell command moves to the background and keeps its output | A check is one sandbox exec, at most 9.5 minutes | **Gap**: long test suites fail the check |
| 7 | A fresh screenshot after every computer action; a stale view is said to be stale | The computer is a human hand-over (watch, take over) | **Later**, if the agent drives the computer |
| 8 | Typed refusals: duplicate, refused, box hibernated | Sandbox sleep and wake exist (T26) | **Adopt** in the UI |
| 9 | Reads Claude Code's and Codex's local setup and history | — | **Never** |
| 10 | Default local shell policy is allow, unsandboxed, unless the server says otherwise | Everything runs in instabox | **Never**: default deny |

Each row is detailed below with the design, where it lands and its tests.

### 1. Durable send

**Grok Bot.** Every prompt carries a client nonce. The backend answers accepted, duplicate or
refused, and accepted only means durably queued, not done. After an eligible network error the
client asks for the send's status and resends only if the server has never seen it. A timeout alone
never triggers a resend of a turn that can run tools.

**Maka today.** `conversations.post` dedupes on `(conversation, clientMessageId)`, and the HTTP
answer is 202 with the message id. `ConversationFeed.send` and `ConversationStarter` keep the id
across retries until the draft is edited, so a retried send cannot start a second run.

**Gap.** The pending id lives in memory. If the page reloads after a lost acknowledgment, the person
sends again with a new id, and the message runs twice.

**Design.** Keep the pending `{conversationId, clientMessageId, text}` in session storage until the
202 arrives, and reuse it when the same text is sent after a reload. There is no status endpoint:
the dedupe already makes a resend safe.
**Where.** `cloud-client` (`conversation.ts`, `starter.ts`), T29 lane. **Tests.** A reload between
post and acknowledgment, then a send of the same text, gives one message on the server.

### 2. A stream that notices it went silent

**Grok Bot.** The coordinator kicks a watchdog on every byte received. When nothing has arrived for
the stall time (35 s by default), it probes the live stream before giving up on it, then reconnects
with backoff. "Connected" and "has every row" are two different states.

**Maka today.** `CloudClient.subscribe` resumes by `Last-Event-ID`, skips ids it has seen, and
backs off from 0.5 s to 10 s. The server writes a heartbeat every 15 s. The client does not check
for silence: a connection that hangs without closing (a sleeping laptop, a proxy holding the socket,
a phone switching networks) keeps showing **Live** and receives nothing.

**Design.** In `readEvents`, every chunk resets a timer of twice the heartbeat (30 s). When the
timer fires, abort the request, set the status to "Reconnecting…", and go through the existing
backoff. Show **Live** only after the first chunk of a new connection, not when the request starts.
Heartbeat comments count as bytes.
**Where.** `cloud-client/src/client.ts`, T29 lane; the status line on web and phone is the design
lane. **Tests.** A fake response that sends one event and then stalls is aborted within 30 s and
resumed from the last id. Heartbeats alone keep the connection open. The status does not say Live
during the stall.

### 3. Permissions: allow, ask, refuse, and grants that can be withdrawn

**Grok Bot.** One function decides allow, ask or refuse for each action. Actions fall into classes:
broad machine access (run a command, read or write a file), a per-target class (use this app, send
to this person), a settings class, and a one-shot class. A standing grant is stored per action, or
per action and target, and scoped to the account. A separate retirement list withdraws approvals,
so a cached approval cannot come back. In server-authoritative mode only the server's approval
counts. One gap is visible: grants carry a creation time but no expiry.

**Maka today.**
- Every tool declares its effects: `writes_outside_sandbox`, `sends`, `spends`, `irreversible`.
- Standing duties carry a run authority: `read-only`, `open-pr` or `merge-when-green`
  (`cloud-conductor/src/guard.ts`).
- Approvals are bound to their exact text and a precondition hash.
- A run that a person starts has no authority level of its own.

**Design.** This refines grants in `hark-patterns.md`, pattern 1.
- **A grant is a run authority for one repository**, offered from an approval card: `{grantId,
  owner, repo, authority, toolPattern?, scope: 'task' | 'repository', issuedAt, expiresAt,
  revokedAt?}`. It reuses `RUN_AUTHORITIES`, so a person's run in that repository gets the same
  authority a duty would.
- **Expiry is required.** A task grant ends with the task. A repository grant expires after 30
  days unless it is renewed from the card. Grok Bot's missing expiry is the lesson here.
- **Withdrawal is a separate append-only list.** Revoking appends `revokedAt` and the grant id is
  never reused. Every check reads the current list, never a cached grant.
- **Ask is always the answer** for `irreversible`, for `spends` over the cap, and for
  `writes_outside_sandbox` outside the egress allowlist, whatever grant exists. These classes are
  never offered a scope.
- **The server is authoritative.** Clients only show and request grants.

**Where.** Modes and cross-vendor review lane, with the supervisor. **Tests.** An expired grant
asks. A revoked grant asks on the next call, including in a run already going. An irreversible call
asks with any grant. A grant for one repository does nothing in another.

### 4. Consent and sandbox are two locks

**Grok Bot.** The permission decision and the sandbox policy are separate objects checked by
separate owners. When the requested sandbox cannot be provided, the call fails with an explicit
"sandbox unsupported" error and does not fall back to running unsandboxed.

**Maka today.** Consent is the conductor's guard and the approvals. Containment is instabox, the
sandbox user, and the egress guard, which recent PRs have hardened.

**Design.** Write the rule down and pin it with a test. If the sandbox, the egress guard or the
agent account cannot be confirmed, the run fails closed with a reason. No path runs task code on
the server host, whatever the approvals say. An approval never widens what the sandbox allows.
**Where.** Egress and secret hardening lane. **Tests.** With the egress guard missing, a run fails
before any task code runs. With an approval in hand and the sandbox unavailable, nothing runs.

### 5. Side effects whose outcome is uncertain

**Grok Bot.** A write that times out (mail, calendar, a message) is recorded as uncertain. The tool
says to check before retrying. Duplicate suppression keys every external send.

**Maka today.** `GitHubPublisher` looks for an existing pull request on the branch before it
creates one, and it compares an existing branch's commit before reusing it. A retried publish is
therefore safe.

**Design.** Apply the same rule to every GitHub write that C2 (CI autofix and merge) and C3
(GitHub intake) add.
- Before merging, read the pull request. If it is already merged at the expected commit, report
  success.
- Before commenting, look for the comment's marker. Each comment Maka writes carries a hidden
  marker with the task id.
- A call that times out is recorded as `uncertain`, never `failed`, and the next attempt
  reconciles first.
- The delivery record gains a `publishState`: `none`, `uncertain` or `done`.

**Where.** The C2 and C3 lanes. **Tests.** A merge that times out after GitHub merged it reports
merged once. A comment retried after a timeout appears once.

### 6. Checks longer than one exec

**Grok Bot.** A foreground shell command that runs past its time can be handed to the background.
It keeps its accumulated output, its stdin and its process, and reports when it ends. A hard limit
still stops it.

**Maka today.** A check is one sandbox exec, at most 9.5 minutes (`MAX_CHECK_MS`), because an
exec ends at 10. Real test suites
for many repositories take longer, so their check fails on time, not on the change.

**Design.**
- A check starts as a background job in the sandbox: a launcher writes its output to a file and
  its exit code to another.
- The runner polls the job, each poll a short exec, until it ends or the check's own limit is
  reached. The default is 30 minutes, set per repository.
- Polls feed the tests panel from `hark-patterns.md`, pattern 2.
- Cancelling the task kills the job.
- The verification record keeps what it keeps today: the last 8 KiB of output and the exit code.

**Where.** Coding playbook, with the instabox lane for the launcher. **Tests.** A 15-minute fake
suite passes the check. Cancelling during a check leaves no process behind. A job that never ends
is stopped at the limit and recorded as a timeout.

### 7. A fresh look after each computer action

**Grok Bot.** After every mutating computer action (click, type, drag) it captures a fresh
screenshot or app state. When the capture fails, the result tells the model to look again before
acting.

**Maka.** The computer is a human hand-over today. If the agent drives it later, adopt this
exactly: no action on a stale view. **Where.** A later lane.

### 8. Typed states instead of errors

**Grok Bot.** Sending distinguishes accepted, duplicate and refused. A hibernated box is its own
answer, not a generic failure.

**Maka.** Sandboxes sleep and wake (T26). When a message reaches a sleeping sandbox, the person
should see "Waking your workspace…" as a state, not a red error. Look at the HTTP and event paths
for any wake that surfaces as a failure, and give it a typed status.
**Where.** Server (T26 owner) and the design lane for the words.

### 9 and 10. What Maka must not do

- **Never read another tool's local setup or history.** Grok Bot ships code that reads Claude Code's
  and Codex's local setup and history (plugins, skills, projects, history), behind its file
  permission. Maka's conventions (C4) come from files in the repository the owner points at
  (`AGENTS.md`, `CLAUDE.md`, `.cursorrules` there), never from the owner's home directory. Maka
  never runs on the owner's computer anyway; keep it that way if a desktop app ever comes.
- **Never default to allow.** Grok Bot's local shell policy defaults to allow and unsandboxed
  unless the server sends something stricter. Maka's defaults are deny, sandboxed, and egress
  limited to an allowlist. A setting may narrow them, and nothing may widen them silently.

## Order

| # | Change | Size | Lane |
|---|---|---|---|
| 2 | Stall watchdog and an honest Live | small, client only | T29 (or the design lane, with the status line) |
| 3 | Grant shape: authority, required expiry, withdrawal list | folds into `hark-patterns.md` 1 | Modes, supervisor |
| 6 | Background checks with a longer limit | medium | Playbook, instabox |
| 4 | Fail-closed invariant and its test | small | Egress hardening |
| 5 | Uncertain outcomes for merge and comments | with C2 and C3 | C2, C3 |
| 1 | Pending send kept across a reload | small | T29 |
| 8 | Waking as a state | small | T26, design |

Items 2 and 6 come before the first paid evaluation run. A stalled stream would hide a run's
progress, and a 9.5-minute check limit would score real repositories on time instead of on their
changes.
