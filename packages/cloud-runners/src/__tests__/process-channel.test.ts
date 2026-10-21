import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
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
import { type Harness, isRunning, setup, settles, until } from './harness.js';

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
          script: buildRunScript({ preamble: FEED_FUNCTION, command: fedCommand(command) }),
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
  const file = join(r.machine.taskDir(r.dir), 't1.in');

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
  assert.deepEqual(await settles(proc.exited), { code: null, signal: 'SIGKILL' });
  assert.deepEqual(exits, [{ code: null, signal: 'SIGKILL' }]);
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
