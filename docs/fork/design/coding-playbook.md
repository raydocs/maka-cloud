# Coding playbook (T8)

Package: `packages/cloud-playbooks`, code in `src/coding/`, exported as `@maka-cloud/playbooks/coding`.

## Shape

The conductor does not drive the coding loop itself. It delegates one task to the `coding` runner, a T2 `Runner` that
is code, not a model. The runner owns the loop because the rules it enforces (independent test runs, two failures,
edit loops, one handoff) need to see the sandbox, and the conductor only sees manifests.

| Piece | What it is |
|---|---|
| `codingPlaybook` | T5 `Playbook`: `allowedRunners: ['coding']`, planning instructions, the steps the conductor follows, `verify`. |
| `CodingRunner` | Clones, runs vendor agents, checks, hands over, collects the change, writes the manifest. |
| `openPullRequestTool` | T5 `ConductorToolSpec` with `irreversible: true`: opens the pull request from the host after approval. |
| `GitHubPublisher` | GitHub REST client the tool publishes through. |
| `createCodingRunner(cloudRunners, …)` | Wires the runner onto the T6 runners and their sandbox fleet. |

## One coding task

1. The brief carries one fenced `coding-task` JSON block: `{repo: "owner/name", baseRef, testCommand, goal, runner?}`.
   A missing or invalid block fails the task before anything is acquired.
2. The runner fetches exactly one commit of the repository into the task's workspace in the sandbox
   (`git fetch --depth=1`, URL built from the validated `owner/name`). Public repositories only: no token enters a
   sandbox.
3. A vendor agent (T6 `SandboxCliRunner`, Claude first unless the brief says otherwise) writes a reproduction test,
   records it in `handoff/repro.json` (the agent can write only `handoff/` and `workspace/` of its task directory), and makes the change.
4. The runner checks the work itself, as the agent's account (never the sandbox user: a repository's test command is
   the agent's code, and a box with no agent account runs no check), with detached processes it polls:
   the reproduction test passes; `testCommand` passes; the reproduction test **fails** with every change outside its
   files reverted to the base commit (then the change is put back). A test that passes without the change does not
   reproduce anything and is rejected, and so does one that times out, is killed by a signal, or cannot run its
   command there (exit 125 or above): only the test's own failure, exit 1 to 124 within the time limit, shows the
   problem.
5. A failed check or a failed run resumes the same vendor session with the failure and the end of the output.
6. After two failures, or an edit loop, the runner writes `failure_brief.json` (what was tried, how the checks failed)
   and `attempt-1.patch`, fetches the base commit again, and starts the other vendor once. It gets the same two
   failures. There is never a third agent, and never two at once.
7. A verified change is read out as git would commit it (diff against the base commit including untracked files,
   ignored files excluded, every blob's sha1 checked on the host; symlinks, submodules and oversized files refused)
   into `changes.json`, `change.patch` and `verification.json`, and recorded in `CodingDeliveries`. The delivery
   points at hash-named copies of the change and its record (`changes.<hash>.json`, `verification.<hash>.json`) that
   are never written twice. They live in `.records/` of the task's handoff directory, which no exported artifact can
   name (an artifact is a plain relative path, never starting with a dot) and which the export reserves besides.
   Beside the plain-named files, an artifact called `changes.<hash>.json` replaced an earlier delivery's change or record.
8. The runner writes the result manifest itself. Its `done` holds one `verified:` line; `verify` requires it and the
   three artifacts. When both vendors fail, the task still finishes, with `notDone`, low confidence and the failure
   brief, so the conductor can say what went wrong.

Hidden tests: the task has no field for them, the runner only runs the brief's `testCommand` and the agent's own
reproduction test, and the agents are told never to look for held-out tests. T10 grades with hidden tests outside
this runner.

**Edit loops.** While an agent runs, the runner samples the content hash of every changed file (default every 15 s,
read-only git with no index lock). A file returning to an earlier version three times, or changing in more than 30
samples of one vendor's attempt, is a loop: the run is cancelled and the task handed over.

**Budget.** The runner reports one running total of its agent runs' spend as `usage` events, and gives each agent
run what is left of the task's `budgetUsd`. When the total reaches the budget, it stops the agent run and fails the
task with the reason. A spent budget is not a vendor failure, so the task is not handed over.

**Review and fix rounds.** A verified change is reviewed by an agent of the other vendor (`review.md`, counts and
its hash in `verification.json`). While the latest review has P1 or P2 findings, the runner starts a fix round: the
implementer's vendor gets those findings (the worst five, as data) in a fresh run, the runner runs the reproduction
test, the repository's tests and the base check again exactly as for the first change, and the other vendor reviews
the fixed change afresh. P3 findings are never sent back. The rounds end at the first review with no P1 or P2, after
`limits.fixRounds` rounds (default 3, at most 10, 0 for none), when the review's share of the budget leaves less than
a fix and a review, or when a fix does not run or fails the checks. The change delivered is then the last one that
passed the checks and was reviewed, with that review: never a fix whose checks failed, and never one shown with
another change's review. Each fixed change that passes the checks is kept on the host before its review starts, so a
stop or a failed review leaves it kept unreviewed. `verification.json` records the rounds under `review.fix`
(`rounds`, findings sent, whether the change is a fixed one, why the rounds stopped, and each round's result and
counts). A change whose latest review still has a P1, or that could not be reviewed, is kept for the owner instead of
delivered, with the reason (for example "the independent review still found 1 serious problem(s) after 3 fix
round(s) (the cap of 3 fix round(s) was reached)"); it is pushed only if the owner asks to open it unreviewed. A P2
left after the rounds is delivered and shown.

**Checks.** A check is one sandbox `exec`, run as the agent's account (`SandboxWorkspace.execCheck`: the same account check and
`sudo -u` as the CLI), that runs the command to its end, and its exit status is the exec's own,
which the instabox API returns to the host. Nothing the check writes (files, output) is read as its result. The command
runs in a new user and PID namespace (`unshare --user --map-current-user --pid --fork --kill-child`) whose first
process is the runner's: when the command ends, that process exits and the kernel kills everything left in the
namespace. A process inside cannot leave it (`setsid`, `env -u`, double forks and `nohup` all stay inside), cannot
signal processes outside it, and, being in a child user namespace, cannot trace or read the memory, file descriptors
or environment of processes outside it. So nothing a check started is alive when its exec returns, and the next check
starts clean. Each check carries a tag (`maka-check:<taskId>:<n>-<random>`) in the arguments of the processes that
hold its namespace, so a stop finds them without anything the check could rewrite: after every check the runner
kills what carries the check's tag and waits until its namespace is empty, which also covers an exec whose connection
dropped. The command gets `timeout` (TERM, then KILL 5 s later) inside the namespace and a KILL of the namespace
10 s after that outside it; a check whose exit is 124 or 137 after its whole limit timed out. Because exec ends after
10 minutes, a check may run at most 9.5 minutes (default 9).

Where the sandbox cannot create the namespace (no unprivileged user namespaces), the check does not run and the task
fails with that reason: a check is never run unisolated, and no result is reported as verified without it.

**Exits.** Every exit (end, cancel, throw, check timeout) cancels the agent run, stops every process of the task
(the runners' task-wide stop for agent runs, and every namespace tagged with the task's id for checks), restores a
reverted workspace, and releases the sandbox lease. The terminal event is published only after that. After a restart,
`stopOrphaned` stops a task's leftovers by id, checks included.

## Opening the pull request

`open_pull_request {taskId, title}` is irreversible, so T5 holds every call until the user approves it. Its
`approvalDetails` adds the repository, the branch (`maka/<taskId>`) and the title to the approval card, under the
held call that T5 builds from the call itself. After approval it:

- refuses a task the run did not delegate, a task without a verified delivery, or a `changes.json` whose sha256 changed;
- builds the commit on the host with the Git Data API: blobs (GitHub's blob sha must equal ours), a tree on the base
  commit's tree, a commit whose only parent is the base commit, the branch, then the pull request into the task's base
  branch (or the default branch when the task started from a sha);
- is idempotent: an existing branch holding the same tree and an existing pull request for it are reused; a branch
  with other content is never overwritten; two calls at once share one publish.

The description is built from `verification.json`: the commands the runner ran, the reproduction fail-then-pass, the
changed files, and what was not verified.

### Token

Decided by win (2026-10-19):

- A fine-grained personal access token only, read from `MAKA_GITHUB_TOKEN` (never `GITHUB_TOKEN`, so a CI or shell
  token is not picked up by accident), scoped to selected repositories with Contents and Pull requests read/write.
- A token without the `github_pat_` prefix is refused before any GitHub call, with the reason; the approval card says
  so too.
- It stays in the host process: it is never sent to a sandbox, written to a file or snapshot, or included in an error.
- **Later:** per-user access moves to a GitHub App (installation tokens per user and repository). The publisher takes
  its token from a function, so the App replaces the env var without changing the tool.

## Not covered yet

- Checks run as the same sandbox user as the agent (instabox `exec` has no other user). The namespace keeps a check
  from reaching out, but not the reverse: an agent-run process that escaped the runners' task-wide stop (which still
  finds agent runs by `MAKA_RUN_TOKEN`) could change the workspace while a check runs, and, where the kernel lets a
  process trace unrelated processes of its user (Yama `ptrace_scope` 0 or no Yama), trace the check. Agent runs need
  the same namespace in the runners' launch to close this.
- A test can change the workspace while it runs; the delivered change is what the working tree holds after the
  checks.
- Tests that need privileges outside the namespace (sudo, setuid programs, mounting) fail inside it.
- Private repositories (they need a read credential in the sandbox; a separate decision).
- A check longer than its timeout (default 9 min, at most 9.5) fails; suites longer than that need exec streaming or
  splitting.
- Build outputs ignored by git stay in place during the base check, so a test that reads a stale build could pass on
  the base commit; the check then reports "does not reproduce" rather than a false pass.
- The agent can rewrite the repository's git metadata, and it owns `.git` (config, attributes, hooks). The sandbox user
  never reads it: the clone makes `control.git` in the task directory (its own copy of the base objects and an index,
  where the agent cannot enter), and every git the runner runs (changes, baseline revert, the edit-loop sample, blob
  reads) runs against it with the workspace as the working tree, no configuration of its own and no attributes file, so
  a filter, textconv, hook or fsmonitor the agent configures has nothing to run. A workspace without it is refused, and
  so is one with a repository inside it (a `.git` below the top, such as a populated submodule): git would run a child
  git there with the agent's configuration, so the changes, the sample and the base check print `ERR nested repository`
  and the owner sees a progress note. Submodules are never followed in status or diff. The base check is split by
  account: the sandbox user only reads (git against `control.git`) and stages the base version of every changed file
  outside the workspace, and the revert and the restore edit the workspace as the agent's account, so a directory the
  agent swaps for a symlink is never written through by the sandbox user. A restored file is group-writable so the
  agent can edit it as before.
  Delivered contents are what git would commit from the working
  tree and are hash-checked in transit; the tree is built on GitHub's own base tree, and the repository's CI runs on
  the pull request.
