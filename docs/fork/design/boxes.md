# The box pool (`@maka-cloud/boxes`)

Task T27. A `SandboxProvider` (the interface `@maka-cloud/runners` already takes) that gives
each invite up to a few instabox boxes, one task per box, in place of one fixed machine per
invite. Plan: `plans/t27-plan.md` in the project files. This page records what is built; the
sleep, snapshot and install pieces are added here as they land.

## What instabox allows (from its OpenAPI document)

- A box is created from a template or a snapshot, with a `name` (unique among the org's live
  sandboxes) and `metadata` labels (up to 32; `GET /v1/machines?metadata=k:v` filters on them;
  `PATCH` replaces them).
- **An account may have 5 sandboxes in any state** (`429 quota_exceeded`), whatever our maximum
  per invite says. The pool therefore makes boxes only when a task needs one, learns the account's
  limit from the refusal, and queues instead of failing while the invite has a box to wait for.
- Instabox pauses an idle box after 30 minutes unless the account has manual lifecycle.

## Identity: labels and names

Every box carries `maka.pool=1`, `maka.invite=<tenant>`, `maka.slot=<n>`, `maka.setup=<hash>` (when
made from a setup snapshot) and, while a task holds it, `maka.task=<task id>`. Its name is
`mk-<12 hex of sha256(tenant)>-<slot>`, so a create that is sent twice finds the first box (409)
instead of making a second. A box is used only when its pool label, invite, slot (inside the
maximum) and name all match what is expected; otherwise it is refused with a warning and never
handed out or listed by `knownMachines()`. Two boxes claiming the same invite and slot: the first
wins, the second is refused. A box in `error` is registered as `lost` and never handed out.

## Handing out

- `acquire` is idempotent per task: the box already labelled with this task comes back, with a new
  lease, and the old lease then frees nothing.
- Otherwise: a free box of the same invite (the one the task's conversation used last, because
  `maka-inputs` can copy files only within one box; then the lowest slot), else the lowest missing
  slot is created, else the task queues first come first served for `waitMs` (default 2 minutes)
  and then fails with `NoFreeBoxError`.
- Every decision about shared state is made in one synchronous step before any await, so two
  callers cannot take the same box or the last slot. A box being created is claimed by its task
  from the start; a second ask by that task waits on the same creation.
- Every exit gives the box back: a failed create forgets its slot, a failed label write frees the
  claim, a timeout removes the waiter, `dispose` rejects all waiters.
- Label writes of one box run one after another, each sending what the box is at that moment, so a
  slow write that clears one task's label cannot land after the write that labels the next.
- A new box is guarded (`beforeUse`, where the egress guard goes) before its first use; if the guard
  throws, a box the pool just made is deleted and the task gets the error.

## After a restart

The registry is rebuilt from a label listing. A box labelled with a task the orchestrator still
considers live is re-claimed (an "adopted" claim, with no lease object: a resumed run keeps its
recorded machine without calling `acquire`, and asking again returns that box). A label for a task
that is not live is cleared. `reconcile()` later frees adopted claims whose task has ended; a
claim held by a lease of this process is never touched there.

## Sleep and wake

Instabox pauses an idle box after 30 minutes whatever we ask, so the pool puts boxes to sleep
itself, sooner: **the agent idle 5 minutes and nobody has looked for 20** (Amp's rule;
`idle.agentMs` and `idle.userMs`). `sweepIdle()` is meant to be called every minute or so (the
timer is added when the pool is wired into the stack); one sweep runs at a time.

Per box, in Rakazo's order:

1. Compare-and-set `ready -> suspending` in one synchronous step. A box with a claim, or idle for
   too short a time, or looked at lately (`noteUserActivity(machineId)`, for T14's terminal and
   desktop views) is skipped.
2. Ask instabox what the box is. One that is not running (instabox paused it first) is simply
   recorded as `suspended`: running a command on it would wake it.
3. Checkpoint: `sync` in the box.
4. Re-check every hold: a task that took the box (taking a `suspending` box in this phase cancels the
   sleep and the task keeps it), a look since the sweep began, and `recentWrite(machineId)` (a write
   in the last minute; a check that cannot tell counts as a write). Any hold turns the sleep back.
5. Only then suspend and wait for the operation. A failure is followed by a read of the real state:
   running is `ready` again (no new try for 5 minutes), paused is `suspended`, anything else is `lost`.

A task that takes a `suspended` box wakes it (`ensureRunning`) with a limit of 60 s. A wake that
fails or times out is tried once more with 180 s; a box that is gone (404) is not retried. Only a
second failure counts the box as `lost` ("slow, not dead", durable-harness `wake.ts`). After a wake
the guard (`beforeUse(machineId, 'wake')`, the egress guard) runs and a box that fails it is not used.
In both cases the task goes on to another box. Awake boxes are preferred to sleeping ones, and a
sleeping box is woken before a new one is made. A box found asleep after a restart is `suspended`.

Not here: `.agents/resume` after a wake (with the setup snapshots).

## Cleanup

`cleanup()` (called every few minutes, like `sweepIdle()`) looks after boxes nobody uses:

- A `lost` box that has been lost for 30 minutes is tried once more (woken with the longest limit, then
  guarded). If that works it is `ready` again; if not it waits 30 minutes before the next try.
- A box lost for 24 hours is deleted. With `cleanup.idleDeleteMs` set, a box that has done nothing for
  that long, and that nobody has looked at for as long, is deleted too (off by default).
- Before any delete: compare-and-set to `deleting` (a synchronous step; nothing can take the box, and a task
  that arrives meanwhile gets another), then a fresh `getMachine`: it must still carry this pool's labels
  for this slot, its task label (read now) must not name a live task, and `recentWrite` must say no. Any
  doubt puts the box back as it was and waits 30 minutes. A box already gone leaves the registry without a
  delete call.
- Boxes the pool refused (wrong name, slot out of range, duplicates) are listed by `refusedBoxes()` and are
  never deleted: whose they are is for the operator to say, and a label alone is not proof.
- Not decided: deleting an idle box of one invite to make room for another when the account is at its
  limit. It would lose that box's files, so it is not done.

## Restoring

`restoreFromSnapshot` drops the task's old box from the registry (a broken one that still exists
stays as `lost` in its slot), then creates a new box from the snapshot in a missing slot. With no
missing slot, or at the account limit, it fails at once: nothing waiting would free a slot.

## Known limits

- The registry is in memory; instabox's labels are what survives. One server process is assumed.
- A broken (`lost`) box keeps its slot and counts toward the account limit until the cleanup piece
  deletes it.
- Input copying between tasks still works only inside one box. A task that asks for files of a
  task that ran on another box is refused as before.
