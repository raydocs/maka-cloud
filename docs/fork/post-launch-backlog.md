# Post-launch backlog

Findings about anything that is **off at launch** (the box pool, proposed cards, the plan vault; see
`docs/fork/launch-notes.md`) or that a first user does not touch go here, not into a fix pull
request. They are taken up after the first live run, one small pull request each, with a test that
fails on main.

Rechecks before launch look only at what a first user touches: one sandbox machine per invite, the
model gateway, approvals, the inbox, restart and backup. A finding outside that is added here with
its source and left alone.

How to add an item: one line of what is wrong, where, the test that would show it, and where the
finding came from. Keep the order within a section as the order to do them in.

## Box pool (`MAKA_CLOUD_BOXES`, off)

From the T27 review rounds. The pool is unreachable while `MAKA_CLOUD_BOXES` is unset.

1. R17 #1 to #3: `acquire` can return a refused box; a refused box is not swept; sleep and restore
   ignore another task's label.
2. R14 #2: a task owns its box across phases; sub-runs only borrow it.
3. R18 #6: a deleted leftover box blocks builds.
4. A6: quota race and acquire abort; shutdown waits for in-flight creates.
5. Scrub A1 to A4: git run as the control user (fsmonitor), the scrub list and content check,
   unreadable directories, setup descendants.

## Snapshots

1. R16 #3: parse snapshot ownership strictly.
2. R16 #4: recheck the box state before deleting a recovered lost box.

## Plan tokens and the plan vault (T27, not wired)

1. Plan-token PRs 9b and 9c (9a, the vault, is merged but imported by no server package).
2. A per-invite design for the user's own Claude or ChatGPT plan on several boxes; needs the pool
   first.

## Proposed cards (T30, `MAKA_CLOUD_CARDS`, off)

In the order to do them when cards come next, or before `MAKA_CLOUD_CARDS` is turned on anywhere:

1. P1: scrub card text at the `CardStore` write boundary (propose and refresh, re-check the length
   after), and before cutting in `candidates.ts` `outside()` and in `toCard` facts.
2. P1: recovery (`maintain()`, the supervisor's retry of `decide`) must re-check project access, the
   kind switch and the full precondition before starting an accepted card that has not started; look
   up the idempotent start first; changed content needs a new tap.
3. P1: a failed refresh in `reconcile` (`scan.ts`) must fail verification, not count as fresh. P2: the
   hash covers the title and the head SHA. P2: `cards.expire()` is scoped to the owner and project in
   a project scan (a tenant leak in `ScanOutcome.expired`).
4. P2: `refresh()` obeys the kind switch, keeps the chain's first-shown time and is idempotent for
   the same precondition.
5. P1: the scheduler scans repositories whose authorisation was withdrawn and uses the host token
   (needs a per-owner credential design).
6. P2: schema 4 meant two things (#269 and #271): migrate by table presence or bump to 5.
7. P2: a card abandoned after 24 hours must cancel its pending delivery before it settles.
8. P2: scan fairness (a due-time queue) and persisted retry state.
9. P2: the scan after the employee's own task finishes is wired only for card tasks; wire it or fix
   `docs/fork/deploy.md`.
10. Phone card text as plain text (T29).

## Deep research (T25)

Deep mode is off at launch (`MAKA_CLOUD_DEEP_MODE`, see `launch-notes.md`) because of the item below:
a request for it runs as standard. Turn it on once this is closed.

1. Recheck 16 item 5: in a deep research run, `otherRunnerInput` only proves that some file of the
   other runner was read. Record provenance (draft, review task, judgment) and require the final
   result to use that review's artifact. Test: Claude reads its own draft plus an unrelated Codex
   `notes.txt`, and the deep verdict must fail.

## Per-task agent accounts (r19-4)

Today the agent account is one per sandbox machine (`MAKA_CLOUD_AGENT_USER`), shared by every task on
that machine. A pool of accounts, one per task, is built and tested locally and kept as a patch at
`/mnt/project-files/security/r19-4-agent-pool.patch` (not merged). It reads `MAKA_CLOUD_AGENT_ACCOUNTS`,
leases an account to a task through a `.agent` file in the task directory, and releases it once the
stop is confirmed.

Still missing before it can merge:

1. A peer test with real accounts (one task's account cannot read another's workspace).
2. Host configuration tests for `MAKA_CLOUD_AGENT_ACCOUNTS`.
3. The text in `docs/fork/deploy.md`.
4. The host's `taskOver` wiring, so the lease is released when a task is over.
5. Lift the one-task-per-invite cap when per-task accounts land: raise the default of
   `MAKA_CLOUD_TASKS_PER_INVITE` (`DEFAULT_TASKS_PER_INVITE` in `cloud-server.ts`) and update
   `launch-notes.md` ("One task at a time per invite"). Until then the inbox's stall check reads a
   task that only waits its turn as stalled after `queuedStallAfterMinutes`; teach it the wait, or
   lift the cap.

## Go-live rehearsal

1. The stand-in sandbox has no real firewall (the egress rules are checked as text, no packet is
   filtered) and a scripted CLI. The first live run is the first time those run.
2. (Done: closing the server now lets go of its runs, `Orchestrator.detachRuns` and `RunHandle.detach`, and the
   poller's sleep no longer keeps the process alive; the exit is forced after ten seconds. Check the restart time on
   the first live run.)
3. Running the flow against the owner's host after every merge and daily (needs a stand-in instance
   there and an ops script for systemd).
4. The smoke test's 3 minute window per task to confirm a stop (36 asks, 5 seconds apart,
   `smoke-live.ts`) is a guess; a slower real stop makes a run refuse, which is safe but should be
   tuned after the first live run.
5. Smoke cleanup cost grows with the invite's history, because it asks the live state of every task
   of the invite (#317, P3 in its review). Fix by honouring retry-after on a 429, or by pruning old
   smoke conversations after a good run.

## Install output (`cloud-runners`)

1. P2: the install-output window drops a field's parent key before the scrub when a certificate
   line is over 24 KB, so a key can reach the output. A first user's `npm install` may print that
   line, so this is on the first-user path; the owner's coordinator may want it in a lane instead.
   Fix: stream-scrub with object and field state kept before windowing (`install-output.ts`). Test:
   an install line over 24 KB that holds a certificate field and a key, which must not reach the
   output. Source: batch29 A7 (owner's Codex recheck).

## Smoke enumeration and the task list (from the #328 review)

1. P3: the smoke should throw if the conversation list ever gains a `next` cursor, because it reads
   one page today and would miss the rest. Test: a list reply with a `next` cursor makes the smoke
   refuse to start.
2. P3: the smoke should request `limit=200` per page, so an invite with a long history needs fewer
   pages. Test: the request carries `limit=200`.
3. P3, possibly user-visible: the server's `listTasks` can drop a task from a page, so the task list
   may miss one. Check the lane's cursor logic first. Test: a page boundary that falls inside a run
   of tasks returns each task exactly once. Source: the #328 review.

## Kept changes and the handoff listing (from #336 and #341)

1. P3: a second open of the same kept change should show the same change, not open it again.
   Test: opening a kept change twice returns one record. Source: #336.
2. P3: a task that is not kept gets refusal text that says why the change cannot be opened, not a
   generic error. Test: a non-kept task's refusal names the reason. Source: #336.
3. P3: the hash-named files are not listed in the handoff listing, so an owner cannot see them.
   Test: a listing of a handoff directory with a hash-named file includes it. Source: #341.

## Restarts, the kept conversation and CI timing (from #325, #337, #345, #352)

1. P3: a restart ends every running coding task as failed ("orphaned"), because `CodingRunner` has
   no `recover`. A first user who restarts mid-task has to send the goal again. A coding `recover`
   would restart from the kept change or a fresh clone, spend so far included, and the result
   card should say "restarted after a server restart" so a second `fetching` is not read as a
   loop. Source: #337, recheck28 F3.
2. P3: the backup copy of `transcripts.db` walks `transcript_lines` with `LIMIT ? OFFSET ?`, which
   is quadratic in the table size. Use keyset pagination on the ordering columns, or one iterated
   `SELECT` with the updates batched in a transaction. Source: #325.
3. P3: the recovery id of a journal row without an attempt is a hash of the row's sum, so it holds
   only while no new row without an attempt is written for the task. If the journal ever writes
   them again, key the rows by their own id. Source: #345.
4. P3: two timing tests failed on a loaded CI runner (the suite took 306 s against 128 s on a
   dev machine) with nothing in the PR touching them: `cancelling the task stops the CLI in the
   sandbox` (the pid file is awaited 5 s) and `children that ignore TERM are killed even after the
   leader exited normally`. Make each wait on an explicit handshake instead of a time. (The
   stop-obligations tests that raced the fast retry are fixed: the retry that would confirm the
   stop now waits for the test to open a gate.)
5. P3: `GET /v1/inbox/settings` hands every invite the operator's figures (`maxInterruptsPerHour`,
   `verifierDailyCapUsd`, stall times, `digestAt`). The design says an owner may read them, but the
   verifier cap is a budget figure and the first user is not the operator. Return only the owner's
   own choices plus the operator's mutes and quiet-hour defaults. Source: #352.

## Reviews merged without an outside review

Codex hit its usage limit on 2026-10-21 and reviews failed from about 17:25 UTC. The list of pull
requests merged since then, with the outside review each one had, is in
`docs/fork/unreviewed-prs.md`. Recheck them once Codex is back.

## LayerFS workspaces (phase 2, C6)

From the owner's review of LayerFS (2026-10-21). The proposal and its gates are in
`docs/fork/design/layerfs.md`.

1. Gate 1, isolation: a LayerFS FUSE workspace on instabox, run by the unprivileged agent account,
   breaks no invariant of `docs/fork/isolation-model.md`. Test: every invariant check passes with a
   LayerFS mount in place.
2. Gate 2, measured gain: mounting beats clone plus install by at least 3x to the first test run on
   two real repositories. Test: the benchmark harness records both.
3. Only then: a `WorkspaceStore` interface (clone stays the default), kept-change checkpoints as
   immutable commits (closes the P2-2 class), parallel tasks on one repository, and blame lines in
   the PR evidence block.
