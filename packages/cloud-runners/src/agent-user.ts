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
  const { user } = assertAgentChannel(channel);
  return `sudo -n -u ${shq(user)} --preserve-env -- sh -c 'umask 002; PATH="$1"; shift; exec "$@"' sh "$PATH" ${commandLine}`;
}

/**
 * Hands a task's directory to the agent's group: the workspace is shared (setgid, group-writable),
 * the task directory and the root can be entered by the group but not listed, and `chan` (made by
 * the channel scripts) stays private to the sandbox user. stdin-free; values come in as variables.
 */
export const PREPARE_AGENT_SCRIPT = `set -eu
cd "$MAKA_DIR"
root=$(dirname "$MAKA_DIR")
chgrp "$MAKA_AGENT_GROUP" "$root" . workspace
chmod 710 "$root" .
chmod 2770 workspace
# The CLI's configuration directory (its transcripts): the agent writes it, the sandbox user puts a
# kept conversation back into it.
mkdir -p claude-config
chgrp "$MAKA_AGENT_GROUP" claude-config
chmod 2770 claude-config
`;

/**
 * Checks, on a scratch directory laid out like a task's, that the agent's account is not the
 * sandbox user, cannot become root, cannot list, enter, read or write the channel directory, and
 * can write the workspace in a way the sandbox user can clean up. Prints `FACT <name>=<yes|no|...>`.
 */
export const AGENT_PROBE_SCRIPT = `set -u
umask 077
mkdir -p "$MAKA_ROOT"
scratch=$(mktemp -d "$MAKA_ROOT/.probe.XXXXXX") || { echo "FACT scratch=no"; exit 0; }
trap 'rm -rf "$scratch"' EXIT
mkdir -m 700 "$scratch/chan"
: > "$scratch/chan/probe.in"
mkdir "$scratch/workspace"
chgrp "$MAKA_AGENT_GROUP" "$MAKA_ROOT" "$scratch" "$scratch/workspace" 2>/dev/null || echo "FACT group=no"
chmod 710 "$MAKA_ROOT" "$scratch"
chmod 2770 "$scratch/workspace"
as_agent() { sudo -n -u "$MAKA_AGENT_USER" --preserve-env -- "$@"; }
yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
echo "FACT dev_uid=$(id -u)"
echo "FACT agent_uid=$(as_agent id -u 2>/dev/null || echo none)"
echo "FACT agent_sudo=$(yes_no as_agent sudo -n true)"
echo "FACT chan_enter=$(yes_no as_agent sh -c 'cd "$1"' sh "$scratch/chan")"
echo "FACT chan_list=$(yes_no as_agent ls "$scratch/chan")"
echo "FACT chan_read=$(yes_no as_agent cat "$scratch/chan/probe.in")"
echo "FACT chan_write=$(yes_no as_agent sh -c ': >> "$1/probe.in"' sh "$scratch/chan")"
echo "FACT chan_create=$(yes_no as_agent sh -c ': > "$1/forged"' sh "$scratch/chan")"
echo "FACT task_list=$(yes_no as_agent ls "$scratch")"
echo "FACT workspace_write=$(yes_no as_agent sh -c 'umask 002; : > "$1/f"' sh "$scratch/workspace")"
echo "FACT workspace_cleanup=$(yes_no rm "$scratch/workspace/f")"
`;

/** What the probe found, and what is wrong with it; empty when the box keeps the channel private. */
export function agentIsolationProblems(output: string): string[] {
  const facts = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^FACT ([a-z_]+)=(.*)$/u.exec(line.trim());
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
  const mustBe = (fact: string, expected: 'yes' | 'no', problem: string): void => {
    if (facts.get(fact) !== expected) problems.push(problem);
  };
  mustBe('agent_sudo', 'no', 'the agent account can use sudo');
  mustBe('chan_enter', 'no', 'the agent account can enter the channel directory');
  mustBe('chan_list', 'no', 'the agent account can list the channel directory');
  mustBe('chan_read', 'no', 'the agent account can read the channel');
  mustBe('chan_write', 'no', 'the agent account can write the channel');
  mustBe('chan_create', 'no', 'the agent account can create files in the channel directory');
  mustBe('task_list', 'no', 'the agent account can list a task directory');
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
