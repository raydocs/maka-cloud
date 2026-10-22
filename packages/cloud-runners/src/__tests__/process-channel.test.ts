import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { asAgent } from '../agent-user.js';
import type { RemoteMachine } from '../machine.js';
import {
  allowedSdkEnv,
  ExecProcess,
  type ExecProcessOptions,
  FEED_FUNCTION,
  fedCommand,
  INPUT_APPEND_SCRIPT,
} from '../process-channel.js';
import type { Watch } from '../poller.js';
import { buildRunScript } from '../scripts.js';
import { shq } from '../shell.js';
import { HARNESS_AGENT, type Harness, isRunning, setup, settles, until } from './harness.js';

interface Rig {
  h: Harness;
  machine: RemoteMachine;
  dir: string;
  run: string;
  token: string;
  out: Buffer[];
  /** Everything the process wrote to its stdout. */
  stdout(): string;
  spawn(command: string, extra?: Partial<ExecProcessOptions>): ExecProcess;
}

async function rig(t: { after(fn: () => Promise<void>): void }, dir: string): Promise<Rig> {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare(dir);
  const token = randomBytes(8).toString('hex');
  const run = 't1';
  const seen: Buffer[] = [];
  const chunks: Buffer[] = [];
  const spawn = (command: string, extra: Partial<ExecProcessOptions> = {}): ExecProcess => {
    const proc = new ExecProcess({
      machine,
      dirName: dir,
      run,
      watch: extra.watch ?? h.runners.fleet.poller.watch(machine, { dir, run }),
      launch: () =>
        machine.launch({
          dirName: dir,
          run,
          preamble: '',
          program: 'sh',
          args: ['-c', command],
          fed: true,
          envs: {},
          runToken: token,
          workdir: `${machine.taskDir(dir)}/workspace`,
        }),
      onOutput: (bytes) => seen.push(bytes),
      stop: () => machine.kill(dir, { runs: [run], graceTenths: 2 }).then(() => undefined),
      startTimeoutMs: 20_000,
      now: Date.now,
      ...extra,
    });
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    return proc;
  };
  return {
    h,
    machine,
    dir,
    run,
    token,
    out: seen,
    stdout: () => Buffer.concat(chunks).toString('utf8'),
    spawn,
  };
}

/** Pids of processes (anywhere on this host, which is the fake sandbox) carrying a run's token. */
async function processesOf(token: string): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const environ = await fs.readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
    if (environ.includes(`MAKA_RUN_TOKEN=${token}`) && (await isRunning(Number(entry)))) {
      found.push(Number(entry));
    }
  }
  return found;
}

const isStopped = (result: unknown): boolean => {
  const exit = result as { code: number | null; signal: string | null };
  return (
    (exit.code === 143 && exit.signal === null) || (exit.code === null && exit.signal === 'SIGKILL')
  );
};

const exitOf = (proc: ExecProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once('exit', (code, signal) => resolve({ code, signal })),
  );

test('an append lands once however often its request is sent, and a file out of step is refused', async (t) => {
  const r = await rig(t, 'tsk_pc_append');
  const send = (extra: Record<string, string>, stdin: string) =>
    r.machine.execOk(INPUT_APPEND_SCRIPT, {
      envs: { MAKA_DIR: r.machine.taskDir(r.dir), MAKA_RUN: r.run, ...extra },
      stdin,
    });
  const file = join(r.machine.taskDir(r.dir), 'chan', 't1.in');

  assert.equal((await send({ MAKA_OFFSET: '0', MAKA_LEN: '4' }, 'abc\n')).trim(), 'OK');
  // The answer was lost and the same request comes again: nothing is written twice.
  assert.equal((await send({ MAKA_OFFSET: '0', MAKA_LEN: '4' }, 'abc\n')).trim(), 'OK');
  assert.equal(await fs.readFile(file, 'utf8'), 'abc\n');
  // The next request continues where the first ended.
  assert.equal((await send({ MAKA_OFFSET: '4', MAKA_LEN: '3' }, 'de\n')).trim(), 'OK');
  assert.equal(await fs.readFile(file, 'utf8'), 'abc\nde\n');
  // A writer that believes the file is somewhere else writes nothing.
  assert.equal((await send({ MAKA_OFFSET: '2', MAKA_LEN: '3' }, 'zz\n')).trim(), 'MISMATCH 7');
  assert.equal(await fs.readFile(file, 'utf8'), 'abc\nde\n');
  // The end marker can be sent again too.
  await send({ MAKA_EOF: '1' }, '');
  await send({ MAKA_EOF: '1' }, '');
  assert.equal(await fs.readFile(file, 'utf8'), 'abc\nde\n');
  assert.ok(await fs.stat(`${file}.eof`));
});

/** Runs the append script as a sandbox would, stdin held open until the test writes it. */
function appendProcess(r: Rig, extra: Record<string, string>) {
  const child = spawn('bash', ['-c', INPUT_APPEND_SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '',
      MAKA_DIR: r.machine.taskDir(r.dir),
      MAKA_RUN: r.run,
      ...extra,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A script that refuses early exits without reading its input, so the write can hit a closed pipe.
  child.stdin.on('error', () => undefined);
  let answer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    answer += chunk.toString('utf8');
  });
  const done = new Promise<string>((resolve) => child.on('close', () => resolve(answer.trim())));
  /** True once the script waits on its input: a `cat` of its own is reading stdin. */
  const reading = async () => {
    const children = await fs
      .readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')
      .catch(() => '');
    for (const pid of children.split(/\s+/u).filter((entry) => entry !== '')) {
      const name = await fs.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
      if (name.trim() === 'cat') return true;
    }
    return false;
  };
  return { child, done, reading };
}

test('two requests for the same bytes racing each other write them once', async (t) => {
  const r = await rig(t, 'tsk_pc_race');
  const file = join(r.machine.taskDir(r.dir), 'chan', 't1.in');
  const request = { MAKA_OFFSET: '0', MAKA_LEN: '5' };
  const original = appendProcess(r, request);
  const retry = appendProcess(r, request);
  // Both are in the script and neither has had its input yet: the state a slow original and its
  // retry are in.
  await until(async () => (await original.reading()) && (await retry.reading()));
  original.child.stdin.end('abcd\n');
  retry.child.stdin.end('abcd\n');

  assert.deepEqual(await Promise.all([original.done, retry.done]), ['OK', 'OK']);
  assert.equal(await fs.readFile(file, 'utf8'), 'abcd\n');
});

test('a request cut off part way is completed by its retry instead of leaving the file out of step', async (t) => {
  const r = await rig(t, 'tsk_pc_partial');
  const file = join(r.machine.taskDir(r.dir), 'chan', 't1.in');
  // The first try appended two bytes of five before it was killed.
  await fs.mkdir(join(r.machine.taskDir(r.dir), 'chan'), { mode: 0o700 });
  await fs.writeFile(file, 'ab');
  const retry = appendProcess(r, { MAKA_OFFSET: '0', MAKA_LEN: '5' });
  retry.child.stdin.end('abcd\n');
  assert.equal(await retry.done, 'OK');
  assert.equal(await fs.readFile(file, 'utf8'), 'abcd\n');

  // What is already there must be a prefix of the request, or the files disagree.
  await fs.writeFile(file, 'zz');
  const other = appendProcess(r, { MAKA_OFFSET: '0', MAKA_LEN: '5' });
  other.child.stdin.end('abcd\n');
  assert.match(await other.done, /^MISMATCH 2/u);
  assert.equal(await fs.readFile(file, 'utf8'), 'zz');
});

test('a request whose input did not arrive whole writes nothing', async (t) => {
  const r = await rig(t, 'tsk_pc_short');
  const file = join(r.machine.taskDir(r.dir), 'chan', 't1.in');
  const short = appendProcess(r, { MAKA_OFFSET: '0', MAKA_LEN: '5' });
  short.child.stdin.end('ab');
  assert.match(await short.done, /^SHORT 2/u);
  await assert.rejects(fs.stat(file));
  // Nothing was left behind next to it either.
  const left = (await fs.readdir(join(r.machine.taskDir(r.dir), 'chan'))).filter((name) =>
    name.startsWith('t1.in'),
  );
  assert.deepEqual(left, []);
});

test('the channel directory is private, and a link in its place or at the input file is refused without writing through it', async (t) => {
  const r = await rig(t, 'tsk_pc_links');
  const taskDir = r.machine.taskDir(r.dir);
  const victim = join(taskDir, 'victim.txt');
  await fs.writeFile(victim, 'keep');

  const ok = appendProcess(r, { MAKA_OFFSET: '0', MAKA_LEN: '2' });
  ok.child.stdin.end('a\n');
  assert.equal(await ok.done, 'OK');
  assert.equal((await fs.stat(join(taskDir, 'chan'))).mode & 0o777, 0o700);

  // The input file replaced by a link to a file outside the channel.
  const input = join(taskDir, 'chan', 't1.in');
  await fs.rm(input);
  await fs.symlink(victim, input);
  const viaFile = appendProcess(r, { MAKA_OFFSET: '0', MAKA_LEN: '2' });
  viaFile.child.stdin.end('x\n');
  assert.match(await viaFile.done, /^UNSAFE /u);
  assert.equal(await fs.readFile(victim, 'utf8'), 'keep');

  // The channel directory itself replaced by a link to another directory.
  await fs.rm(join(taskDir, 'chan'), { recursive: true });
  const elsewhere = join(taskDir, 'elsewhere');
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, join(taskDir, 'chan'));
  const viaDir = appendProcess(r, { MAKA_OFFSET: '0', MAKA_LEN: '2' });
  viaDir.child.stdin.end('x\n');
  assert.match(await viaDir.done, /^UNSAFE /u);
  assert.deepEqual(await fs.readdir(elsewhere), []);

  // A channel directory other users could enter is not private.
  await fs.rm(join(taskDir, 'chan'));
  await fs.mkdir(join(taskDir, 'chan'), { mode: 0o755 });
  await fs.chmod(join(taskDir, 'chan'), 0o755);
  const open = appendProcess(r, { MAKA_OFFSET: '0', MAKA_LEN: '2' });
  open.child.stdin.end('x\n');
  assert.match(await open.done, /^UNSAFE /u);
});

test('what the host writes to stdin reaches the process, its output comes back, and the end of input ends it', async (t) => {
  const r = await rig(t, 'tsk_pc_echo');
  const proc = r.spawn('cat');
  const exited = exitOf(proc);

  proc.stdin.write('first line\n');
  await until(() => r.stdout().includes('first line\n'));
  proc.stdin.write('second ');
  proc.stdin.write('line\n');
  await until(() => r.stdout().includes('second line\n'));
  proc.stdin.end();

  const result = await settles(exited);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(r.stdout(), 'first line\nsecond line\n');
  assert.equal(proc.exitCode, 0);
  // The tee saw the same bytes, in order.
  assert.equal(Buffer.concat(r.out).toString('utf8'), 'first line\nsecond line\n');
  assert.equal(
    r.h.runners.fleet.poller.watchCount(),
    0,
    'the watch is let go when the process ends',
  );
  assert.deepEqual(
    await processesOf(r.token),
    [],
    'nothing of the run is left, the feeder included',
  );
});

test('a write larger than one request, with characters that must not be cut, arrives whole', async (t) => {
  const r = await rig(t, 'tsk_pc_big');
  const proc = r.spawn('cat');
  const exited = exitOf(proc);
  // 70,000 characters of two- and four-byte text: over one request, and a pair of surrogates sits
  // on the boundary at 65,536.
  const text = `${'é'.repeat(65_535)}😀${'語'.repeat(4_000)}\n`;
  proc.stdin.end(text);

  assert.deepEqual(await settles(exited, 30_000), { code: 0, signal: null });
  assert.equal(r.stdout(), text);
  assert.equal(proc.inputBytes, Buffer.byteLength(text));
});

test('a multibyte character split across two writes is passed on whole', async (t) => {
  const r = await rig(t, 'tsk_pc_split');
  const proc = r.spawn('cat');
  const exited = exitOf(proc);
  const bytes = Buffer.from('語\n', 'utf8');
  proc.stdin.write(bytes.subarray(0, 2));
  proc.stdin.write(bytes.subarray(2));
  proc.stdin.end();
  assert.deepEqual(await settles(exited), { code: 0, signal: null });
  assert.equal(r.stdout(), '語\n');
});

test('kill stops the process on the machine, once, and the exit is reported once', async (t) => {
  const r = await rig(t, 'tsk_pc_kill');
  const proc = r.spawn('sleep 300');
  const exits: unknown[] = [];
  proc.on('exit', (code: number | null, signal: string | null) => exits.push({ code, signal }));
  await until(async () => (await processesOf(r.token)).length > 0);

  assert.equal(proc.kill('SIGKILL'), true);
  assert.equal(proc.killed, true);
  await proc.stopped();
  // A stop ends the run in one of two ways, and which depends on whether the run script outlived
  // its TERM long enough to write the exit file: exit 143, or gone before it could (SIGKILL).
  const result = await settles(proc.exited);
  assert.ok(
    isStopped(result),
    `a stopped run ends with 143 or SIGKILL, not ${JSON.stringify(result)}`,
  );
  assert.deepEqual(exits, [result], 'the exit is reported once');
  assert.deepEqual(await processesOf(r.token), []);
  assert.equal(proc.kill('SIGKILL'), false, 'nothing to kill any more');
  assert.equal(r.h.runners.fleet.poller.watchCount(), 0);
});

test('the feeder ends with the run script that started it, input or not', async (t) => {
  const r = await rig(t, 'tsk_pc_feeder');
  // The command never reads its stdin and ends at once; nothing ever ends the input.
  const proc = r.spawn('true');
  assert.deepEqual(await settles(proc.exited), { code: 0, signal: null });
  await until(async () => (await processesOf(r.token)).length === 0);
});

test('a run whose start was cancelled ends as a stopped process', async (t) => {
  const r = await rig(t, 'tsk_pc_cancelled');
  const proc = r.spawn('cat', { launch: async () => 'cancelled' });
  assert.deepEqual(await settles(proc.exited), { code: 143, signal: null });
});

test('a sandbox that cannot be reached is an error of the process, and the process ends', async (t) => {
  const r = await rig(t, 'tsk_pc_down');
  const down: Watch = {
    next: () => Promise.reject(new Error('sandbox unreachable: connection refused')),
    stop: () => undefined,
  };
  const proc = r.spawn('cat', { watch: down, launch: async () => 'started' });
  const errors: Error[] = [];
  proc.on('error', (error: Error) => errors.push(error));
  await proc.exited;
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? '', /unreachable/);
  assert.match(proc.failure?.message ?? '', /unreachable/);
});

test('an error with nobody listening does not take the process down', async (t) => {
  const r = await rig(t, 'tsk_pc_quiet');
  const down: Watch = {
    next: () => Promise.reject(new Error('sandbox unreachable')),
    stop: () => undefined,
  };
  const proc = r.spawn('cat', { watch: down, launch: async () => 'started' });
  await proc.exited;
  assert.ok(proc.failure);
});

test('input past the cap breaks the channel instead of filling the sandbox', async (t) => {
  const r = await rig(t, 'tsk_pc_cap');
  const proc = r.spawn('cat', { maxInputBytes: 100 });
  const written = new Promise<Error | undefined>((resolve) => {
    proc.stdin.write('x'.repeat(200), (error) => resolve(error ?? undefined));
  });
  assert.match((await written)?.message ?? '', /more than 100 bytes/);
  assert.match(proc.failure?.message ?? '', /more than 100 bytes/);
  proc.kill();
  await proc.stopped();
});

test('only the SDK’s own markers of its environment reach the sandbox', () => {
  const env = allowedSdkEnv({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-host',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-host',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_AGENT_SDK_VERSION: '0.3.306',
    CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
    CLAUDE_CODE_SDK_AUTH_TOKEN: 'looks like a credential',
    CLAUDE_AGENT_SDK_NOTE: 'two\nlines',
    CLAUDE_CODE_USE_BEDROCK: '1',
    HOME: '/root',
    LONG: 'x',
    CLAUDE_AGENT_SDK_BIG: 'y'.repeat(500),
  });
  assert.deepEqual(env, {
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_AGENT_SDK_VERSION: '0.3.306',
    CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
  });
});
