import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PauseSwitch, PauseWatcher } from '../pause.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

async function tmp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-pause-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('the switch is off until paused, keeps its first time, and leaves no staging file', async (t) => {
  const dir = await tmp(t);
  const spending = new PauseSwitch(join(dir, 'paused'));
  assert.equal(spending.isPaused(), false);
  assert.equal(spending.resume(), false, 'resuming what was not paused changes nothing');
  assert.equal(
    spending.pause(() => Date.UTC(2026, 9, 20, 6)),
    true,
  );
  assert.equal(spending.isPaused(), true);
  assert.equal(spending.pausedAt(), '2026-10-20T06:00:00.000Z');
  assert.equal(
    spending.pause(() => Date.UTC(2026, 9, 21)),
    false,
  );
  assert.equal(spending.pausedAt(), '2026-10-20T06:00:00.000Z', 'the first time stays');
  assert.deepEqual(await readdir(dir), ['paused']);
  assert.equal((await stat(join(dir, 'paused'))).mode & 0o077, 0, 'only the owner can read it');
  // Another process sees the same file.
  assert.equal(new PauseSwitch(join(dir, 'paused')).isPaused(), true);
  assert.equal(spending.resume(), true);
  assert.equal(spending.isPaused(), false);
});

test('a switch that cannot be examined counts as paused', async (t) => {
  const dir = await tmp(t);
  await writeFile(join(dir, 'file'), 'x');
  // A path below a regular file cannot be examined: not "missing", so not safe to spend.
  assert.equal(new PauseSwitch(join(dir, 'file', 'paused')).isPaused(), true);
  // A missing directory is a missing file.
  assert.equal(new PauseSwitch(join(dir, 'nowhere', 'paused')).isPaused(), false);
});

test('a switch file with unreadable content is still a pause', async (t) => {
  const dir = await tmp(t);
  await writeFile(join(dir, 'paused'), 'not json');
  const spending = new PauseSwitch(join(dir, 'paused'));
  assert.equal(spending.isPaused(), true);
  assert.equal(spending.pausedAt(), undefined);
});

test('the command line pauses and resumes a data directory, and refuses to guess one', async (t) => {
  const dir = await tmp(t);
  const run = (command: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [CLI, command], { encoding: 'utf8', env: { PATH: '', ...env } });
  assert.match(run('pause', { MAKA_CLOUD_DATA_DIR: dir }).stdout, /^paused:/u);
  assert.equal(new PauseSwitch(join(dir, 'paused')).isPaused(), true);
  assert.match(run('pause', { MAKA_CLOUD_DATA_DIR: dir }).stdout, /^already paused since 20/u);
  assert.match(run('resume', { MAKA_CLOUD_DATA_DIR: dir }).stdout, /^resumed:/u);
  assert.equal(new PauseSwitch(join(dir, 'paused')).isPaused(), false);
  assert.match(run('resume', { MAKA_CLOUD_DATA_DIR: dir }).stdout, /^was not paused/u);
  const bare = run('pause', {});
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /MAKA_CLOUD_DATA_DIR is not set/u);
});

function watcher(
  t: TestContext,
  over: Partial<ConstructorParameters<typeof PauseWatcher>[0]> = {},
) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const state = { paused: false, calls: 0, warnings: [] as string[] };
  const instance = new PauseWatcher({
    switch: { isPaused: () => state.paused },
    onPause: async () => {
      state.calls += 1;
    },
    onWarning: (message) => state.warnings.push(message),
    pollMs: 1_000,
    ...over,
  });
  return { instance, state };
}

test('the watcher stops work on every tick while paused, and not otherwise', async (t) => {
  const { instance, state } = watcher(t);
  instance.start();
  await instance.tick();
  assert.equal(state.calls, 0, 'not paused: nothing to stop');
  state.paused = true;
  t.mock.timers.tick(1_000);
  await instance.tick();
  t.mock.timers.tick(1_000);
  await instance.tick();
  assert.ok(
    state.calls >= 2,
    'every tick stops what is open, including runs admitted during the pause',
  );
  state.paused = false;
  const before = state.calls;
  t.mock.timers.tick(1_000);
  await instance.tick();
  assert.equal(state.calls, before, 'resumed: nothing more is stopped');
  await instance.close();
});

test('a tick in flight is joined, not repeated', async (t) => {
  const release = deferred();
  const started = deferred();
  let calls = 0;
  const { instance, state } = watcher(t, {
    onPause: async () => {
      calls += 1;
      started.resolve();
      await release.promise;
    },
  });
  state.paused = true;
  const first = instance.tick();
  await started.promise;
  const second = instance.tick();
  assert.equal(first, second);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await instance.close();
});

test('exit by failure: a tick that throws is reported and the next one tries again', async (t) => {
  let attempts = 0;
  const { instance, state } = watcher(t, {
    onPause: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('orchestrator unavailable');
    },
  });
  state.paused = true;
  await instance.tick();
  assert.equal(attempts, 1);
  assert.equal(state.warnings.length, 1);
  await instance.tick();
  assert.equal(attempts, 2, 'the failure did not end the watcher');
  assert.equal(state.warnings.length, 1);
  await instance.close();
});

test('exit by close while idle: the timer is gone and nothing ticks again', async (t) => {
  const { instance, state } = watcher(t);
  state.paused = true;
  instance.start();
  await instance.tick();
  await instance.close();
  const after = state.calls;
  t.mock.timers.tick(10_000);
  await instance.tick();
  assert.equal(state.calls, after);
  instance.start();
  t.mock.timers.tick(10_000);
  assert.equal(state.calls, after, 'a closed watcher cannot be started again');
});

test('exit by close during a tick: close waits for it, then nothing ticks again', async (t) => {
  const release = deferred();
  const started = deferred();
  const { instance, state } = watcher(t, {
    onPause: async () => {
      state.calls += 1;
      started.resolve();
      await release.promise;
    },
  });
  state.paused = true;
  instance.start();
  await started.promise;
  let closed = false;
  const closing = instance.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false, 'close is waiting for the tick in flight');
  release.resolve();
  await closing;
  assert.equal(closed, true);
  const after = state.calls;
  t.mock.timers.tick(10_000);
  assert.equal(state.calls, after);
});

test('exit by close while a tick hangs: close gives up after its wait and says so', async (t) => {
  const { instance, state } = watcher(t, {
    onPause: () => new Promise(() => undefined),
    closeWaitMs: 5_000,
  });
  state.paused = true;
  instance.start();
  const closing = instance.close();
  t.mock.timers.tick(5_000);
  await closing;
  assert.deepEqual(state.warnings, ['A pause tick was still running when the stack closed']);
});
