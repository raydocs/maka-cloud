import type { RemoteMachine } from './machine.js';
import { assertSafeId, shq } from './shell.js';

/**
 * The Agent SDK talks to the CLI over a channel the SDK trusts: whatever arrives on the CLI's
 * stdin can answer its permission questions. The CLI's tools run as the same user as the CLI, so
 * if that user is also the one who can write the channel, the agent can approve its own denied
 * tool calls. The channel is therefore kept by the sandbox user, in a private directory, and the
 * CLI runs as another user that cannot enter it.
 *
 * The box provides: `user` (an unprivileged account without sudo rights, in `group`), `group`
 * (which also holds the sandbox user), and passwordless `sudo -n` for the sandbox user (the egress
 * guard assumes the same). None of this is known to hold on a real box until a live run has
 * passed `checkAgentIsolation`; until then the SDK path stays off (it needs `agentChannel`) and a
 * box that fails the check is refused.
 */
export interface AgentChannel {
  /** The account the CLI and its tools run as. */
  user: string;
  /** A group of the sandbox user and `user`; a task's workspace belongs to it. */
  group: string;
}

const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/u;

export function assertAgentChannel(channel: AgentChannel): AgentChannel {
  for (const [kind, value] of [
    ['user', channel.user],
    ['group', channel.group],
  ] as const) {
    if (!ACCOUNT_NAME.test(value)) {
      throw new Error(`Unsafe agent channel ${kind}: ${JSON.stringify(value)}`);
    }
  }
  return channel;
}

/**
 * `commandLine` (already quoted) run as the agent's user. The environment is passed on, but PATH is
 * handed over explicitly since sudo replaces it; the shared umask lets the sandbox user read and
 * remove what the agent writes in the workspace.
 */
export function asAgent(commandLine: string, channel: AgentChannel): string {
  return asAgentUser(commandLine, assertAgentChannel(channel).user);
}

/** `asAgent` for a caller that knows the account's name only. */
export function asAgentUser(commandLine: string, user: string): string {
  assertAgentChannel({ user, group: 'x' });
  return `sudo -n -u ${shq(user)} --preserve-env -- sh -c 'umask 002; PATH="$1"; shift; exec "$@"' sh "$PATH" ${commandLine}`;
}

/**
 * Hands a task's directory to the agent's group: the workspace and `handoff` (the brief it reads,
 * the result it writes) are shared (setgid, group-writable), the task directory and the root can
 * be entered by the group but not listed, and `chan` (made by the channel scripts) stays private to
 * the sandbox user. The agent reaches `handoff` by its path, and nothing else in the task directory.
 * stdin-free; values come in as variables.
 */
export const PREPARE_AGENT_SCRIPT = `set -eu
cd "$MAKA_DIR"
root=$(dirname "$MAKA_DIR")
mkdir -p handoff
chgrp "$MAKA_AGENT_GROUP" "$root" . workspace handoff
chmod 710 "$root" .
chmod 2770 workspace handoff
if [ -f handoff/brief.md ]; then
  chgrp "$MAKA_AGENT_GROUP" handoff/brief.md
  chmod 640 handoff/brief.md
fi
# The CLI's configuration directory (its transcripts): the agent writes it, the sandbox user puts a
# kept conversation back into it.
mkdir -p claude-config
chgrp "$MAKA_AGENT_GROUP" claude-config
chmod 2770 claude-config
`;

/**
 * Checks, on a scratch directory laid out like a task's, that the agent's account is not the
 * sandbox user, cannot become root, cannot list, enter, read or write the channel directory or add
 * files to the task directory, can read the brief and write the result in `handoff`, and can write
 * the workspace, in ways the sandbox user can clean up. Prints `FACT <name>=<yes|no|...>`.
 */
export const AGENT_PROBE_SCRIPT = `set -u
umask 077
mkdir -p "$MAKA_ROOT"
scratch=$(mktemp -d "$MAKA_ROOT/.probe.XXXXXX") || { echo "FACT scratch=no"; exit 0; }
made=""
tool_bin() { PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin" command -v "$1" 2>/dev/null || true; }
# Whatever the probe made is taken away again on every way out, a failed probe included.
cleanup() {
  rm -rf "$scratch"
  for entry in $made; do
    bin=\${entry%%:*}; name=\${entry#*:}
    "$bin" -w -X "$name" >/dev/null 2>&1 || sudo -n "$bin" -w -X "$name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
mkdir -m 700 "$scratch/chan"
: > "$scratch/chan/probe.in"
mkdir "$scratch/workspace" "$scratch/handoff"
: > "$scratch/handoff/brief.md"
chgrp "$MAKA_AGENT_GROUP" "$MAKA_ROOT" "$scratch" "$scratch/workspace" "$scratch/handoff" "$scratch/handoff/brief.md" 2>/dev/null || echo "FACT group=no"
chmod 710 "$MAKA_ROOT" "$scratch"
chmod 2770 "$scratch/workspace" "$scratch/handoff"
chmod 640 "$scratch/handoff/brief.md"
as_agent() { sudo -n -u "$MAKA_AGENT_USER" --preserve-env -- "$@"; }
yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
echo "FACT dev_uid=$(id -u)"
echo "FACT agent_uid=$(as_agent id -u 2>/dev/null || echo none)"
echo "FACT agent_sudo=$(yes_no as_agent sudo -n true)"
# A sudo rule for one command (iptables) still lets \`sudo -n true\` fail; \`-l\` says whether the account may run anything.
echo "FACT agent_sudo_list=$(yes_no as_agent sudo -n -l)"
# The sudo policy, asked from the trusted side: what the rules say the account may run, not what a
# few commands it tries happen to do (a rule for one binary, or listpw=always, fails \`sudo -n true\`
# and \`sudo -n -l\` alike). Only the sudo answer "not allowed" is a pass; a query that fails is not.
root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
rc=0
policy=$(root sudo -l -U "$MAKA_AGENT_USER" 2>&1) || rc=$?
if printf '%s' "$policy" | grep -Eq 'is not allowed to run sudo'; then
  echo "FACT agent_sudo_policy=none"
elif [ "$rc" = 0 ]; then
  echo "FACT agent_sudo_policy=granted"
else
  echo "FACT agent_sudo_policy=unknown"
fi
# Privileges the process itself holds, and the files that could hand it some.
caps=$(as_agent sh -c 'grep -E "^Cap(Prm|Eff|Amb):" /proc/self/status' 2>/dev/null || true)
if [ -z "$caps" ]; then echo "FACT agent_caps=unknown"
elif printf '%s\n' "$caps" | awk '{ if ($2 !~ /^0+$/) bad = 1 } END { exit bad ? 0 : 1 }'; then echo "FACT agent_caps=held"
else echo "FACT agent_caps=none"; fi
if command -v getcap >/dev/null 2>&1; then
  filecaps=$(getcap -r /usr/sbin /usr/bin /sbin /bin /usr/local/bin /usr/local/sbin 2>/dev/null | grep -Ei 'cap_(net_admin|sys_admin|setuid|setgid|dac_override|dac_read_search|sys_ptrace|sys_module)' || true)
  if [ -z "$filecaps" ]; then echo "FACT agent_filecaps=none"; else echo "FACT agent_filecaps=found"; fi
else
  echo "FACT agent_filecaps=unchecked"
fi
# Groups that are root by another name, and the sockets that run containers for whoever may write them.
groups=$(as_agent id -Gn 2>/dev/null || true)
if [ -z "$groups" ]; then echo "FACT agent_groups=unknown"; else echo "FACT agent_groups=$groups"; fi
open_sockets=""
for sock in /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /run/podman/podman.sock /var/lib/lxd/unix.socket /var/snap/lxd/common/lxd/unix.socket /run/libvirt/libvirt-sock; do
  if [ -S "$sock" ] && as_agent test -w "$sock" >/dev/null 2>&1; then open_sockets="$open_sockets $sock"; fi
done
if [ -z "$open_sockets" ]; then echo "FACT agent_sockets=none"; else echo "FACT agent_sockets=$open_sockets"; fi
# What the control user runs or keeps its tools in must not be writable by the agent.
writable=""
for path in "$HOME" "$HOME/.maka-cli" "$HOME/.maka-cli/bin" "$MAKA_ROOT" "$(dirname "$MAKA_ROOT")"; do
  if [ -e "$path" ] && as_agent test -w "$path" >/dev/null 2>&1; then writable="$writable $path"; fi
done
if [ -z "$writable" ]; then echo "FACT agent_control_write=none"; else echo "FACT agent_control_write=$writable"; fi
# The firewall itself: can this account change network policy (a capability, a setuid tool)? A
# scratch chain is made and taken away again (also on the way out, if this stops half way).
chain="MAKA_PROBE_$$"
for tool in iptables ip6tables; do
  bin=$(tool_bin "$tool")
  if [ -n "$bin" ]; then
    if as_agent "$bin" -w -N "$chain" >/dev/null 2>&1; then
      made="$made $bin:$chain"
      echo "FACT agent_$tool=yes"
    else
      echo "FACT agent_$tool=no"
    fi
  else
    echo "FACT agent_$tool=absent"
  fi
done
echo "FACT chan_enter=$(yes_no as_agent sh -c 'cd "$1"' sh "$scratch/chan")"
echo "FACT chan_list=$(yes_no as_agent ls "$scratch/chan")"
echo "FACT chan_read=$(yes_no as_agent cat "$scratch/chan/probe.in")"
echo "FACT chan_write=$(yes_no as_agent sh -c ': >> "$1/probe.in"' sh "$scratch/chan")"
echo "FACT chan_create=$(yes_no as_agent sh -c ': > "$1/forged"' sh "$scratch/chan")"
echo "FACT task_list=$(yes_no as_agent ls "$scratch")"
echo "FACT brief_read=$(yes_no as_agent cat "$scratch/handoff/brief.md")"
echo "FACT result_write=$(yes_no as_agent sh -c 'umask 002; : > "$1/result.json"' sh "$scratch/handoff")"
echo "FACT result_cleanup=$(yes_no rm "$scratch/handoff/result.json")"
echo "FACT task_file_write=$(yes_no as_agent sh -c ': > "$1/brief.md.forged"' sh "$scratch")"
echo "FACT workspace_write=$(yes_no as_agent sh -c 'umask 002; : > "$1/f"' sh "$scratch/workspace")"
echo "FACT workspace_cleanup=$(yes_no rm "$scratch/workspace/f")"
`;

const POWERFUL_GROUPS = new Set([
  'root',
  'sudo',
  'wheel',
  'admin',
  'docker',
  'lxd',
  'lxc',
  'libvirt',
  'kvm',
  'disk',
  'shadow',
  'adm',
  'systemd-journal',
  'podman',
]);

/** What the probe found, and what is wrong with it; empty when the box keeps the channel private. */
export function agentIsolationProblems(output: string): string[] {
  const facts = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^FACT ([a-z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match) facts.set(match[1] as string, match[2] as string);
  }
  const problems: string[] = [];
  const devUid = facts.get('dev_uid');
  const agentUid = facts.get('agent_uid');
  if (facts.get('scratch') === 'no') return ['a scratch directory could not be made'];
  if (facts.get('group') === 'no') problems.push('the sandbox user cannot give files to the group');
  if (agentUid === undefined || !/^\d+$/u.test(agentUid)) {
    problems.push('the agent account cannot be used through sudo -n');
  } else if (agentUid === devUid) {
    problems.push('the agent account is the sandbox user');
  }
  const mustBe = (fact: string, expected: string, problem: string): void => {
    if (facts.get(fact) !== expected) problems.push(problem);
  };
  mustBe('agent_sudo', 'no', 'the agent account can use sudo');
  mustBe('agent_sudo_list', 'no', 'the agent account may run commands through sudo');
  mustBe(
    'agent_sudo_policy',
    'none',
    'the sudo rules give the agent account commands to run (or could not be read)',
  );
  mustBe(
    'agent_caps',
    'none',
    'the agent account holds Linux capabilities (or they could not be read)',
  );
  mustBe(
    'agent_filecaps',
    'none',
    'a program carries a capability the agent could use (or file capabilities could not be listed)',
  );
  mustBe('agent_sockets', 'none', 'the agent account can reach a container or VM socket');
  mustBe(
    'agent_control_write',
    'none',
    'the agent account can write where the control user keeps its tools or the tasks',
  );
  const groups = facts.get('agent_groups');
  if (groups === undefined || groups === 'unknown') {
    problems.push('the groups of the agent account could not be read');
  } else if (groups.split(/\s+/u).some((name) => POWERFUL_GROUPS.has(name))) {
    problems.push('the agent account is in a group that is as good as root');
  }
  // Absent is fine (no such tool, no such rules); an answer that is missing or "yes" is not.
  for (const tool of ['iptables', 'ip6tables']) {
    if (facts.get(`agent_${tool}`) !== 'no' && facts.get(`agent_${tool}`) !== 'absent') {
      problems.push(`the agent account can change the firewall (${tool})`);
    }
  }
  mustBe('chan_enter', 'no', 'the agent account can enter the channel directory');
  mustBe('chan_list', 'no', 'the agent account can list the channel directory');
  mustBe('chan_read', 'no', 'the agent account can read the channel');
  mustBe('chan_write', 'no', 'the agent account can write the channel');
  mustBe('chan_create', 'no', 'the agent account can create files in the channel directory');
  mustBe('task_list', 'no', 'the agent account can list a task directory');
  mustBe('brief_read', 'yes', 'the agent account cannot read the brief');
  mustBe('result_write', 'yes', 'the agent account cannot write the result');
  mustBe('result_cleanup', 'yes', 'the sandbox user cannot remove the result the agent wrote');
  mustBe('task_file_write', 'no', 'the agent account can create files in the task directory');
  mustBe('workspace_write', 'yes', 'the agent account cannot write a workspace');
  mustBe('workspace_cleanup', 'yes', 'the sandbox user cannot remove what the agent wrote');
  return problems;
}

/** Runs the probe once on a machine. Throws with every finding when the box does not keep the channel private. */
export async function checkAgentIsolation(
  machine: RemoteMachine,
  channel: AgentChannel,
  signal?: AbortSignal,
): Promise<void> {
  assertAgentChannel(channel);
  const out = await machine.execOk(AGENT_PROBE_SCRIPT, {
    envs: {
      MAKA_ROOT: machine.root,
      MAKA_AGENT_USER: channel.user,
      MAKA_AGENT_GROUP: assertSafeId('group', channel.group),
    },
    timeoutSeconds: 60,
    ...(signal ? { signal } : {}),
  });
  const problems = agentIsolationProblems(out);
  if (problems.length > 0) {
    throw new Error(`the sandbox does not keep the agent channel private: ${problems.join('; ')}`);
  }
}
