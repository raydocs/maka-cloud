import { type AgentChannel, asAgent, assertAgentChannel } from '@maka-cloud/runners';

/**
 * Repository scripts (`.agents/setup`, `.agents/resume`) are somebody else's code. The sandbox user
 * has passwordless `sudo -n` (the egress guard needs it), so they never run as that user: they run as
 * the agent's unprivileged account, which cannot become root, change the firewall or touch what the
 * sandbox user owns (the control files, the pinned CLI installs, the checksum tools).
 */
export function asRepoUser(
  script: string,
  channel: AgentChannel,
  names: readonly string[] = [],
): string {
  assertAgentChannel(channel);
  return asAgent(`sh -c ${shq(script)} sh`, channel, names);
}

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prints `FACT <name>=<value>` about the agent account on this box. Run before the first repository
 * script of a box; the box is used for repository code only when `agentProblems` finds nothing.
 */
export const AGENT_CHECK_SCRIPT = `set -u
as_agent() { sudo -n -u "$MAKA_AGENT_USER" --preserve-env -- "$@"; }
echo "FACT dev_uid=$(id -u)"
echo "FACT agent_uid=$(as_agent id -u 2>/dev/null || echo none)"
if as_agent sudo -n true >/dev/null 2>&1; then echo "FACT agent_sudo=yes"; else echo "FACT agent_sudo=no"; fi
if as_agent sh -c 'grep -q "^CapEff:[[:space:]]*0*$" /proc/self/status' >/dev/null 2>&1; then
  echo "FACT agent_nocaps=yes"
else
  echo "FACT agent_nocaps=no"
fi
`;

/** What is wrong with the agent account on a box; empty when repository scripts may run as it. */
export function agentProblems(output: string): string[] {
  const facts = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^FACT ([a-z_]+)=(.*)$/u.exec(line.trim());
    if (match) facts.set(match[1] as string, match[2] as string);
  }
  const problems: string[] = [];
  const devUid = facts.get('dev_uid');
  const agentUid = facts.get('agent_uid');
  if (agentUid === undefined || !/^\d+$/u.test(agentUid)) {
    problems.push('the agent account cannot be used through sudo -n');
  } else if (agentUid === devUid || agentUid === '0') {
    problems.push('the agent account is the sandbox user or root');
  }
  if (facts.get('agent_sudo') !== 'no') problems.push('the agent account can use sudo');
  if (facts.get('agent_nocaps') !== 'yes') problems.push('the agent account holds capabilities');
  return problems;
}
