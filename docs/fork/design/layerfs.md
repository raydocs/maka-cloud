# LayerFS for task workspaces (proposal, after launch)

Status: nothing shipped. `WorkspaceStore` lives in `@maka-cloud/superagent` only
(`GitCloneStore` default; `LayerFsStore` is metadata-only: no FUSE, Docker or
LayerFS server is started). The T6 fleet and the coding playbook do not use it:
the coding path clones inside the sandbox. The four Instabox gates have not been run.

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

## The four gates

Do **not** run these on the product Instabox from CI. The owner runs them on a
**disposable** Instabox.

| Gate | How | Pass | Fail |
|---|---|---|---|
| 0. Device | One disposable Instabox: `/dev/fuse`, `docker info`, fs is ext4/xfs/btrfs | all three | stop, write the reason here |
| 1. Isolation | Every invariant in `isolation-model.md`; agent account has no `CAP_SYS_ADMIN`; from a container, 169.254.169.254 and RFC1918 are refused | all refused | stop. FUSE privilege that exceeds the model is a stop |
| 2. Gain | maka-cloud + one other real repo: wall time to first test, disk per task, vs clone+install (~9.5 min today) | ≥3× first-test | keep the interface, drop the adapter |
| 3. Correctness | Two workers fork one baseline and edit the same file → conflict, not overwrite; `kill -9` the daemon → `exportPatch` still complete | both | fix or stop |

The Super-agent tests cover gate 3 against `LayerFsStore`
(`packages/cloud-superagent/src/__tests__/workspace-store.test.ts`). Gates 0–2 stay Instabox.

The Super-agent architecture (`docs/fork/architecture/superagent.md` §10)
matches this table. There is no flag: no product path selects `LayerFsStore`.

## Limits to respect

- 1.0 runs its Store in a disposable profile with no crash or power-loss durability ("use LayerFS
  for agent work and its history, not as the only copy of data you cannot rebuild"). A kept change
  that is waiting for the owner is also exported as a plain patch, so a lost Store loses no work.
- Sequential reads and writes are slower than a plain filesystem in its own benchmarks (fio:
  sequential write 0.31×, sequential read 0.81×). Large builds may be slower; measure under gate 2.
- The project is two months old. Pin a release and record it in `docs/fork/THIRD_PARTY.md` when code
  is taken.

## First steps after the gates

1. A `WorkspaceStore` interface (`@maka-cloud/superagent`). The clone stays the default.
2. Kept-change checkpoints as LayerFS commits, behind a setting. This closes the P2-2 class of bug.
3. Parallel tasks on one repository (C6) on LayerFS overlays.
4. Blame lines in the PR evidence block.
