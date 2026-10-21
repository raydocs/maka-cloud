import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  type AgentChannel,
  agentIsolationProblems,
  asAgent,
  assertAgentChannel,
  checkAgentIsolation,
} from '../agent-user.js';
import { INPUT_APPEND_SCRIPT } from '../process-channel.js';
import { buildRunScript } from '../scripts.js';
import { setup, until } from './harness.js';

const GOOD = [
  'FACT dev_uid=0',
  'FACT agent_uid=65534',
  'FACT agent_sudo=no',
  'FACT chan_enter=no',
  'FACT chan_list=no',
  'FACT chan_read=no',
  'FACT chan_write=no',
  'FACT chan_create=no',
  'FACT task_list=no',
  'FACT workspace_write=yes',
  'FACT workspace_cleanup=yes',
];

const without = (fact: string, replacement?: string) =>
  GOOD.filter((line) => !line.startsWith(`FACT ${fact}=`))
    .concat(replacement === undefined ? [] : [`FACT ${fact}=${replacement}`])
    .join('\n');

test('a box passes only when every fact of the probe is as the channel needs it', () => {
  assert.deepEqual(agentIsolationProblems(GOOD.join('\n')), []);
  const cases: Array<[string, RegExp]> = [
    [without('agent_uid', '0'), /is the sandbox user/u],
    [without('agent_uid', 'none'), /cannot be used through sudo/u],
    [without('agent_uid'), /cannot be used through sudo/u],
    [without('agent_sudo', 'yes'), /can use sudo/u],
    [without('chan_enter', 'yes'), /enter the channel directory/u],
    [without('chan_list', 'yes'), /list the channel directory/u],
    [without('chan_read', 'yes'), /read the channel/u],
    [without('chan_write', 'yes'), /write the channel/u],
    [without('chan_create', 'yes'), /create files in the channel directory/u],
    [without('task_list', 'yes'), /list a task directory/u],
    [without('workspace_write', 'no'), /cannot write a workspace/u],
    [without('workspace_cleanup', 'no'), /cannot remove what the agent wrote/u],
    // A missing answer is never taken as a good one.
    [without('chan_write'), /write the channel/u],
    [without('workspace_cleanup'), /cannot remove/u],
  ];
  for (const [output, expected] of cases) {
    assert.match(agentIsolationProblems(output).join('; '), expected, output);
  }
});

test('account names that could change the command are refused', () => {
  assert.doesNotThrow(() => assertAgentChannel({ user: 'maka-agent', group: 'maka' }));
  for (const bad of ['', 'Root', 'a b', 'a;b', '$(x)', '-u', 'x'.repeat(40)]) {
    assert.throws(() => assertAgentChannel({ user: bad, group: 'maka' }), /Unsafe/u, bad);
    assert.throws(() => assertAgentChannel({ user: 'maka-agent', group: bad }), /Unsafe/u, bad);
  }
});

// -- the real thing, where this machine has a second account to run the agent as ----------------

const CHANNEL: AgentChannel = { user: 'nobody', group: 'nogroup' };

function canSeparate(): string | undefined {
  if (process.getuid?.() !== 0) return 'needs root, to run commands as another account';
  try {
    execFileSync('sudo', ['-n', '-u', CHANNEL.user, 'id', '-u'], { stdio: 'pipe' });
    execFileSync('getent', ['group', CHANNEL.group], { stdio: 'pipe' });
  } catch {
    return `needs sudo -n and the account ${CHANNEL.user} with the group ${CHANNEL.group}`;
  }
  return undefined;
}
const skip = canSeparate();

async function boxes(t: { after(fn: () => Promise<void>): void }, channel = CHANNEL) {
  const h = await setup({ cloud: { agentChannel: channel } });
  t.after(() => h.cleanup());
  // The account must be able to walk down to the work root: the box image's job.
  for (let dir = h.root; dir !== '/' && dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.startsWith('/tmp/') || dir.startsWith('/var/folders')) await fs.chmod(dir, 0o755);
  }
  await fs.mkdir(h.root, { recursive: true, mode: 0o755 });
  const machine = h.runners.fleet.machine(h.fake.machineId);
  return { h, machine };
}

test('on a box with a second account the probe passes and nothing is left behind', {
  skip,
}, async (t) => {
  const { machine, h } = await boxes(t);
  await checkAgentIsolation(machine, CHANNEL);
  assert.deepEqual(
    (await fs.readdir(h.root)).filter((name) => name.startsWith('.probe')),
    [],
  );
});

test('a box where the agent would be the sandbox user, or could become it, is refused', {
  skip,
}, async (t) => {
  const { machine } = await boxes(t, { user: 'root', group: 'root' });
  await assert.rejects(
    checkAgentIsolation(machine, { user: 'root', group: 'root' }),
    /is the sandbox user.*can use sudo|can use sudo.*is the sandbox user/u,
  );
});

test('what the agent runs cannot write, replace or remove the channel, but works in its workspace; the sandbox user still reads it', {
  skip,
}, async (t) => {
  const { machine } = await boxes(t);
  const dir = 'tsk_agent_chan';
  await machine.prepare(dir);
  await machine.prepareAgent(dir, CHANNEL.group);
  const taskDir = machine.taskDir(dir);
  const append = spawnSync('bash', ['-c', INPUT_APPEND_SCRIPT], {
    input: 'approve\n',
    env: {
      PATH: process.env.PATH ?? '',
      MAKA_DIR: taskDir,
      MAKA_RUN: 't1',
      MAKA_OFFSET: '0',
      MAKA_LEN: '8',
    },
    encoding: 'utf8',
  });
  assert.equal(append.stdout.trim(), 'OK');
  const input = join(taskDir, 'chan', 't1.in');

  const asAgentRun = (script: string) =>
    spawnSync('bash', ['-c', asAgent(`sh -c ${JSON.stringify(script)}`, CHANNEL)], {
      cwd: taskDir,
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
  // The agent is another account...
  assert.notEqual(asAgentRun('id -u').stdout.trim(), String(process.getuid?.()));
  // ...that can neither append a forged answer nor swap or delete the channel.
  assert.notEqual(asAgentRun('echo forged >> chan/t1.in').status, 0);
  assert.notEqual(asAgentRun('echo forged >> /proc/self/fd/0 < chan/t1.in').status, 0);
  assert.notEqual(asAgentRun('rm -f chan/t1.in').status, 0);
  assert.notEqual(asAgentRun('mv chan chan.old').status, 0);
  assert.notEqual(asAgentRun('ln -s /etc/passwd chan2').status, 0);
  assert.equal(await fs.readFile(input, 'utf8'), 'approve\n');
  // Its workspace works, and the sandbox user can clean up after it.
  assert.equal(asAgentRun('echo mine > workspace/note.txt').status, 0);
  assert.equal(await fs.readFile(join(taskDir, 'workspace', 'note.txt'), 'utf8'), 'mine\n');
  await fs.rm(join(taskDir, 'workspace', 'note.txt'));
});

test('a run of the agent account is stopped like any other, with its processes', {
  skip,
}, async (t) => {
  const { machine } = await boxes(t);
  const dir = 'tsk_agent_kill';
  await machine.prepare(dir);
  await machine.prepareAgent(dir, CHANNEL.group);
  const token = randomBytes(8).toString('hex');
  const started = await machine.launch({
    dirName: dir,
    run: 't1',
    script: buildRunScript({ preamble: '', command: asAgent('sleep 300', CHANNEL) }),
    envs: {},
    runToken: token,
    workdir: join(machine.taskDir(dir), 'workspace'),
  });
  assert.equal(started, 'started');
  const sleeping = async () => {
    const out = spawnSync('pgrep', ['-u', CHANNEL.user, '-x', 'sleep'], { encoding: 'utf8' });
    return out.stdout.trim() !== '';
  };
  await until(sleeping);
  await machine.kill(dir, { runs: ['t1'], graceTenths: 2 });
  await until(async () => !(await sleeping()));
});
