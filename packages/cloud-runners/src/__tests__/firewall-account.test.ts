import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { agentIsolationProblems } from '../agent-user.js';
import { exists, setup, until } from './harness.js';

const launchInput = (h: { root: string }, dirName: string, program: string, args: string[]) => ({
  dirName,
  run: 't1',
  preamble: '',
  program,
  args,
  envs: {},
  runToken: `token-${dirName}`,
  workdir: join(h.root, dirName),
});

// Everything a caller could put in a word to run something else as the sandbox user.
const HOSTILE = [
  '; touch "$MAKA_DIR/ran"',
  '&& touch "$MAKA_DIR/ran"',
  'x\ntouch "$MAKA_DIR/ran"',
  '$(touch "$MAKA_DIR/ran")',
  '`touch "$MAKA_DIR/ran"`',
  '\'; touch "$MAKA_DIR/ran"; \'',
  '| touch "$MAKA_DIR/ran"',
  'EOF\ntouch "$MAKA_DIR/ran"\nEOF',
];

test('a program and its arguments reach the agent account as the words they are, never as shell', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  for (const [i, word] of HOSTILE.entries()) {
    const dir = `tsk_fw_word${i}`;
    await machine.prepare(dir);
    const started = await machine.launch(
      launchInput(h, dir, 'sh', ['-c', 'printf %s "$1" > "$MAKA_DIR/arg"', 'sh', word]),
    );
    assert.equal(started, 'started');
    await until(() => exists(join(h.root, dir, 't1.exit')));
    assert.equal(await fs.readFile(join(h.root, dir, 'arg'), 'utf8'), word);
    assert.equal(
      await exists(join(h.root, dir, 'ran')),
      false,
      `shell ran: ${JSON.stringify(word)}`,
    );
  }
  // One account switch per run, and it is the agent's.
  assert.deepEqual(
    await h.sudoUsers(),
    HOSTILE.map(() => 'maka-agent'),
  );
});

test('a program named like shell does not start a second command', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_fw_prog');
  await machine.launch(launchInput(h, 'tsk_fw_prog', 'true; touch "$MAKA_DIR/ran"', []));
  await until(() => exists(join(h.root, 'tsk_fw_prog', 't1.exit')));
  assert.equal(await exists(join(h.root, 'tsk_fw_prog', 'ran')), false);
});

test('a machine with no agent account starts no task code at all', async (t) => {
  const h = await setup({ noAgentChannel: true });
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_fw_none');
  await assert.rejects(
    machine.launch(launchInput(h, 'tsk_fw_none', 'true', [])),
    /no agent account/u,
  );
  assert.equal(await exists(join(h.root, 'tsk_fw_none', 't1.pid')), false);
});

test('the CLI install is its own closed method: it needs an install directory and does not switch account', async (t) => {
  const h = await setup({ installClis: false });
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await assert.rejects(
    machine.launchInstall({ dirName: 'tsk_fw_task', run: 'i-1', install: 'true', runToken: 'x' }),
    /not an install directory/u,
  );
  await machine.prepare('.setup-claude');
  assert.equal(
    await machine.launchInstall({
      dirName: '.setup-claude',
      run: 'i-1',
      install: 'true',
      runToken: 'tok-install',
    }),
    'started',
  );
  await until(() => exists(join(h.root, '.setup-claude', 'i-1.exit')));
  assert.deepEqual(await h.sudoUsers(), []);
});

const FACTS = [
  'FACT dev_uid=0',
  'FACT agent_uid=65534',
  'FACT agent_sudo=no',
  'FACT agent_sudo_list=no',
  'FACT agent_sudo_policy=none',
  'FACT agent_caps=none',
  'FACT agent_filecaps=none',
  'FACT agent_groups=maka-agent maka',
  'FACT agent_sockets=none',
  'FACT agent_control_write=none',
  'FACT agent_login_files=none',
  'FACT agent_iptables=no',
  'FACT agent_ip6tables=absent',
  'FACT chan_enter=no',
  'FACT chan_list=no',
  'FACT chan_read=no',
  'FACT chan_write=no',
  'FACT chan_create=no',
  'FACT task_list=no',
  'FACT task_file_write=no',
  'FACT brief_read=yes',
  'FACT result_write=yes',
  'FACT result_cleanup=yes',
  'FACT workspace_write=yes',
  'FACT workspace_cleanup=yes',
];

test('a box where the agent account can reach the firewall is refused, and a missing answer is not a good one', () => {
  assert.deepEqual(agentIsolationProblems(FACTS.join('\n')), []);
  const without = (fact: string, replacement?: string) =>
    FACTS.filter((line) => !line.startsWith(`FACT ${fact}=`))
      .concat(replacement === undefined ? [] : [`FACT ${fact}=${replacement}`])
      .join('\n');
  const cases: Array<[string, RegExp]> = [
    [without('agent_sudo_list', 'yes'), /may run commands through sudo/u],
    [without('agent_sudo_list'), /may run commands through sudo/u],
    // A sudo rule for one binary hides from every command the agent tries; the policy says it.
    [without('agent_sudo_policy', 'granted'), /sudo rules give the agent account commands/u],
    [without('agent_sudo_policy', 'unknown'), /sudo rules give the agent account commands/u],
    [without('agent_sudo_policy'), /sudo rules give the agent account commands/u],
    [without('agent_caps', 'held'), /holds Linux capabilities/u],
    [without('agent_caps', 'unknown'), /holds Linux capabilities/u],
    [without('agent_filecaps', 'found'), /carries a capability/u],
    [without('agent_filecaps', 'unchecked'), /carries a capability/u],
    [without('agent_filecaps'), /carries a capability/u],
    [without('agent_sockets', ' /var/run/docker.sock'), /container or VM socket/u],
    [without('agent_sockets'), /container or VM socket/u],
    [without('agent_control_write', ' /root/.maka-cli/bin'), /write where the control user/u],
    [without('agent_control_write'), /write where the control user/u],
    [without('agent_login_files', ' /root/.bashrc'), /login shell of the control user/u],
    [without('agent_login_files'), /login shell of the control user/u],
    [without('agent_groups', 'maka-agent docker'), /as good as root/u],
    [without('agent_groups', 'maka-agent sudo'), /as good as root/u],
    [without('agent_groups', 'unknown'), /groups of the agent account could not be read/u],
    [without('agent_groups'), /groups of the agent account could not be read/u],
    [without('agent_iptables', 'yes'), /change the firewall \(iptables\)/u],
    [without('agent_iptables'), /change the firewall \(iptables\)/u],
    [without('agent_ip6tables', 'yes'), /change the firewall \(ip6tables\)/u],
    [without('agent_ip6tables'), /change the firewall \(ip6tables\)/u],
  ];
  for (const [output, expected] of cases) {
    assert.match(agentIsolationProblems(output).join('; '), expected, output);
  }
});
