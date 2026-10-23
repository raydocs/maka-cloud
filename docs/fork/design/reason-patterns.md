# What Reason does, and what Maka takes from it

Reason is an agent product with three faces: a Mac desktop app, a command-line worker that ships
inside it, and a web app. Its one idea Maka lacks is that a conversation can run on the person's own
computer, against their own folders and tools, while the same conversation stays readable and
steerable from the web. This note sets each of its patterns beside Maka's code and says what to
adopt. It is the companion of `hark-patterns.md` (the feel) and `grok-bot-patterns.md` (the
runtime): Reason is the reference for **connecting the person's own computer**, the post-launch
task T32, "Connect your own computer", in `docs/fork/TASKS.md`.

## Source and limits

- **What was read.** A summary written by the owner's analysis tool from a static look at the
  shipped desktop app, its bundled worker and the public web client. Nothing was run, no account was
  used, no device was registered. Each statement below is about shipped code, not observed
  behavior; code being present does not mean it runs, and the server side was not seen at all.
- **What never enters this repository.** Reason's code, endpoints, header or field names, wire
  formats, interface text, file names, hashes, versions or addresses. This repository is public.
  Every design below is our own and is built from Maka's existing pieces.
- **Not Reason Network.** The open-source Reason Network code that `TASKS.md` already borrows from
  under its own licence is a separate thing. This note takes nothing from that code.

## How Reason is built

```
web app ──────────────┐
                      ├── server: one session record, a resumable event stream, presence
desktop app ──────────┘        │
  (hosted UI in a locked-down  │  operations, claimed by the worker (outbound only)
   window, a narrow bridge     │
   to the main process)        ▼
                        worker on the Mac ── confined runner (OS sandbox, granted folders only)
                                          ├─ host runner (only after explicit consent)
                                          └─ preview relay (dev-server ports, outbound tunnel)
```

- **The interface** is the same hosted web app in a browser and in the desktop window. The window
  gives it no general access to the machine, only a short list of named actions (connect, pick a
  folder, show a preview), each checked in the main process.
- **The worker** is a background process on the Mac. It never listens for connections. It dials the
  server, proves who it is, and claims operations one at a time.
- **The session** lives on the server. Which machine runs the work is a property of the session,
  not of the client looking at it, so a phone or a browser sees the same conversation.

Maka's shape is the same with the computer swapped: the web and phone clients, the server and
conductor, and an instabox box doing the work. A person's Mac is one more place work can run. The
value is in the contracts below.

## The patterns, against Maka

| # | Reason | Maka today | Verdict |
|---|---|---|---|
| 1 | Several permission layers, kept apart and explained apart | Conductor guard, kept approvals (#381), instabox isolation, egress guard | **Have** in the cloud; **adopt** the separation for a computer |
| 2 | A folder is granted through a one-time pick tied to the window that asked | No local folders | **Adopt** with T32 |
| 3 | Revoking a folder cancels queued and running work that needs it | Revoking a grant stops the next call (#381, #387) | **Gap**: work already running keeps going |
| 4 | The device dials out and signs every request | Boxes are reached by the server, never the other way | **Adopt** for a computer |
| 5 | Every operation carries a lease, an attempt, a fence and the grant revision it was issued under | Epoch fencing of task writes (T28) | **Have** the fence; **adopt** the lease and grant revision |
| 6 | Local work is confined by default; host access is a separate, explicit consent | Everything runs in instabox; default deny | **Have**; keep it on a computer |
| 7 | A preview relay that proves the port belongs to the task and refuses control ports | Link previews only (`cloud-server/src/previews.ts`); no dev-server preview | **Adopt** for T24 previews, cloud and computer |
| 8 | A resumable stream with separate cursors per kind; presence on its own channel | One event cursor with `Last-Event-ID`, stall watchdog (T4, #379); no presence | **Adopt** separate cursors when kinds grow; presence later |
| 9 | A session moves between cloud and the machine and keeps its conversation | Transcript mirror and resume on a fresh box (T28) | **Have** the base; **adopt** the move |
| 10 | Steering, a hard stop, and recovering a message that did not land | Steer and withdraw, cancel, pending send kept across a reload (#380) | **Have** most; **adopt** the two kinds of stop |
| 11 | Imports model subscriptions stored on the computer | — | **Never** |

Each row is detailed below with what Maka should do, where it lands and its tests.

### 1. Permission layers that stay distinct

**Reason.** At least five separate things decide whether a piece of local work may run: the
operation must belong to the session that asked; the folder must have a standing grant; the session
must be in confined or host mode; a few protected paths need their own, machine-wide exception; and
the operating system's own privacy permissions (full disk access and the like) must allow it. The
interface never folds them into one "allowed" switch. When something is refused, the message says
which layer refused it: a refusal by its own sandbox points to the device settings, an operating
system refusal points to the system's settings. A protected-path exception is worded as what it is,
a standing rule for every session on that machine, not a one-off.

**Maka today.** The layers exist and are separate: the conductor's guard and run authorities
(`cloud-conductor/src/guard.ts`), kept approvals per repository (#381, #382, #387), the taint hold
(T15), and containment by instabox and the egress guard. A refusal is reported as one generic
failure more often than it says which layer refused.

**What Maka should do.**
- Keep one owner per layer and never let one layer stand in for another. An approval never widens
  what the sandbox allows (`grok-bot-patterns.md` 4), and a folder grant never implies host access.
- Give every refusal a typed reason naming its layer: authority, kept approval, taint hold, folder
  grant, confinement, the computer's operating system. The card or task line says which one and
  where to change it, in plain words, and the change is never offered inline on an always-ask gate.
- Word each grant by its true reach: "for this task", "for this repository until you revoke it",
  "for every task on this computer". Settings lists them by layer.

**Where.** Conductor (refusal reasons), supervisor (card text), `cloud-client` and the design lane
(words), and the computer worker for its two local layers.
**Tests.** Each layer's refusal carries its own reason. No grant of one layer is accepted as
another. An always-ask gate never offers a widening.

### 2. Folder selection that cannot be forged

**Reason.** Granting a project folder is two steps. The desktop's own process shows the native
folder picker and returns a short-lived, single-use selection token, tied to the window that asked.
The page then turns that token into a grant. A page can therefore never name an arbitrary path and
have it granted; it can only redeem a choice the person just made in a system dialog. The path is
resolved to its real location before it is granted, and the worker checks the grant again on its
own side for every operation instead of trusting a path the server sent.

**Maka today.** No local folders. Repositories reach a task only by name, through GitHub.

**What Maka should do.**
- A folder is granted only from a native picker on the computer itself, never from text typed on
  the web or phone, and never from anything a model wrote.
- The picker's result is a one-time token, valid for minutes, bound to the signed-in person and the
  computer, redeemed once. The grant stores the resolved real path.
- Every operation names a grant by id; the worker resolves it locally and re-checks the real path,
  so a moved folder, a symbolic link or a `..` cannot reach outside it. The server never sends a
  path to trust.

**Where.** The computer worker and its small desktop shell (new `packages/cloud-computer`, see
T32), the server's grant store.
**Tests.** A replayed or expired token grants nothing. A token from another person or computer is
refused. A link inside a granted folder pointing outside it is refused at read and write.

### 3. Revocation that stops what depends on it

**Reason.** Removing a folder says plainly that new work can no longer use it and that queued or
running work scoped to it is cancelled, and that is what happens. A revoke is not only a filter on
the next request.

**Maka today.** Revoking a kept approval stops the next call that would have used it (#381, #387),
and a revoked invite ends its event streams (`cloud-server/src/http.ts`). A task already running
under a revoked grant keeps running until it next needs the grant.

**What Maka should do.**
- Every operation records which grants it depends on (folder, kept approval, host consent). A
  revoke finds every queued or running operation that depends on it and cancels them through the
  normal cancel path, in the same transaction that records the revoke.
- The task line says why it stopped ("Stopped: access to `app/` was removed"), and the confirm
  dialog for a revoke says beforehand how many running tasks it will stop.
- On the computer, the worker also refuses any operation whose grant revision is older than the
  one it holds (pattern 5), so a revoke made while it was offline still holds when it comes back.

**Where.** Conductor state (grant dependencies), orchestrator (cancel), server, computer worker.
Extends the kept approvals of #381 and #387.
**Tests.** Revoking a grant cancels a queued and a running task that need it and leaves others
alone. A worker that was offline during a revoke refuses the stale operation when it reconnects.

### 4. Outbound-only device connection with signed requests

**Reason.** The device registers once through a pairing handed over from a signed-in browser, then
holds a private key the system keychain can keep non-exportable. It never opens a listening port.
It reaches the server through a long-lived control connection, with plain requests as a fallback
that wait a bounded time for work. Each request is signed over the method, the path, a timestamp,
a fresh nonce, a server challenge and a digest of the body, so a captured request cannot be
replayed or altered.

**Maka today.** The server reaches boxes through instabox; nothing dials in. Clients authenticate
with session tokens (T31).

**What Maka should do.**
- The computer worker pairs once from a signed-in web or phone session (a short code or a link the
  person confirms), and generates its key on the computer, kept in the keychain where the platform
  allows. The server stores only the public key.
- The worker only ever dials out. Every request it makes is signed over method, path, time, nonce,
  a server challenge and a body digest; the server rejects old times, reused nonces and wrong
  digests.
- The computer appears in Settings as a device the person can rename and remove. Removing it
  revokes every grant on it (pattern 3).

**Where.** Server (pairing and verification), computer worker.
**Tests.** A replayed request, a reused nonce, a stale time and a body changed after signing are
each refused. A removed device's next request is refused and its running work is cancelled.

### 5. Operations that carry their own authority

**Reason.** A claimed operation carries an operation id, an attempt id, a lease with an end time,
the run it belongs to, the folder, the capability it needs, and an authority that names the target
generation, a fence and the revision of the folder grant it was issued under. The worker heartbeats
to keep the lease, sends events in order and checks the server's acknowledgement of the next
expected sequence, and stops when told to cancel. Before it reuses a prepared environment, it
checks that every one of those values still matches, so a stale target or an old grant cannot be
reused.

**Maka today.** T28's epoch fencing: each attempt to drive a task gets an epoch, every write
carries it and the log sequence it read, and a stale writer is refused at its first write
(`cloud-orchestrator/src/orchestrator.ts`, `steps.ts`). Box commands with side effects settle only
after the box confirms the process group is gone.

**What Maka should do.**
- Extend the operation a box or a computer runs to carry, beside the task epoch: an attempt id, a
  lease end, the grant revision it was issued under, and the capability it needs.
- A lease that is not renewed lets the server re-issue the operation to a new attempt; the old
  attempt's writes are refused by the fence, exactly as T28 does for drivers.
- Events from a box or computer carry a sequence the server acknowledges; a gap or a repeat is
  refused, never guessed.
- The worker refuses an operation whose grant revision is older than its own.

**Where.** `cloud-orchestrator` (step log, fence), `cloud-runners` (the operation contract),
computer worker. T28 owns the fence; this is its extension to devices.
**Tests.** An expired lease re-issued to a new attempt; the old attempt's late events refused. An
operation issued before a revoke is refused after it. Out-of-order events are refused.

### 6. Confined by default, host access by consent

**Reason.** The worker's default mode runs commands inside the operating system's own sandbox: deny
everything, then allow reading system and package-manager locations, reading the granted folder,
a private temporary directory, writing to the folder only when the grant allows writes, no
protected paths and no network. The environment is scrubbed of variables that could inject startup
code. A separate host mode, which unlocks a full shell, background jobs, terminals and previews,
needs the person's explicit consent. A field in its protocol that sounds like "full access" does
not by itself mean the sandbox is off; the modes are decided elsewhere.

**Maka today.** Everything runs in instabox; defaults are deny, sandboxed, egress on an allowlist
(`grok-bot-patterns.md` 10). An unsupported sandbox fails, never falls back.

**What Maka should do.**
- On a computer the default is confined: the platform's own sandbox, the granted folder only, no
  network unless the task's egress allowlist is enforced locally, a scrubbed environment, no access
  to the home directory, keychains, other tools' configuration or history.
- Host mode is a separate consent per computer, asked once with plain words about what it allows,
  shown on the device in Settings, revocable in one tap, and never offered from inside a task or by
  a model.
- If the platform cannot provide the sandbox (for example on a system where it is not available),
  the computer offers no confined mode and says so. It never falls back to host.
- Installed tools are used only where the sandbox lets them be seen; the task brief never promises
  that every tool on the computer will run.

**Where.** Computer worker (confined runner), Settings (host consent).
**Tests.** A confined command cannot read outside the folder, write without the write grant, open a
network connection, or read a scrubbed variable. Host mode is refused without consent. A missing
sandbox gives an explicit error, not a host run.

### 7. A preview relay that proves which port it serves

**Reason.** Two routes show a running dev server. In the desktop app, the page is drawn in an
isolated view in the window that can reach the machine's own loopback, with every permission
request refused. From the web, the worker opens an outbound tunnel and relays HTTP and WebSocket
traffic for one port at a time, with caps on size, streams and lifetime. Before it serves a port it
proves that the listening socket belongs to the process group of the task's own running job, under
a live lease, and it refuses its own control and relay ports. Each binding names the person, run,
device, folder, job, fence, grant revision and port, and expires.

**Maka today.** `cloud-server/src/previews.ts` fetches link preview images for pages a task
opened. T24 promises "Open preview" on a result card, but there is no dev-server preview yet, on a
box or anywhere.

**What Maka should do.**
- One preview relay for boxes and computers, served by our own address, authenticated by the
  person's session. The browser never gets a box's provider address or a computer's address.
- A preview is bound to a task, its attempt and fence, the grant revision, one port and an expiry.
  The worker or box helper serves it only if the port's listener belongs to that task's process
  group and the task is still running under a live lease.
- Only unprivileged ports, never the worker's, the box helper's or the relay's own ports, never a
  raw TCP tunnel: HTTP and WebSocket only, with caps on body size, concurrent streams and lifetime.
- The preview stops when the task ends, the lease lapses, the grant is revoked or the computer
  goes offline, and the card says which.

**Where.** Server (relay and auth), `cloud-instabox` or `cloud-boxes` (the box side), computer
worker (the computer side), T24 (the "Open preview" action and the result card).
**Tests.** A port another process listens on is refused. A control port is refused. A preview of
another person's task is a 404. After cancel or revoke, the next preview request fails.

### 8. A resumable stream, and presence on its own channel

**Reason.** The session stream is a server-sent event stream fetched with authorization. It starts
with a snapshot, then sends sequenced deltas. A reconnect resumes with a separate cursor for each
kind of thing it carries (events, logs, messages) plus signatures for the derived state, and falls
back to a full snapshot when the resume is too long or a signature is missing. A stall timeout and
token refresh are built in. Presence (who else is looking, typing, which page) is a different,
ticket-authenticated socket with its own backoff, and it is not the message record.

**Maka today.** T4's stream resumes from one `Last-Event-ID` across all event kinds, the client
dedupes by id, and #379 gives up a silent connection and only says Live after bytes arrive. There
is no presence.

**What Maka should do.**
- Keep one log-backed cursor while one log is the source (T28 already serves only written events).
  When kinds with their own retention arrive, such as long tool output or computer logs, give each
  its own cursor rather than mixing them into the conversation log.
- A resume that is too old or too long returns a snapshot of the current view and a fresh cursor,
  never a partial replay.
- Presence, when it comes, is its own channel and never decides what is in the conversation. Its
  first use is "the computer is online", which the person needs before choosing it for a task.

**Where.** `cloud-server` and `cloud-client` (T4 and T29 lanes).
**Tests.** A resume after a log trim gets a snapshot, then deltas, with nothing missing or doubled.
Presence going down changes nothing in the conversation.

### 9. Moving a session between cloud and computer

**Reason.** Where a session runs is a setting of the session: cloud, or a given Mac and folder,
with the work either in place or in a separate worktree. Moving it to the cloud is confirmed with a
plain account of what happens: the folder's commits and uncommitted changes are copied up, the
Mac's folder is left as it was, and the cloud uses the workspace's own secrets instead of the
computer's credentials. The conversation continues; only where the work happens changes.

**Maka today.** T28 mirrors the agent's transcript into the server and resumes a session on a fresh
box after a lost box, a sleep (T26) or a move between boxes (T27). Work always runs in the cloud.

**What Maka should do.**
- The run target is a field of the task: a box, or a computer and folder grant. Changing it is a
  T28 resume on another target: wipe the agent's config on the target, upload only the mirrored
  session, resume the same session by id, with the recovery note.
- Moving to a box copies the work as a branch (commits plus a commit of uncommitted changes),
  never the computer's credentials; the box uses the invite's own connections. Moving back applies
  the branch in a separate worktree on the computer, never over the person's uncommitted work.
- The confirm card says what is copied, what stays, and which credentials the target will use.

**Where.** `cloud-orchestrator` (target and resume), `cloud-runners` (the target behind
its `SandboxProvider` seam in `src/types.ts`), computer worker, T24 card.
**Tests.** A move keeps every message and the session id. Uncommitted changes arrive as a commit.
Moving back never overwrites a dirty folder. No computer credential reaches a box.

### 10. Steering, hard stop and message recovery

**Reason.** A message sent while work runs can be delivered as a steer into the running turn. Stop
has a gentle and a hard form. A message that did not land can be recovered, and recovery may point
to the continuation where it was picked up. Drafts are kept on the client and are not confused with
the server's record.

**Maka today.** Steer and withdraw a steer (`cloud-runners/src/steer-receipts.ts`, the server's
steer routes), cancel, pause and resume, and a pending send kept across a reload (#380). One cancel.

**What Maka should do.**
- Two stops: **Stop after this step** (finish the running step, then end) and **Stop now** (kill
  the process group; the step log records an interrupted `never` step as uncertain, as T28 says).
  On a computer, Stop now must also kill the confined process tree and close any preview.
- A message that the server holds but no turn picked up is shown as not delivered, with **Send
  again** (same id, so the dedupe holds) or **Discard**. A steer withdrawn before delivery is
  dropped, as today.
- Drafts stay client-side and are never mistaken for sent messages.

**Where.** Orchestrator and runners (two stops), `cloud-client` and design lane (states).
**Tests.** Stop after this step lets the step finish once; Stop now leaves no process and marks the
step. A re-sent message is applied once.

## What Maka will not copy

- **Locally stored model subscriptions.** Reason's setup offers to read model credentials and
  subscription sign-ins already stored on the computer and import them into its service. Maka
  reaches models with API keys only (`AGENTS.md`, "Product constraints"), never with a
  subscription and never with credentials read from the person's computer. The computer worker
  never reads another tool's configuration, keys or history (`grok-bot-patterns.md` 9).
- **A worker whose default is wide.** Host mode stays an explicit, revocable consent per
  computer; confined is the default and the only mode a task can be given without asking.
- **The desktop window as the product.** Maka's clients stay the web and phone apps. The computer
  side is a small worker with the least interface it needs (pairing, folders, consent, status).

## Order

| # | Change | Depends on | Lane |
|---|---|---|---|
| 3 | Revocation cancels dependent work (kept approvals first) | #381, #387 | Conductor, orchestrator |
| 10 | Two stops; undelivered message state | T28 | Orchestrator, runners, design |
| 7 | Preview relay for boxes | T24, T26 | Server, instabox, design |
| 1 | Typed refusal reasons per layer | none | Conductor, supervisor, design |
| 8 | Snapshot on stale resume; separate cursors when needed | T4, T28 | Server, client |
| 2, 4, 5, 6, 9 | T32, "Connect your own computer" | launch, T28, T26 | New lane, after launch |

Items 3, 10 and 7 help the cloud product on their own and come first. The rest is one task, after
launch.
