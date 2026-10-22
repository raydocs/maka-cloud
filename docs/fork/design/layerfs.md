# LayerFS for task workspaces (proposal, after launch)

Status: proposal. Nothing here is built. It starts after the first live run, as the parallel-tasks
work (phase 2, C6), and only once the two gates below pass.

[LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) (MIT, Rust; 1.0.0 released 2026-10-21) gives
each agent a complete writable workspace over shared committed history without copying the base.
Writes go to the workspace's own overlay until a commit saves them. Every file tool call or Bash call
is a commit on the task's branch. A commit that changes a file another commit already changed is
refused with a conflict. Objects are content-addressed and never rewritten, and a fork from any
commit is metadata only. Ignored files such as `node_modules` stay in every commit, so a mount
already has the dependencies.

## What we would take, and for what

| Our need | Today | With LayerFS |
|---|---|---|
| Several tasks on one repository at once (C6) | One fresh clone per task, in its own box | One shared base per repository commit, plus a writable overlay per task. A clash between two tasks is a conflict, not a silent overwrite |
| Task setup time | Clone plus install inside the check budget (about 9.5 min) | Mount in milliseconds, dependencies included. The setup snapshot (`boxes.md`) becomes a base commit |
| Kept changes and checkpoints | `changes.json` is rewritten in place, so a crash between two writes can wedge a kept change (re-review P2-2) | Every checkpoint is an immutable commit. The delivery record points at a commit id, so a half-written checkpoint cannot exist |
| Retry from a step | Restart the attempt | Fork the task's branch at the last good commit |
| Evidence in the PR (C5) | Diff only | Per-line blame: which step of the run wrote each line |

Maka's own append-only step log stays the record of truth. LayerFS holds workspace state, and every
LayerFS commit id is written to the step log.

## Gates before any code

1. **Isolation.** A LayerFS workspace runs as a FUSE view in a daemon inside the sandbox. Prove on
   instabox that the daemon and its mount work for the unprivileged agent account, without giving
   that account `CAP_SYS_ADMIN`, `/dev/fuse` beyond the mount, or any way around the egress guard.
   Check every invariant in `docs/fork/isolation-model.md` with a test. If FUSE needs more privilege
   than the model allows, stop here.
2. **Measured gain.** On `raydocs/maka-cloud` and one other real repository, compare clone plus
   install against a mount: wall time to the first test run, and disk per task. Continue only if the
   first-test time improves by at least 3x.

## Limits to respect

- 1.0 runs its Store in a disposable profile with no crash or power-loss durability ("use LayerFS
  for agent work and its history, not as the only copy of data you cannot rebuild"). A kept change
  that is waiting for the owner is also exported as a plain patch, so a lost Store loses no work.
- Sequential reads and writes are slower than a plain filesystem in its own benchmarks (fio:
  sequential write 0.31×, sequential read 0.81×). Large builds may be slower; measure under gate 2.
- The project is two months old. Pin a release and record it in `docs/fork/THIRD_PARTY.md` when code
  is taken.

## First steps after the gates

1. A `WorkspaceStore` interface in cloud-runners with two implementations: today's clone and
   LayerFS. The clone stays the default.
2. Kept-change checkpoints as LayerFS commits, behind a setting. This closes the P2-2 class of bug.
3. Parallel tasks on one repository (C6) on LayerFS overlays.
4. Blame lines in the PR evidence block.
