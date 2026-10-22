import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRunScript } from '../scripts.js';
import { exists, isRunning, setup, until, type Harness } from './harness.js';

const STUBBORN_CHILD = `bash -c 'trap "" TERM; echo $$ > "$MAKA_DIR/child.pid.tmp" && mv -f "$MAKA_DIR/child.pid.tmp" "$MAKA_DIR/child.pid"; while :; do sleep 1; done' > /dev/null 2>&1 &`;

async function runScript(
  h: Harness,
  dirName: string,
  run: string,
  command: string,
): Promise<'started' | 'already' | 'cancelled'> {
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare(dirName);
  return await machine.launch({
    dirName,
    run,
    preamble: '',
    program: 'bash',
    args: ['-c', command],
    envs: {},
    runToken: `token-${dirName}-${run}`,
    workdir: join(h.root, dirName, 'workspace'),
  });
}

/**
 * The stubborn child's pid. `echo $$ > file` creates the file before it writes the pid, so a file
 * that exists may still be empty: that is waited out (`onEmpty` runs when it is seen so), because
 * an empty file read as a pid is 0, which is not running, and fails the assertion that the child
 * outlived its leader.
 */
async function childPid(
  h: Harness,
  dirName: string,
  onEmpty?: () => Promise<void>,
): Promise<number> {
  const file = join(h.root, dirName, 'child.pid');
  let pid = 0;
  let seenEmpty = false;
  await until(async () => {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) return false;
    if (/^\d+\n$/u.test(text)) {
      pid = Number(text);
      return true;
    }
    if (!seenEmpty) {
      seenEmpty = true;
      await onEmpty?.();
    }
    return false;
  });
  return pid;
}

test('a pid file seen while it is still empty is waited for, never read as pid 0', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const file = join(h.root, 'tsk_empty', 'child.pid');
  await fs.mkdir(join(h.root, 'tsk_empty'), { recursive: true });
  await fs.writeFile(file, '');
  // The pid is written only after the helper has looked at the empty file.
  const pid = await childPid(h, 'tsk_empty', () => fs.writeFile(file, '4242\n'));
  assert.equal(pid, 4242);
});

test('children that ignore TERM are killed even after the leader exited normally', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await runScript(h, 'tsk_stub', 't1', STUBBORN_CHILD);
  const child = await childPid(h, 'tsk_stub');
  await until(() => exists(join(h.root, 'tsk_stub', 't1.exit')));
  assert.equal(await isRunning(child), true, 'the child outlives the leader');

  assert.deepEqual(await machine.kill('tsk_stub', { graceTenths: 2 }), ['t1']);
  assert.equal(await isRunning(child), false);
  assert.deepEqual(await machine.kill('tsk_stub'), [], 'nothing is left, so nothing is reported');
});

test('children that ignore TERM are killed while the leader is still running', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await runScript(h, 'tsk_live', 't1', `${STUBBORN_CHILD}\nwhile :; do sleep 1; done`);
  const child = await childPid(h, 'tsk_live');
  const leader = await h.runPid('tsk_live');

  assert.deepEqual(await machine.kill('tsk_live', { graceTenths: 2 }), ['t1']);
  assert.equal(await isRunning(leader), false);
  assert.equal(await isRunning(child), false);
});

test('a kill of one task leaves the processes of another alone', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await runScript(h, 'tsk_a', 't1', `${STUBBORN_CHILD}\nwhile :; do sleep 1; done`);
  await runScript(h, 'tsk_b', 't1', `${STUBBORN_CHILD}\nwhile :; do sleep 1; done`);
  const childA = await childPid(h, 'tsk_a');
  const childB = await childPid(h, 'tsk_b');
  const leaderB = await h.runPid('tsk_b');

  await machine.kill('tsk_a', { graceTenths: 2 });
  assert.equal(await isRunning(childA), false);
  assert.equal(await isRunning(childB), true);
  assert.equal(await isRunning(leaderB), true);
  assert.deepEqual(await machine.liveTaskDirs(), ['tsk_b']);
});

test('the sweep finds a finished run whose child is still alive', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await runScript(h, 'tsk_sweep', 't1', STUBBORN_CHILD);
  await childPid(h, 'tsk_sweep');
  await until(() => exists(join(h.root, 'tsk_sweep', 't1.exit')));
  assert.deepEqual(await machine.liveTaskDirs(), ['tsk_sweep']);
  await machine.kill('tsk_sweep', { graceTenths: 2 });
  assert.deepEqual(await machine.liveTaskDirs(), []);
});

test('a run cancelled before it started never starts', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_early');
  // The kill can overtake the start: it names the run it expects, and the start finds the mark.
  await machine.kill('tsk_early', { cancelRuns: ['t1'] });
  assert.equal(await runScript(h, 'tsk_early', 't1', 'echo ran > "$MAKA_DIR/ran"'), 'cancelled');
  assert.equal(await exists(join(h.root, 'tsk_early', 'ran')), false);
});

test('a run script that finds its cancel mark does not run the command', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_mark');
  const dir = join(h.root, 'tsk_mark');
  await fs.writeFile(join(dir, 't1.cancel'), '');
  const script = buildRunScript({ preamble: '', command: 'echo ran > "$MAKA_DIR/ran"' });
  const result = await machine.exec(script, {
    envs: { MAKA_DIR: dir, MAKA_RUN: 't1', MAKA_WORKDIR: dir },
  });
  assert.equal(result.exitCode, 143);
  assert.equal(await exists(join(dir, 'ran')), false);
  assert.equal((await fs.readFile(join(dir, 't1.exit'), 'utf8')).trim(), '143');
});
