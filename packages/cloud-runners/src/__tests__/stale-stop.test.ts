import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRunScript } from '../scripts.js';
import { type Harness, isRunning, reader, setup, until } from './harness.js';

const WORKING = (event: { type: string; note?: string }) =>
  event.type === 'progress' && event.note === 'working on it';

const HANG = 'while :; do sleep 1; done';

async function launch(h: Harness, dirName: string, run: string): Promise<number> {
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare(dirName);
  await machine.launch({
    dirName,
    run,
    script: buildRunScript({ preamble: '', command: HANG }),
    envs: {},
    runToken: `token-${dirName}-${run}`,
    workdir: join(h.root, dirName, 'workspace'),
  });
  return await h.runPid(dirName, run);
}

test('a stop for an earlier attempt leaves the run of a later attempt alone, and says so', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  const second = await launch(h, 'tsk_epochs', 'e2.t1');
  const third = await launch(h, 'tsk_epochs', 'e3.t2');
  const older = await launch(h, 'tsk_epochs', 't0');

  const stopped = await machine.killRuns('tsk_epochs', { graceTenths: 2, upToAttempt: 2 });
  assert.deepEqual(stopped.killed.sort(), ['e2.t1', 't0']);
  assert.deepEqual(stopped.left, ['e3.t2']);
  assert.equal(await isRunning(second), false);
  assert.equal(await isRunning(older), false, 'a run from before attempts were named is older');
  assert.equal(await isRunning(third), true, 'the run of attempt 3 is not attempt 2 to stop');

  // The newer attempt's own stop takes it.
  assert.deepEqual(
    (await machine.killRuns('tsk_epochs', { graceTenths: 2, upToAttempt: 3 })).killed,
    ['e3.t2'],
  );
  assert.equal(await isRunning(third), false);
});

test('a stop that names no attempt still stops every run of the task', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  const second = await launch(h, 'tsk_all', 'e2.t1');
  const third = await launch(h, 'tsk_all', 'e3.t2');
  assert.deepEqual((await machine.kill('tsk_all', { graceTenths: 2 })).sort(), ['e2.t1', 'e3.t2']);
  assert.equal(await isRunning(second), false);
  assert.equal(await isRunning(third), false);
});

test('a delayed stop from attempt 2 does not kill attempt 3 run or revoke its access', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  // Attempt 3 has the task: its run is going, named for its attempt.
  const events = reader(await h.runners.claude.start(await h.spec('tsk_late', { epoch: 3 })));
  await events.until(WORKING);
  const pid = await h.runPid('tsk_late', 'e3.t1');
  assert.equal(await isRunning(pid), true);
  await fs.access(join(h.root, 'tsk_late', 'e3.t1.pid'));
  const leases = h.fake.leases.size;

  // The stop attempt 2 asked for, arriving late, in a process of its own.
  const restarted = h.makeRunners();
  await restarted.claude.stopOrphaned('tsk_late', { epoch: 2 });
  assert.equal(await isRunning(pid), true, 'attempt 3 still has its process');
  assert.deepEqual(h.revokedUpTo, [2], 'the revoke was bounded by the asking attempt');
  assert.equal(h.fake.leases.size, leases, 'and its lease was kept');

  // Attempt 3's own stop does reach it.
  await restarted.claude.stopOrphaned('tsk_late', { epoch: 3 });
  await until(async () => !(await isRunning(pid)));
  assert.deepEqual(h.revokedUpTo, [2, 3]);
  await events.rest();
});

test('a run is named for the attempt that started it', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const withEpoch = reader(await h.runners.claude.start(await h.spec('tsk_named', { epoch: 4 })));
  await withEpoch.until(WORKING);
  const plain = reader(await h.runners.claude.start(await h.spec('tsk_unnamed')));
  await plain.until(WORKING);
  assert.ok(await h.runPid('tsk_named', 'e4.t1'));
  assert.ok(await h.runPid('tsk_unnamed', 't1'));
  const restarted = h.makeRunners();
  await restarted.claude.stopOrphaned('tsk_named');
  await restarted.claude.stopOrphaned('tsk_unnamed');
  await withEpoch.rest();
  await plain.rest();
});
