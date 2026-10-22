import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
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
  'FACT agent_sudo_list=no',
  'FACT agent_sudo_policy=none',
  'FACT agent_caps=none',
  'FACT agent_filecaps=none',
  'FACT agent_groups=maka-agent maka',
  'FACT agent_sockets=none',
  'FACT agent_control_write=none',
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
    [without('task_file_write', 'yes'), /create files in the task directory/u],
    [without('brief_read', 'no'), /cannot read the brief/u],
    [without('result_write', 'no'), /cannot write the result/u],
    [without('result_cleanup', 'no'), /cannot remove the result/u],
    [without('brief_read'), /cannot read the brief/u],
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

async function boxes(
  t: { after(fn: () => Promise<void>): void },
  channel = CHANNEL,
  execPath?: string,
) {
  const h = await setup({
    cloud: { agentChannel: channel },
    ...(execPath === undefined ? {} : { fake: { execPath } }),
  });
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
  // The machine running the test may carry capabilities of its own (a media helper, say); what is
  // tested here is the probe's layout, so its capability scan reads an empty listing.
  const bin = await fs.mkdtemp(join(tmpdir(), 'no-caps-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  await fs.writeFile(join(bin, 'getcap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const { machine, h } = await boxes(t, CHANNEL, `${bin}:${process.env.PATH ?? ''}`);
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

test('the agent account reads the brief and writes the result in the handoff directory, and nothing else of the task directory', {
  skip,
}, async (t) => {
  const { machine, h } = await boxes(t);
  const dir = 'tsk_agent_handoff';
  await machine.prepare(dir, '# the brief\n', undefined, CHANNEL.group);
  await machine.prepareAgent(dir, CHANNEL.group);
  const taskDir = machine.taskDir(dir);
  const asAgentRun = (script: string) =>
    spawnSync('bash', ['-c', asAgent(`sh -c ${JSON.stringify(script)}`, CHANNEL)], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
  // The two paths the agent is told about work for it.
  assert.equal(asAgentRun(`cat ${taskDir}/handoff/brief.md`).stdout, '# the brief\n');
  const manifest = '{"summary":"s","done":[],"notDone":[],"confidence":"high","knownIssues":[]}';
  assert.equal(
    asAgentRun(`umask 002; echo '${manifest}' > ${taskDir}/handoff/result.json`).status,
    0,
  );
  const read = await machine.readResult(dir);
  assert.ok(read.ok, JSON.stringify(read));
  assert.equal(read.bytes.toString('utf8').trim(), manifest);
  // The task directory and the channel stay out of its reach.
  assert.notEqual(asAgentRun(`ls ${taskDir}`).status, 0);
  assert.notEqual(asAgentRun(`: > ${taskDir}/result.json`).status, 0);
  assert.notEqual(asAgentRun(`cat ${taskDir}/chan/t1.in`).status, 0);
  // A new run clears what the last one wrote there, though the agent owns it.
  await machine.launch({
    dirName: dir,
    run: 't2',
    preamble: '',
    program: 'true',
    args: [],
    envs: {},
    runToken: 'tok',
    workdir: join(taskDir, 'workspace'),
  });
  await assert.rejects(fs.stat(join(taskDir, 'handoff', 'result.json')));
  assert.ok(h.root);
});

test('links the agent plants in handoff/ are not followed when the next brief is written', {
  skip,
}, async (t) => {
  const { machine, h } = await boxes(t);
  const dir = 'tsk_agent_links';
  await machine.prepare(dir, 'first\n', undefined, CHANNEL.group);
  await machine.prepareAgent(dir, CHANNEL.group);
  const taskDir = machine.taskDir(dir);
  const victim = join(h.tmp, 'victim.txt');
  await fs.writeFile(victim, "the sandbox user's file\n", { mode: 0o600 });
  const asAgentRun = (script: string) =>
    spawnSync('bash', ['-c', asAgent(`sh -c ${JSON.stringify(script)}`, CHANNEL)], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
  // Another account's link, aimed at a file only the sandbox user owns, where the next brief is staged.
  assert.equal(asAgentRun(`ln -s ${victim} ${taskDir}/handoff/brief.md.tmp`).status, 0);
  // handoff/ is sticky: the agent cannot remove or replace the runner's brief with a link of its own.
  assert.notEqual(asAgentRun(`rm -f ${taskDir}/handoff/brief.md`).status, 0);
  assert.notEqual(asAgentRun(`ln -sf ${victim} ${taskDir}/handoff/brief.md`).status, 0);
  await machine.prepare(dir, 'second\n', undefined, CHANNEL.group);
  await machine.prepareAgent(dir, CHANNEL.group);
  assert.equal(await fs.readFile(victim, 'utf8'), "the sandbox user's file\n");
  assert.equal((await fs.stat(victim)).mode & 0o777, 0o600);
  assert.equal(asAgentRun(`cat ${taskDir}/handoff/brief.md`).stdout, 'second\n');
});

test('a conversation put back by the sandbox user is read and extended by the agent, and read again by the sandbox user', {
  skip,
}, async (t) => {
  const { machine } = await boxes(t);
  const dir = 'tsk_agent_cfg';
  await machine.prepare(dir);
  await machine.prepareAgent(dir, CHANNEL.group);
  const session = '11111111-2222-4333-8444-555555555555';
  await machine.installTranscript({
    dirName: dir,
    projectKey: '-work-x',
    sessionId: session,
    bytes: (async function* () {
      yield Buffer.from('{"n":1}\n');
    })(),
  });
  const file = join(machine.configDir(dir), 'projects', '-work-x', `${session}.jsonl`);
  const asAgentRun = (script: string) =>
    spawnSync('bash', ['-c', asAgent(`sh -c ${JSON.stringify(script)}`, CHANNEL)], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
  assert.equal(asAgentRun(`cat ${file}`).stdout, '{"n":1}\n');
  assert.equal(asAgentRun(`echo '{"n":2}' >> ${file} && mkdir -p ${dirname(file)}/sub`).status, 0);
  assert.equal(await machine.transcriptLines(dir, '-work-x', session), 2);
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
    preamble: '',
    program: 'sleep',
    args: ['300'],
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

test('the agent starts with the variables it was handed and nothing else of the exec environment', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'maka-agent-env-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // A `sudo` that only runs what it is given, as the fake sandbox of the other tests does.
  await fs.writeFile(
    join(dir, 'sudo'),
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|--preserve-env) shift ;; -u) shift 2 ;; --) shift; break ;; *) break ;; esac; done\nexec "$@"\n',
    { mode: 0o755 },
  );
  const run = (names: readonly string[]) =>
    spawnSync('bash', ['-c', asAgent('env', CHANNEL, names)], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        HOME: dir,
        LANG: 'C.UTF-8',
        MAKA_RUN_TOKEN: 'run-token',
        ANTHROPIC_API_KEY: 'sk-run',
        MAKA_REPO_DIR: '/repo',
        MAKA_TEST_LEAK: '1',
        GITHUB_TOKEN: 'ghp_leak',
        BASH_ENV: '/nonexistent',
        LD_PRELOAD: '/nonexistent.so',
      },
    }).stdout.split('\n');
  const seen = run(['ANTHROPIC_API_KEY', 'MAKA_REPO_DIR', 'MAKA_UNSET_BY_EXEC']);
  for (const kept of [
    `HOME=${dir}`,
    'LANG=C.UTF-8',
    'MAKA_RUN_TOKEN=run-token',
    'ANTHROPIC_API_KEY=sk-run',
    'MAKA_REPO_DIR=/repo',
  ]) {
    assert.ok(seen.includes(kept), `${kept} reaches the agent`);
  }
  assert.ok(seen.some((line) => line.startsWith('PATH=')));
  // The account variables `env -i` removed are set from the account the entry runs as.
  const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(seen.includes(`USER=${me}`));
  assert.ok(seen.includes(`LOGNAME=${me}`));
  assert.ok(seen.some((line) => /^SHELL=\/bin\/(ba)?sh$/u.test(line)));
  // Whatever else the exec carried stays behind, and a name that was never set is not made up.
  for (const left of [
    'MAKA_TEST_LEAK',
    'GITHUB_TOKEN',
    'BASH_ENV',
    'LD_PRELOAD',
    'MAKA_UNSET_BY_EXEC',
  ]) {
    assert.equal(
      seen.some((line) => line.startsWith(`${left}=`)),
      false,
      `${left} does not reach the agent`,
    );
  }
  // A name that is not a variable name never reaches the command line.
  assert.throws(() => asAgent('env', CHANNEL, ['A; reboot']), /Unsafe variable name/u);
  // Without the names, the caller's variables are not handed over either.
  assert.equal(
    run([]).some((line) => line.startsWith('ANTHROPIC_API_KEY=')),
    false,
  );
});
