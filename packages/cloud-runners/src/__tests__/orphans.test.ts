import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InstaboxClient } from '@maka-cloud/instabox';
import { MemorySessionStore } from '../session-store.js';
import { isRunning, reader, setup } from './harness.js';

const WORKING = (event: { type: string; note?: string }) =>
  event.type === 'progress' && event.note === 'working on it';

test('after a restart, stopOrphaned finds the run by task id and stops it', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const events = reader(await h.runners.claude.start(await h.spec('tsk_orphan')));
  await events.until(WORKING);
  const pid = await h.runPid('tsk_orphan');
  assert.equal(await isRunning(pid), true);

  // A new process: no run objects in memory, only the record store and the sandbox.
  const restarted = h.makeRunners();
  await restarted.claude.stopOrphaned('tsk_orphan');
  assert.equal(await isRunning(pid), false);
  assert.ok(h.revoked.includes('orphan:tsk_orphan'));
  assert.equal(h.fake.leases.size, 0);

  // The old process's stream notices the process is gone.
  const rest = await events.rest();
  assert.match(JSON.stringify(rest), /was killed/);

  await restarted.claude.stopOrphaned('tsk_orphan');
  await restarted.claude.stopOrphaned('tsk_never_existed');
});

test('even with no record of the task, the known machines are searched by task id', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const events = reader(await h.runners.claude.start(await h.spec('tsk_norecord')));
  await events.until(WORKING);
  const pid = await h.runPid('tsk_norecord');

  const restarted = h.makeRunners({ sessions: new MemorySessionStore() });
  await restarted.codex.stopOrphaned('tsk_norecord');
  assert.equal(await isRunning(pid), false);
  await events.rest();
});

test('stopOrphaned gives up when its signal aborts', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await assert.rejects(h.runners.claude.stopOrphaned('tsk_any', { signal: AbortSignal.abort() }));
});

test('sweepOrphans stops live runs of tasks the log does not know and leaves known ones', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const known = reader(await h.runners.claude.start(await h.spec('tsk_known')));
  const stray = reader(await h.runners.claude.start(await h.spec('tsk_stray')));
  await known.until(WORKING);
  await stray.until(WORKING);
  const knownPid = await h.runPid('tsk_known');
  const strayPid = await h.runPid('tsk_stray');

  const restarted = h.makeRunners();
  const result = await restarted.sweepOrphans(['tsk_known']);
  assert.deepEqual(result, { stopped: ['tsk_stray'], failed: [] });
  assert.equal(await isRunning(strayPid), false);
  assert.equal(await isRunning(knownPid), true);
  assert.ok(h.revoked.includes('orphan:tsk_stray'));
  assert.ok(!h.revoked.includes('orphan:tsk_known'));

  await restarted.claude.stopOrphaned('tsk_known');
  await known.rest();
  await stray.rest();
});

test('sweepOrphans reports an unreachable sandbox instead of throwing', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const down = new InstaboxClient({
    apiKey: 'x',
    baseUrl: 'http://127.0.0.1:9',
    fetch: async () => {
      throw new Error('connection refused');
    },
    maxRetries: 0,
    sleep: async () => {},
  });
  const restarted = h.makeRunners({ client: down });
  const result = await restarted.sweepOrphans([]);
  assert.deepEqual(result.stopped, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.machineId, h.fake.machineId);
  assert.match(result.failed[0]?.error ?? '', /connection refused/);
});
