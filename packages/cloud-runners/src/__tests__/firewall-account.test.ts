import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentIsolationProblems, asAgent } from '../agent-user.js';
import { buildRunScript } from '../scripts.js';
import { exists, HARNESS_AGENT, setup, until } from './harness.js';

const launchInput = (h: { root: string }, dirName: string, command: string) => ({
  dirName,
  run: 't1',
  script: buildRunScript({ preamble: '', command }),
  envs: {},
  runToken: `token-${dirName}`,
  workdir: join(h.root, dirName),
});

test('task code is never started as the sandbox user, who may change the firewall', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_fw_plain');
  await assert.rejects(
    machine.launch(launchInput(h, 'tsk_fw_plain', 'touch "$MAKA_DIR/ran"')),
    /would start as the sandbox user/u,
  );
  // Nothing started: no run was written, and the box was not even asked to close its firewall.
  assert.equal(await exists(join(h.root, 'tsk_fw_plain', 't1.pid')), false);
  assert.equal(await exists(join(h.root, 'tsk_fw_plain', 'ran')), false);
});

test('a run handed to another account than the configured agent is refused', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_fw_other');
  const other = asAgent('true', { user: 'root', group: 'maka' });
  await assert.rejects(
    machine.launch(launchInput(h, 'tsk_fw_other', other)),
    /would start as the sandbox user/u,
  );
});

test('the agent account being named in a comment does not make a plain command pass', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_fw_comment');
  const wrapper = asAgent('true', HARNESS_AGENT);
  await assert.rejects(
    machine.launch(launchInput(h, 'tsk_fw_comment', `touch "$MAKA_DIR/ran" # ${wrapper}`)),
    /would start as the sandbox user/u,
  );
  assert.equal(await exists(join(h.root, 'tsk_fw_comment', 'ran')), false);
});

test('the agent wrapper on a later line does not cover the command before it', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_fw_later');
  const command = `touch "$MAKA_DIR/ran"\n${asAgent('true', HARNESS_AGENT)}`;
  await assert.rejects(
    machine.launch(launchInput(h, 'tsk_fw_later', command)),
    /would start as the sandbox user/u,
  );
  assert.equal(await exists(join(h.root, 'tsk_fw_later', 'ran')), false);
});

test('a machine with no agent account starts no task code at all', async (t) => {
  const h = await setup({ noAgentChannel: true });
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_fw_none');
  await assert.rejects(
    machine.launch(launchInput(h, 'tsk_fw_none', asAgent('true', HARNESS_AGENT))),
    /no agent account/u,
  );
});

test('a run wrapped for the agent account starts', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_fw_ok');
  const command = asAgent('sh -c \'echo ok > "$MAKA_DIR/ran"\'', HARNESS_AGENT);
  assert.equal(await machine.launch(launchInput(h, 'tsk_fw_ok', command)), 'started');
  await until(async () => (await h.sudoUsers()).length > 0);
  assert.deepEqual(await h.sudoUsers(), ['maka-agent']);
  await until(() => exists(join(h.root, 'tsk_fw_ok', 't1.exit')));
});

test('the CLI install is the one run that stays the sandbox user, and it still works', async (t) => {
  const h = await setup({ installClis: false });
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('.setup-claude');
  const input = launchInput(h, '.setup-claude', 'true');
  await assert.rejects(machine.launch(input), /would start as the sandbox user/u);
  assert.equal(await machine.launch({ ...input, runsAs: 'sandbox-user' }), 'started');
  await until(() => exists(join(h.root, '.setup-claude', 't1.exit')));
});

const FACTS = [
  'FACT dev_uid=0',
  'FACT agent_uid=65534',
  'FACT agent_sudo=no',
  'FACT agent_sudo_list=no',
  'FACT agent_iptables=no',
  'FACT agent_ip6tables=absent',
  'FACT chan_enter=no',
  'FACT chan_list=no',
  'FACT chan_read=no',
  'FACT chan_write=no',
  'FACT chan_create=no',
  'FACT task_list=no',
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
    [without('agent_iptables', 'yes'), /change the firewall \(iptables\)/u],
    [without('agent_iptables'), /change the firewall \(iptables\)/u],
    [without('agent_ip6tables', 'yes'), /change the firewall \(ip6tables\)/u],
    [without('agent_ip6tables'), /change the firewall \(ip6tables\)/u],
  ];
  for (const [output, expected] of cases) {
    assert.match(agentIsolationProblems(output).join('; '), expected, output);
  }
});
