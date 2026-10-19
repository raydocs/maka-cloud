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
   records it in `repro.json`, and makes the change.
4. The runner checks the work itself, as the sandbox user, with detached processes it polls:
   the reproduction test passes; `testCommand` passes; the reproduction test **fails** with every change outside its
   files reverted to the base commit (then the change is put back). A test that passes without the change does not
   reproduce anything and is rejected.
5. A failed check or a failed run resumes the same vendor session with the failure and the end of the output.
6. After two failures, or an edit loop, the runner writes `failure_brief.json` (what was tried, how the checks failed)
   and `attempt-1.patch`, fetches the base commit again, and starts the other vendor once. It gets the same two
   failures. There is never a third agent, and never two at once.
7. A verified change is read out as git would commit it (diff against the base commit including untracked files,
   ignored files excluded, every blob's sha1 checked on the host; symlinks, submodules and oversized files refused)
   into `changes.json`, `change.patch` and `verification.json`, and recorded in `CodingDeliveries`.
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

**Exits.** Every exit (end, cancel, throw, check timeout) cancels the agent run, stops running checks through the
runners' task-wide stop (checks record their pid and run token the way runner scripts do), restores a reverted
workspace, and releases the sandbox lease. The terminal event is published only after that. After a restart,
`stopOrphaned` stops a task's leftovers by id.

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

- Private repositories (they need a read credential in the sandbox; a separate decision).
- A check longer than its timeout (default 15 min) fails; long suites need a higher limit per task.
- Build outputs ignored by git stay in place during the base check, so a test that reads a stale build could pass on
  the base commit; the check then reports "does not reproduce" rather than a false pass.
- The agent can rewrite the repository's git metadata. Delivered contents are what git would commit from the working
  tree and are hash-checked in transit; the tree is built on GitHub's own base tree, and the repository's CI runs on
  the pull request.
