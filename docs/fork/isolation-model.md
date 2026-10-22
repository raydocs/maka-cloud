# Sandbox isolation and egress model

This is the threat model for what runs in a sandbox box, the invariants the code is held to, how
each one is enforced and tested, and the list of places where the code as of `6af5f15` (main,
2026-10-21 23:20 UTC) does not hold one of them. It exists so that the recheck loop stops finding new P1s one at a time: a
finding is either a violation of a numbered invariant below (then it is a fix, listed in section 7
with the test that proves it) or a gap in the model (then this file changes first).

Launch scope: one sandbox machine per invite (`MAKA_CLOUD_SANDBOXES`), tasks started by users, the
model gateway, approvals, the inbox. The box pool, snapshots as a trust boundary, proposed cards
and the plan vault are off at launch (`docs/fork/launch-notes.md`) and are only noted in section 9.

The code this describes: `packages/cloud-instabox/src/egress.ts`,
`packages/cloud-runners/src/{agent-user,scripts,machine,fleet,process-channel,export}.ts`,
`packages/cloud-playbooks/src/coding/{scripts,sandbox,runner}.ts`.

## 1. Actors

| Actor | What it is | Trust |
| --- | --- | --- |
| **Owner** | The person whose invite the box belongs to. Decides approvals, sees results. | Trusted. Everything in the box is theirs to see; nothing in the box is secret from them. |
| **Server** (host) | The one Node process on the owner's host: orchestrator, conductor, runners, gateway. Holds every long-lived key. | Trusted. It is the only thing that talks to the sandbox API. |
| **Control user** | The account the sandbox provider's `exec` runs as (the "sandbox user", `dev` on instabox). Has passwordless `sudo -n` for everything, so it is root by another name. Owns the work root, every task directory, the channel, the CLI install and the firewall rules. | Trusted *as long as it executes only host text*. Every script it runs is a string constant of ours with values in environment variables (`shell.ts`, `assertSafeId`). The moment it runs a file or a configuration the agent can write, it is the agent with root. |
| **Agent account** | `MAKA_CLOUD_AGENT_USER` / `_GROUP`: an unprivileged account in the box image, in a group the control user shares. Every CLI (Claude, Codex) and every repository test command runs as it. One account per box at launch. | Untrusted. Everything it runs is model output steered by whatever the model read: the brief, the repository, web pages, issue text. |
| **Task code** | What the agent account runs: the CLI, its tools, the repository's own test commands, the repository's git configuration and hooks, anything in the workspace. | Untrusted. Assume it is written by an attacker who controls the repository or a page the model fetched. |
| **Sibling tasks** | Other tasks of the same invite on the same box (a research draft and its review, a coding task and its reviewer, duties). They run as the same agent account and share the box. | Each is untrusted to the others. At launch they are *not* kept apart; see section 8. |
| **Other invites** | Other people's tasks. | Never on the same box (`TenantMachineProvider` refuses a machine listed for two invites; `MAKA_CLOUD_SANDBOXES` is one machine per invite). Nothing below needs to hold across invites because they share nothing. |
| **Sandbox provider** | instabox: the API, the box's kernel and VM, its control plane inside the box, the cloud it runs on (its metadata service, its private network). | Trusted for the box boundary (kernel, VM). Its network is what the egress policy protects from the box. |
| **Model vendors, GitHub, npm** | Reached from the box (through the gateway and the public internet) and from the server. | Out of scope here except that no long-lived credential for them reaches the box. |

## 2. What is at stake

What an attacker who controls task code wants, in order of damage:

1. **Become the control user or root in the box.** Then the egress rules go, the channel can be
   forged, every sibling task's files, tokens and results are theirs, and the box's cloud network is
   reachable. This is the P1 class every recheck has found a new instance of.
2. **Reach the provider's network from the box**: the cloud metadata address (its host's
   credentials), private ranges, other tenants.
3. **Make the owner approve or publish something other than what was checked**: change a sibling's
   or its own result after verification, forge a "verified" manifest, publish a change that is not
   the one the approval named.
4. **Take a credential out of the box**: a vendor key, the GitHub token, a subscription login, the
   instabox key. None of these are supposed to be in the box at all.
5. **Spend another task's budget** (its gateway token) or outlive its stop.

What is explicitly *not* defended:

- **Exfiltration to the public internet.** The owner decided (2026-10-21) that the box may reach the
  internet, loopback to itself, and nothing private. A task that reads the owner's repository can
  post it anywhere. The gateway is the only budget boundary; the egress rules are not a data
  boundary.
- **A kernel privilege escalation** from the agent account. The box is a VM of the provider's; a
  local root exploit is the provider's layer. We keep the attack surface small (no caps, no sudo,
  no privileged groups, no container sockets) and stop there.
- **The provider itself.** instabox's control plane can read everything in the box; `GET /files`
  reads as root. We never use it on task paths (invariant I14), but we do not defend against the
  provider.
- **The owner's own tasks against each other, at launch.** Section 8.

## 3. Trust boundaries and what each actor may do

Layout per task, under `$MAKA_ROOT` (`/data/work`), as `PREPARE_SCRIPT` and `PREPARE_AGENT_SCRIPT`
make it:

```
/data/work/                      control user, 710 group=agent   (enter, not list)
  <taskId>/                      control user, 710 group=agent   (enter, not list)
    workspace/                   control user, 2770 group=agent  (the repository; agent writes)
    handoff/                     control user, 2770 group=agent  (brief.md 640 down, result.json up)
    claude-config/               control user, 2770 group=agent  (CLI transcripts; both write)
    chan/                        control user, 700               (the SDK channel; agent cannot enter)
    <run>.lock .sh .token .pid .exit .cancel   control user, 600 (run state; agent cannot create here)
    result.read, *.read, change.patch, base-check/, changes.index   control user, task directory
  .setup/, .setup-<cli>/         control user (install markers and install runs)
/dev/shm/maka-logs/<taskId>/     control user, 700, tmpfs        (raw CLI output; deleted on stop)
~dev/.maka-cli/bin/              control user, 755, agent reads  (the pinned CLI, installed once)
```

| | Control user | Agent account | Sibling task (same account, launch) |
| --- | --- | --- | --- |
| Read `handoff/brief.md`, write `handoff/result.json` and artifacts | yes | yes | **yes** (same group) |
| Read and write `workspace/` | yes, but only as the agent or through link-checked reads (I4) | yes | **yes** |
| Enter or read `chan/` | yes | no | no |
| Create entries in the task directory or the work root | yes | no | no |
| Read another task's run state (`.pid`, `.token`) | yes | no | no |
| Read `/proc/<pid>/environ` of a CLI process (its gateway token) | yes (sudo) | its own | **yes** (same uid) |
| Change the firewall | yes (sudo) | no (I5) | no |
| Write `~dev/.maka-cli` | yes | no | no |
| Execute `~dev/.maka-cli/bin/claude` | **must not** (I1) | yes | yes |
| Run git on the workspace | **must not** (I1) | yes | yes |
| Reach 169.254/16, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, fe80::/10 | no (I7) | no | no |
| Reach 127/8 and ::1 through `lo` | yes | yes | yes |
| Reach the public internet, the gateway, the MCP endpoint | yes | yes | yes |

The control plane reaches in through the provider (`exec`); nothing in the box listens for us.

## 4. Egress policy

Where: an `OUTPUT` chain `MAKA_EGRESS` for iptables and, when `/proc/net/if_inet6` has content,
ip6tables (`egress.ts`, `EGRESS_GUARD_SCRIPT`), installed as the control user through `sudo -n`.

Order of rules, which is part of the policy:

1. `RELATED,ESTABLISHED` replies return (the provider's control plane reaching in keeps working).
2. The box's name servers from `/etc/resolv.conf`, UDP and TCP port 53 only, even when they sit in
   a blocked range. A resolver in a private range is therefore reachable on port 53: DNS tunnelling
   to the resolver is accepted.
3. IPv6 neighbour and router discovery (ICMPv6 types in `EGRESS_ICMPV6_ALLOWED`).
4. `127.0.0.0/8` and `::1/128` out of interface `lo` only (the owner's decision, 2026-10-21): a dev
   server or a test that binds a port is reachable from the same box.
5. REJECT for `EGRESS_BLOCKED_V4` (`169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`,
   `192.168.0.0/16`, `100.64.0.0/10`, `127.0.0.0/8`) and `EGRESS_BLOCKED_V6` (`fc00::/7`,
   `fe80::/10`, `::1/128`). AWS keeps its IPv6 metadata at `fd00:ec2::254`, inside `fc00::/7`.

Everything else is allowed. The policy is not an allowlist of hosts: the owner accepted the public
internet.

When: before any task code runs in a box, and again after anything that could have dropped the
rules. `RemoteMachine` starts every box as *not verified* (`unguarded = true`, #297); `launch`,
`launchInstall` and every `exec` marked `taskCode` call the guard first; a wake (`machine_not_running`)
marks it not verified again (#236, #281). The guard is verify-first: rules that read back exactly
right are left alone; otherwise a new chain is built under its own name, hooked first in `OUTPUT`,
and only then are old chains unhooked, so the box is never without a hook (#247, #288). A guard
that cannot finish is an `EgressGuardError` and the box is refused for that launch; a retry after a
refusal is refused without a new exec (`refusals`).

What the policy relies on: that the agent account cannot change it. That is invariant I5, checked by
the box probe. The policy is enforced inside the box by the box's own kernel; nothing outside the
box enforces it. If the provider ever offers a network policy on its side, that becomes the
primary control and this chain the second.

## 5. Invariants

Each: the statement, how the code enforces it today, how it is tested today, and the fixes in
section 7 that it still needs. "Real-account test" means a test that only runs as root on a machine
with a second account (`canSeparate()` in `check-real-account.test.ts`, `agent-user.test.ts`). The
rehearsal job runs the whole task flow with a real second account since #301, but the unit suites'
real-account tests still skip on hosted runners (section 7, F9).

**I1. Task-steerable code runs only as the agent account.** The control user never executes a
file the agent can write, and never runs a program whose behaviour is configured by a file the
agent can write. That includes the CLI (`--version` included), git on the workspace (its
`.git/config` filters, hooks, fsmonitor, `.gitattributes`), `npm` in the workspace, and any test
command. The control user runs git only against a repository it owns (`control.git` in the task
directory, #312), over a work tree with no nested repository: git spawns a child for every
populated gitlink of the index (`git status` runs `git status --porcelain=2` inside
`workspace/<sub>` with the agent's `<sub>/.git`, whose clean filters then run as the control
user), so a nested repository is a repository configuration the agent writes.
*Enforced*: `RemoteMachine.launch` wraps the program in `asAgentUser` (#290); checks go through
`SandboxWorkspace.execCheck` → `asAgentScript` (#289); `control.git` with `GIT_CONFIG_GLOBAL=/dev/null`,
no attributes or excludes file and the redirecting `GIT_*` variables unset (#312, open).
*Tested*: `firewall-account.test.ts` (argv reaches the agent as words, not shell; a machine with no
agent account starts nothing), `check-real-account.test.ts` (real account), `control-git.test.ts`
(#312: planted filter, diff driver, textconv, fsmonitor and hooksPath do not run).
*Still violated*: F1 (nested repositories), F3 (`--version` as the control user).

**I2. Identity is decided by structure, never by parsing shell text.** `launch` takes a program and
arguments and builds the account boundary itself; the only control-user run is `launchInstall`,
which accepts only a `.setup-` directory and host text. No caller decides "runs as" with a string
prefix.
*Enforced*: `machine.ts` `launch` / `launchInstall` / `assertInstallDir` (#290).
*Tested*: `firewall-account.test.ts` ("the CLI install is its own closed method").

**I3. The control user's own files are closed to the agent.** Its home, `~/.maka-cli`, the work
root, every task directory (entries cannot be created, the directory cannot be listed) and `chan/`
(cannot be entered). The agent reaches `handoff/`, `workspace/` and `claude-config/` by path only.
Every `exec` is `bash -lc` (instabox), so the control user's login files (`~/.bash_profile`,
`~/.bash_login`, `~/.profile`, `~/.bashrc`, `/etc/profile`, `/etc/profile.d/*`, `/etc/bash.bashrc`)
are code the control user runs on every exec: a write into any of them is root in the box, and
they must not be writable by the agent's account or group.
*Enforced*: modes in `PREPARE_SCRIPT`, `PREPARE_AGENT_SCRIPT`, `CHANNEL_DIR_CHECK`; probe facts
`agent_control_write`, `chan_*`, `task_list`, `task_file_write`.
*Tested*: `agent-user.test.ts` (real account: channel, handoff, task directory), probe fixture in
`firewall-account.test.ts`.
*Still violated*: F13 (the probe checks the home directory, not the login files in it).

**I4. The control user never follows a path through an agent-writable directory except in four
ways**: (a) a read with every component checked for links, the last open `O_NOFOLLOW`, and a size
cap; (b) a file built in a directory the agent cannot write and renamed into place; (c) running the
whole operation as the agent account; (d) a write (the restore after a base check: `rm -rf`,
`mkdir -p`, a file-by-file copy) with every path component verified not a link at write time, while
no agent process is alive (the run stopped with no survivors, the check namespace confirmed gone),
so nothing can swap a component between the check and the write. At launch (d) does not hold on
its own: a sibling task's agent runs as the same account (I12) and is alive during the restore, so
it can swap a workspace directory for a link to the control user's home between the check and the
write (recheck A2 on #312). Until I12 holds, a write of kind (d) must be done as the agent account
or through directory file descriptors (`openat` with `O_NOFOLLOW` per component), not by path. No
`>`, `>>`, `cat >`, `cp`,
`mkdir -p`, `rm -rf`, `chgrp` or `chmod` by the control user on a path under `workspace/`,
`handoff/` or `claude-config/` otherwise. Also: no file the control user opens for writing lives in
a directory the agent can write (`/tmp` included). Why this is P1 and not a nuisance: every exec is
`bash -lc`, so one write through a link into the control user's login files (I3) is code as the
control user on the next exec.
*Enforced*: `PREPARE_SCRIPT` (brief by rename, #289), `RESULT_STAGE_SCRIPT`, `FILE_STAGE_SCRIPT`,
`STAGE_INPUTS_SCRIPT`, `READ_SMALL_SCRIPT`, `TRANSCRIPT_CHUNK_SCRIPT` (`set -C` create),
`export.ts` `writeHandoffFile` (host side).
*Tested*: `handoff-links.test.ts`, `agent-user.test.ts` ("links the agent plants in handoff/ are not
followed"), `result.test.ts`, `stage.test.ts`, `export.test.ts`.
*Still violated*: F1 (`BASE_REVERT_SCRIPT` and the restore write through workspace paths without
the per-component check of (d)), F6 (the egress lock is opened in `/tmp`), F10 (transcript chunks
appended by name in a group-writable directory).

**I5. Nothing the agent account can reach lets it change the firewall, the accounts or the control
user's processes.** No sudo rule at all (read from the trusted side), no process capabilities, no
file capability on any binary it can run (except an explicit allowlist), no setuid or setgid root
binary outside the distribution's set, no membership in a root-equivalent group, no writable
container or VM socket. The probe fails closed: a fact that is missing, unreadable or produced by a
tool that failed is a failed check, never a pass.
*Enforced*: `AGENT_PROBE_SCRIPT` + `agentIsolationProblems` (#275, #290); `Fleet.ensureAgentIsolation`
once per machine per process, before any run or check.
*Tested*: `firewall-account.test.ts` (every fact, missing and wrong), `agent-user.test.ts` (real
account: a box where the agent could become the sandbox user is refused).
*Still violated*: F4 (file-capability scan fails open and is a partial list; no setuid scan; #313,
open, takes most of it).

**I6. The egress rules are verified in place before task code runs, after every wake, and the box is
never left without a hook while they change; two guards on one box serialise.** A guard that cannot
take its lock, cannot read the rules back, or finds them wrong refuses the box.
*Enforced*: `egress.ts` (verify-first, hook-first swap, `sane`, `flock` required since #310),
`machine.ts` (`guardEgress`, `unguarded`, `refusals`, wake handling). Whether ip6tables is guarded
at all is decided by the content of `/proc/net/if_inet6` at guard time only: a box that gets an
IPv6 address after the guard ran is unguarded on IPv6 until the next launch guards it again.
*Tested*: `cloud-runners egress.test.ts`, `egress-wake.test.ts`, `cloud-instabox egress.test.ts`
(scripted iptables), `egress.real.test.ts` (real iptables in a network namespace),
`egress.live.test.ts` (by hand, `MAKA_CLOUD_LIVE=1`).
*Still violated*: F6 (the lock file is where the agent can put one first), F14 (a verified state
that outlives the box's rules: a plain task-code `exec` trusts the last check across an external
restart).

**I7. The policy is exactly section 4**: blocked nets rejected, replies, resolvers on 53, ND and
loopback-via-lo returned first, loopback refused on any other interface, nothing else special.
*Enforced*: `EGRESS_GUARD_SCRIPT` `build` and `sane` (the chain must open with the reply rule, reject
every net, allow loopback only out of `lo` and before the loopback reject).
*Tested*: `cloud-instabox egress.test.ts`, `egress.real.test.ts` (packets, not text).

**I8. No long-lived secret reaches the box.** A run gets a per-run gateway token and a per-task MCP
token, both revoked when the task ends; vendor keys, the GitHub token, the instabox key and push
keys stay on the server. Subscription logins are refused before the CLI starts. Raw CLI output goes
to tmpfs and is deleted on stop, so a snapshot never holds it. The clone is unauthenticated (public
repository only); the push happens on the server.
*Enforced*: `vendors.ts` `env`/`guard`/`unsetVars`, `buildRunScript` (`MAKA_LOG_DIR` must be tmpfs),
`KILL_SCRIPT` `cleanup_logs`, gateway tokens in `providers.ts`, `pull-request.ts` on the host.
*Tested*: `secrets.test.ts` (nothing on disk at snapshot time, raw output deleted, disk-backed log
directory refused), `cli-check.test.ts`.

**I9. The agent's environment is an allowlist.** The agent process sees the variables the run needs
(PATH, HOME, locale, `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, the gateway and MCP variables, the search
tool variables, `MAKA_RUN_TOKEN`) and nothing else from the control user's exec environment.
*Enforced*: `allowedSdkEnv` filters what the SDK passes; `asAgentUser` runs
`sudo -- env -i PATH=... <name>=...` and hands over only the base names (`HOME`, which is the
sandbox user's, as before, not the agent account's; locale, `TMPDIR`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `MAKA_DIR`, `MAKA_WORKDIR`, `MAKA_RUN_TOKEN`) and the names its
caller passes (the run's own envs; an exec's envs), each only when set; `AGENT_ENTRY` sets `USER`,
`LOGNAME` and `SHELL` from the agent account. The box scripts (`.agents/setup`, `.agents/resume`) see
the base plus `MAKA_REPO_DIR` and `MAKA_SETUP_HASH` only: note it when the pool is turned on.
*Tested*: `process-channel.test.ts` (SDK side), `agent-user.test.ts` (a variable the exec carried
does not reach the agent).

**I10. The SDK channel is written only by the host.** Hook answers (a `deny` in `hooks.ts`), the
prompt, steering from the owner and permission decisions reach the CLI through `chan/<run>.in`,
which only the control user can enter; the agent cannot forge an owner message or a hook decision.
*Enforced*: `process-channel.ts` `CHANNEL_DIR_CHECK` (700, owned, not a link), probe facts `chan_*`.
*Tested*: `process-channel.test.ts`, `agent-user.test.ts` (real account).

**I11. What the owner approves is what was checked.** Before the repository's checks run and before
the change is collected, every process of the task's agent run is stopped and confirmed gone
(`releaseAgent` → `kill`, survivors are an error); checks run in their own PID namespace that is
killed at exit; the collected change is hashed and the approval names that hash (#308); a failed
later round cannot replace a kept checkpoint (#306).
*Enforced*: `coding/runner.ts` (stop before `check` and `collect`), `KILL_SCRIPT`, `CHECK_SCRIPT`,
`pull-request.ts`.
*Tested*: `kill.test.ts`, `check-account.test.ts`, `pull-request.test.ts`, `fix-once.test.ts`.
*Caveat*: holds against the task's own agent; a sibling task's agent (same account) is alive during
verification and can edit the workspace. Section 8.

**I12. Tasks on one box cannot read or change each other's files, processes or tokens.**
*Enforced*: not at launch. One agent account per box; `workspace/`, `handoff/` and `claude-config/`
are group-writable by that account; `/proc/<pid>/environ` of one task's CLI is readable by another's.
*Tested*: no.
*Fix*: per-task accounts, F11 and section 8.

**I13. Invites never share a box.** One machine per invite in `MAKA_CLOUD_SANDBOXES`; a machine listed
twice, or an invite with no machine, fails closed.
*Enforced*: `TenantMachineProvider` constructor and `acquire`, `cloud-host` config check.
*Tested*: `providers.test.ts`, host config tests.

**I14. Task paths are never read through the provider's `GET /files`** (it reads as root and
follows links). Every read of a task's files is an `exec` as the control user under I4.
*Enforced*: `InstaboxClient.getFile` is called only by the instabox executor (`executor.ts`, the T1
ACP executor, which checks containment on our side first), never by runners or playbooks.
*Tested*: by review only. F12 adds a grep test.

**I15. Every script the control user runs is host text; values travel in environment variables;
names are validated.** No task-derived string is ever spliced into a script.
*Enforced*: `shell.ts` (`shq`, `assertSafeId`), every `*_SCRIPT` constant, `asRootScript` (named
variables only).
*Tested*: `agent-user.test.ts` ("account names that could change the command are refused"),
`firewall-account.test.ts`.

**I16. Everything a task starts can be stopped from the control side, and only that.** A run is a
process group with a token in its environment; a stop signals the group and whatever carries the
token, as root when the processes are the agent's; checks are PID namespaces found by a tag; a stop
of an earlier attempt leaves a later attempt's runs alone (#307); survivors are an error, not a
warning.
*Enforced*: `KILL_SCRIPT`, `SWEEP_SCRIPT`, `CHECK_STOP_SCRIPT`, `Fleet.stopTask`, `sweepOrphans`.
*Tested*: `kill.test.ts`, `stale-stop.test.ts` (both packages), `orphans.test.ts`,
`agent-user.test.ts` ("a run of the agent account is stopped like any other").

## 6. The recurring classes, named

Every P1 the rechecks found since #274 is one of these. A new finding should be filed under one;
a finding that fits none means this section is incomplete.

| Class | Invariant | Instances so far |
| --- | --- | --- |
| Control user runs repo-steerable code | I1 | repo tests as the control user (#289 fixed); CLI `--version` (open, F3); git filters/attributes on `git add -A` (#312, open, `control.git`); fsmonitor and hooks (scrubbed by `GIT_FN`, not enough); the box pool's scrub runs `git ls-files` as the control user in the agent's repository, which starts `core.fsmonitor` (batch24 A1, pool, off; section 9) |
| Git child processes in nested repositories | I1 | `git status` inside a populated gitlink with that repository's config (open, F1) |
| Fail-open probe | I5, I6 | sudo probe by trying commands (#290 fixed with `sudo -l -U`); `getcap` failure and partial cap list (#313 fixed); #313's capability line parser cuts the path at the first ` cap_` or ` =`, so a path with a space checks the wrong file and reports none (recheck A1, open, F4); fixed directory list misses other executable mounts and a split `/bin` (recheck A3, open, F4); optional `flock` (#310 fixed) |
| Verified state that outlives the box | I6 | `exec` with `taskCode` guards only while `unguarded`; a box restarted or restored by the provider without a `machine_not_running` answer keeps its stale "verified" state (batch29 A2, open, F14) |
| Shell-text identity | I2 | `startsWith(agentPrefix)` (#290 fixed) |
| Shared agent account across tasks | I12 | handoff 2770, claude-config 2770, `/proc` (open, F11) |
| Link-following writes by the control user | I4 | brief write into `handoff/` (#289 fixed); `BASE_REVERT_SCRIPT` and the restore, raced by a sibling's agent (#312 checks then re-resolves by path; recheck A2, open, F1); egress lock truncating through a link (#310 fixed) and still in `/tmp` (open, F6); transcript append (open, F10); the box pool's scrub writes `/tmp/maka-scrub-env.$$` by name (pool, off; section 9) |
| Control user's login files | I3 | `bash -lc` on every exec; not probed (open, F13) |
| Whole environment handed to the agent | I9 | `env -i` plus named variables (F8, closed) |
| Verification against a stale or tampered change | I11 | approval not bound to content (#308 fixed); failed second review overwrote the fix (#306 fixed) |

## 7. Fix specs: where the code violates an invariant today

Ordered as they should be done. Each is one pull request with a test that fails on `main` and
passes on the branch; "real-account" tests are in addition to a unit test that CI runs. Owner of the
implementation: the "Egress and secret hardening" thread. F1 and F2 are one change.

**F1 (P1, I1 + I4): the control user's git never enters a nested repository, and its writes into
the workspace check every component.**
*Where*: `cloud-playbooks/src/coding/scripts.ts` (`SAMPLE_SCRIPT`, `CHANGES_SCRIPT`,
`BASE_REVERT_SCRIPT`, `BASE_RESTORE_SCRIPT`, `CLONE_SCRIPT`), `runner.ts`.
*Why*: #312 (open) stops the agent's `.git` from configuring the control user's git by running every
git against `control.git` in the task directory with the workspace as the work tree. Two things stay
open. (1) Nested repositories: for every populated gitlink in the index git spawns a child inside
`workspace/<sub>` that uses `<sub>/.git`, which the agent writes; `git status` does this
(`is_submodule_modified`), so a `filter.<x>.clean` in the nested repository's config runs as the
control user through `SAMPLE_SCRIPT`. (2) The restore after a base check keeps `rm -rf`, `mkdir -p`
and a file-by-file copy by the control user on workspace paths: I4 (d) needs each component checked
for links at write time, and the write done only while no agent process is alive.
*Change*: before any control-user git runs, refuse a workspace with a nested repository (`find
workspace -mindepth 2 -name .git -print -quit` non-empty → `ERR nested repository`, the task fails
with that reason; the agent is told in the brief that nested repositories are not supported) and pass
`--ignore-submodules=all` to every `status` and `diff`, so a gitlink that slips past is never
entered. In `BASE_REVERT_SCRIPT` and `BASE_RESTORE_SCRIPT`, walk each path component with `[ -L ]`
checks (as `FILE_STAGE_SCRIPT` does) before `rm -rf`, `mkdir -p` and the copy, refuse on a link, and
assert in `runner.ts` that the agent run was released and the check namespace stopped before either
script runs. That is not enough while tasks share one account (recheck A2 on #312: a sibling's agent
swaps a directory for a link after the check, and the copy re-resolves the path as the control
user): run the revert's writes and the restore as the agent account (`SandboxWorkspace.execAgent`,
the tree is the agent's), or copy through directory file descriptors. #312 at `be7bdb7` has neither
the assertion nor the agent-side copy.
*Test that fails on main (and on #312)*: `control-git.test.ts`: a workspace with `sub/.git` whose
config sets `filter.p.clean` to `touch "$MAKA_DIR/pwned"` and `sub/.gitattributes` `* filter=p`;
`SAMPLE_SCRIPT` and `CHANGES_SCRIPT` must refuse with `ERR nested repository` and the marker must not
exist (today the sample creates it). Revert and restore: a workspace path whose directory component
is a symlink to the task directory receives no file and the script refuses; real-account: a second
process swaps a directory for a link to `$HOME` after the check and before the copy (a handshake
file, no sleep), and nothing lands in `$HOME`.

**F2 (P1, I1, A6): files the control user makes in the workspace are readable and writable by the
agent's group.** After the clone, after every base revert and after every restore: a `0644` file
the control user restored is read-only for the agent, and the repair and review-fix turns edit after
a base check. #312 (open) hands the clone to the group and reverts with `umask 007`; the restore's
file-by-file copy must give the same modes, and a baseline-check exit that comes from `EACCES` is a
runner error, never "fails on base" (`notATestFailure`).
*Test that fails on main*: `checkout-real-account.test.ts` (#312): after a base revert and a restore
the agent reads and writes a nested tracked file; add: after the restore the agent appends to a file
the control user restored (fails where the mode is `0644`).

**F3 (P1, I1, A2): the CLI's version check does not run the CLI as the control user.**
*Where*: `cloud-runners/src/scripts.ts` `cliCheckScript`, `fleet.ts` `installCli`.
*Why*: the script puts `$HOME/.maka-cli/bin` first on PATH and runs `claude --version` as the control
user. The ownership and mode checks do not follow a control-owned symlink to an agent-writable
dependency, and the checked tree can change between `find` and the run.
*Change*: keep the ownership check (it protects the install from being swapped), then run the
`--version` line as the agent (`asAgentUser('claude --version', user)`), so a rewritten CLI only runs as
the agent, which is what runs it anyway. `installCli` already requires the agent account first
(`requireAgentAccount` precedes `ensureCli`). Alternative with no execution at all: compare the
sha256 of the installed `claude` entry point against the marker written at install.
*Test that fails on main*: `cli-check.test.ts`: the version line of the script is inside the
`sudo -n -u <agent>` wrapper (today it is not); in the fake-sandbox harness `sudoUsers()` lists the
agent for the check exec. Update the deploy.md paragraph that describes the check.

**F4 (P1, I5, A3): the capability and setuid scan fails closed and is complete.**
*Where*: `cloud-runners/src/agent-user.ts` `AGENT_PROBE_SCRIPT` (`agent_filecaps`), `agentIsolationProblems`.
*Why*: `getcap -r ... 2>/dev/null | grep ... || true`: a `getcap` that exits non-zero yields
`agent_filecaps=none` and the box passes. The grep names eight capabilities; `cap_chown`,
`cap_fowner`, `cap_setfcap`, `cap_dac_read_search` and others are as good as root for this model.
Setuid-root binaries are not listed at all; a setuid `nft` or a custom tool would pass every probe.
*Change*: #313 (open) checks `getcap`'s exit status, counts any capability on a file the agent can
execute, and allowlists stock helpers. Still needed on top of it: an `as_agent` that fails for any
reason (sudo refused, `test -x` not runnable) reads as `unchecked`, never as "cannot execute";
the scan covers `/usr/lib`, `/usr/libexec` and `/opt` as well as the six `bin` directories; the
allowlist pins the full path, not the name, and says why: `cap_net_raw` opens `AF_PACKET` sockets,
which leave the box below netfilter, so the egress chain does not apply to a non-stock raw-socket
binary. The listing parser must not cut a path at the first ` cap_` or ` =` (recheck A1 on #313:
`/opt/my cap_helper cap_net_admin=ep` checks `/opt/my`, absent, and reports none): query known
full paths one at a time with `getcap <path>`, or refuse any line that does not parse unambiguously
as `unchecked`. The scan covers every executable mount (`findmnt` without `noexec`: `/data`, `/mnt`,
a split `/bin` and `/sbin` on a system that is not usr-merged), not a fixed list, and any scan error
is a failure (recheck A3). Add `agent_setuid` from `find / -xdev \( -perm -4000 -o -perm -2000 \)
-type f` run as root, refused unless every path is on the distribution allowlist (`sudo`, `su`, `passwd`, `chfn`,
`chsh`, `gpasswd`, `newgrp`, `mount`, `umount`, `fusermount3`, `ssh-keysign`, `unix_chkpwd`,
`chage`, `expiry`, `wall`, `write`); add rootless container sockets (`/run/user/*/docker.sock`,
`/run/user/*/podman/podman.sock`).
*Test that fails on main*: `file-caps.test.ts` (#313): an `as_agent` stand-in that exits 1 for every
call must yield `unchecked`; `/usr/lib/x cap_chown=ep` must yield `found`; `/opt/ping cap_net_raw=ep`
(allowlisted name, wrong path) must yield `found`. `firewall-account.test.ts` fixture: a missing
`agent_setuid` is refused.

**F5 (closed by #310, I6, A4): the guard refuses to run without its lock.** `flock` is required, the
open and the `flock -w 30` each fail the guard, and the lock is opened for append so a link at its
name is not truncated. Kept here so the numbering of the hand-off stays.

**F6 (P1, I4 + I6): the egress lock lives where the agent cannot create it.**
*Where*: `egress.ts` (`EGRESS_LOCK = '/tmp/.maka-egress.lock'`), `applyEgressGuard` envs, `fleet.ts`.
*Why*: the control user opens `/tmp/.maka-egress.lock` in a world-writable directory (#310 opens it
for append, so a link there no longer truncates anything). The agent can still create that name
first: with `fs.protected_regular=1` the control user's open fails and every guard on the box is
refused (no task starts in it until someone removes the file); with it off, the agent holds the
flock and every guard times out after 30 s. The file the guard makes is `0644` under the default
umask, so the agent can also open the existing lock read-only and hold the flock (recheck A4 on
#310). Either way the agent account turns the box off.
*Change*: lock at `$MAKA_ROOT/.egress.lock` (the work root is 710, the agent cannot create entries);
`applyEgressGuard` takes the root in `MAKA_LOCK` from the fleet; the lock is a `0600` regular file
owned by the control user, opened with `O_NOFOLLOW` (`[ -L ]` refused, `umask 077` before the open);
`fail` if the lock's directory is group- or world-writable or the file is not the control user's.
*Test that fails on main*: unit: the lock path in the exec request is under the work root, not
`/tmp`; real-account: a file pre-made at the old and new lock paths by the agent account does not
stop the guard.

**F7 (P2, I4): `WRITE_FILE_SCRIPT`, `READ_SMALL_SCRIPT` and the kept paths are explicit about where
they may point.** `MAKA_FILE` must be a task file (`isTaskFile`: plain parts, no `..`, no dotted part; one
`handoff/<name>` slash is allowed because the runner names `handoff/repro.json` itself, and
`publishForAgent` refuses any slash) and `MAKA_KEEP` entries must be repository paths
(`isRepoPath`) before the script runs; today the host passes fixed names, so this is a guard against
the next caller, not a live hole. *Test*: a `MAKA_FILE` of `handoff/x` or `../x` is refused.

**F8 (P2, I9): the agent's environment is built from an allowlist.**
*Where*: `agent-user.ts` `asAgentUser`.
*Why*: `sudo --preserve-env` hands over everything in the control user's exec environment,
including whatever the provider's exec sets and whatever a future preamble exports.
*Change*: `sudo -n -u <user> -- env -i PATH="$PATH" HOME=... LANG=... <each allowed name>="$name" sh -c
'umask 002; exec "$@"' sh <program> <args>`; the allowed names are the vendor's `env()` keys, the
search tool's, `MAKA_RUN_TOKEN`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `TMPDIR`, `TERM`.
*Test that fails on main*: launch with an extra env `MAKA_TEST_LEAK=1` and a program that dumps its
environment; the dump must not contain it (today it does).

**F9 (P2, every real-account invariant): CI runs the real-account tests.**
*Where*: `.github/workflows/ci.yml`.
*Why*: every test guarded by `canSeparate()` needs root and a second account; hosted runners are not
root, so I3, I4, I10, I11 and I16 have no CI coverage with two accounts. The rechecks keep finding
what those tests would.
*Change*: one job that runs the `cloud-runners` and `cloud-playbooks` test suites inside the
`rehearsal-sandbox` image target of `deploy/Dockerfile` (#301: `maka-agent`, group `maka-box`, real
`sudo`, `getcap`) as root, with `iptables`/`ip6tables` stand-ins on PATH (the fake's), and asserts
that the real-account tests were run, not skipped (count the `skip` reasons in the reporter output
and fail on `needs root`). The tests' `CHANNEL` constant (`nobody`/`nogroup`) becomes an environment
variable so the job can name `maka-agent`.
*Test that fails on main*: the job itself; today the count of skipped real-account tests is above
zero everywhere.

**F10 (P2, I4): transcript chunks are appended through a file descriptor, or built outside the
group-writable directory.**
*Where*: `scripts.ts` `TRANSCRIPT_CHUNK_SCRIPT`.
*Why*: the temporary file is created with `set -C` (good), but each chunk reopens it by name with
`>>` in `claude-config/projects/<key>/`, which the agent group writes; a link swapped in between two
chunks is followed. Today only a sibling task's agent is alive then (the task's own CLI has not
started), so this is the I12 class, but the fix is cheap.
*Change*: build the file in `$MAKA_DIR/.restore-<session>.tmp` (task directory, agent cannot write)
and `mv -fT` it into place at the last chunk, as `PREPARE_SCRIPT` does for the brief; `chgrp`/`chmod 660`
on the temporary before the rename.
*Test that fails on main*: `transcripts-runner.test.ts`: the chunk requests name a temporary under the
task directory, not under `claude-config/`.

**F11 (owner decision, I12): per-task agent accounts.** See section 8.

**F12 (P3, I14 + I15): a test that greps.** One test in `cloud-runners` that fails if `getFile(`
appears in `cloud-runners` or `cloud-playbooks` sources, or if any `*_SCRIPT` constant lacks
`set -u`, or if `asAgentUser` is called with a string built by concatenation outside `machine.ts`.

**F13 (P2, I3): the probe checks the control user's login files.** `AGENT_PROBE_SCRIPT` adds
`agent_login_files`: for `$HOME/.bash_profile`, `.bash_login`, `.profile`, `.bashrc`, `/etc/profile`,
every file in `/etc/profile.d`, `/etc/bash.bashrc` and `$HOME` itself, the file exists only as a
regular file or not at all, is owned by the control user or root, and `as_agent test -w` is false;
any other answer is a finding. *Test that fails on main*: fixture without the fact is refused; a
script-level test with a group-writable `.bashrc` in a scratch `HOME` yields `found`.

**F14 (P1, I6, batch29 A2): a task-code exec re-verifies the rules after the box could have lost
them.** *Where*: `cloud-runners/src/machine.ts` `exec` (`if (options.taskCode && this.unguarded)`).
*Why*: `launch` guards every time; a plain `exec` with `taskCode` (the repository's checks through
`execCheck`, the edit-loop sample, the CLI version check) guards only while `unguarded` is true,
which is set by a `machine_not_running` answer. A box the provider restarts or restores while it
stays "running" to the API (a host move, a crash and reboot, an operator restore) answers normally,
keeps the stale verified state in this process, and runs repo code without rules until the next
`launch`. *Change*: either guard on every `taskCode` exec (the guard is verify-first, so a box with
the rules in place costs one read-only exec), or bind the verified state to the box's boot: the guard
prints `/proc/sys/kernel/random/boot_id`, `RemoteMachine` keeps it, and every `taskCode` exec runs
the guard first unless its script's prologue finds the same boot id (one exec, no extra round trip).
*Test that fails on main*: `egress-wake.test.ts`: after a passing guard, the fake box drops its rules
without answering `machine_not_running` (a `resetRules()` on `FakeInstabox`); the next
`exec(..., { taskCode: true })` must run the guard before the command (today it does not), and a box
whose boot id changed is guarded again.

**Docs to change with the fixes**: `docs/fork/deploy.md` "The agent account" (the paragraph on the
CLI version check and on git; add `flock` and `getcap` to the box image requirements; the lock's
location), `deploy/rehearsal/README.md` (the second account the stand-in needs, F9's container is
the same image).

Not in this model and not for this lane: recheck A5 and A8 (transcript scrub by regex over JSON;
receipt digest vs kept text) are secret-handling and delivery correctness, owned by the secrets work
(#302 and after); recheck C1 to C5 are the mobile app.

## 8. Per-task accounts: does launch need them?

What one account per box means today, with real numbers from the code: `handoff/` and
`claude-config/` are `2770` for the agent group, `workspace/` too, and every CLI of every task on the
box runs as the same uid. So a task whose model was steered (a repository with a malicious test,
a page it fetched) can, for any sibling task of the same invite on the same box:

- read its brief and its transcript (the owner's own text, nothing another person's);
- replace its `result.json` and artifacts before the control user reads them, so the owner sees a
  result the sibling never produced;
- edit its workspace while its checks run or after they passed and before the change is collected,
  so a "verified" change is not what was verified (I11 holds only against the task's own agent);
- read its gateway token from `/proc/<pid>/environ` and spend its budget, up to the task's own cap
  and the invite's daily cap;
- find its task id by `ps` (task directories cannot be listed, but process arguments and `cwd`
  can be read for the same uid).

What it does not mean: no other invite is reachable (I13), the control user and root are not
reachable (I3, I5), no key is reachable that is not already the task's own kind (I8).

Siblings on the launch path exist: a research task and its review run at once, the coding task and
its cross-review do, duties run beside a user's task. So the exposure is real on the first live run,
and bounded to one owner's own tasks harming each other.

**Recommendation: launch without per-task accounts, with this written into
`docs/fork/launch-notes.md` as an accepted risk, and make F11 the first post-launch isolation
change.** Reasons: the patch (`/mnt/project-files/security/r19-4-agent-pool.patch`) is built but
needs a real-account peer test, host config tests, docs and the `taskOver` lease release, and a
box image with N accounts; none of that is a small PR, and F1 to F4 and F6 close root-in-the-box,
which is the class that matters more. The alternative, one task at a time per box, would serialise the
research review and the coding cross-review and is not recommended.

If the owner wants the gap closed before launch instead, the order is: F9 first (the peer test needs
the CI container with accounts), then the patch rebased on F1 to F6 with `MAKA_CLOUD_AGENT_ACCOUNTS`
listing as many accounts as tasks may run at once on a box (the conductor's concurrency per
conversation bounds it), then `deploy.md`. With per-task accounts, I12 becomes: each task directory
holds one account, the group of that account is the task's group, and `handoff/`, `workspace/`,
`claude-config/` are `2770` for that group only; the probe runs once per account; the stop releases
the account only after survivors are confirmed gone.

## 9. Out of scope at launch, kept here so the model is complete

- **Box pool** (`MAKA_CLOUD_BOXES`, off): a box made by the server for one task and slept or
  deleted after. When it comes on, I13 is enforced by the pool's labels instead of the fixed table,
  and I6 must hold across sleep/restore (the guard already re-verifies after a wake). Two open
  violations on that path, listed here so they are not lost: the scrub before a snapshot
  (`cloud-boxes/src/scrub.ts`, `SCRUB_SCRIPT`) runs `git -C $MAKA_REPO_DIR ls-files` as the control
  user inside the agent's repository, which starts `core.fsmonitor` from that repository's config
  (batch24 A1; I1; #312's `control.git` did not touch it), and it writes its file list to
  `/tmp/maka-scrub-env.$$` by name in a world-writable directory (I4). Both fixes: run the scrub's
  repository steps as the agent, or against `control.git`, and keep its temporary file in the task
  directory. The pool's other review items are in `docs/fork/post-launch-backlog.md`.
- **Snapshots** as anything but a recovery aid: a snapshot holds every task's files on the box; it is
  never a trust boundary. I8 (no raw output on disk) is what keeps secrets out of it.
- **Proposed cards**, **plan vault**: no sandbox code of their own; the vault would put a user's own
  vendor login on a box and needs its own model when it is wired.
- **Deep research provenance** (R16-5), **per-task accounts** (this section 8).

## 10. How to use this file

A recheck finding on the sandbox path is filed as "violates I<n>" with a fix spec in section 7's
form (where, why, change, test that fails on main). A finding that violates no invariant is a change
to section 5 first. A PR that changes `egress.ts`, `agent-user.ts`, `scripts.ts`, `machine.ts`,
`process-channel.ts` or the coding `scripts.ts`/`sandbox.ts` says in its description which
invariants it touches and how each still holds.
