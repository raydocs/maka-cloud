import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { asAgent } from '../agent-user.js';
import { buildRunScript } from '../scripts.js';
import { shq } from '../shell.js';
import { collect, HARNESS_AGENT, isRunning, reader, setup, terminal } from './harness.js';

const WORKING = (event: { type: string; note?: string }) =>
  event.type === 'progress' && event.note === 'working on it';

test('a start sent twice launches one process: the second finds the lock', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_once');
  const input = {
    dirName: 'tsk_once',
    run: 't1',
    script: buildRunScript({
      preamble: '',
      command: asAgent(`sh -c ${shq('echo started >> "$MAKA_DIR/counter"')}`, HARNESS_AGENT),
    }),
    envs: {},
    runToken: 'token-once',
    workdir: join(h.root, 'tsk_once', 'workspace'),
  };
  assert.equal(await machine.launch(input), 'started');
  assert.equal(await machine.launch(input), 'already');
  const watch = h.runners.fleet.poller.watch(machine, { dir: 'tsk_once', run: 't1' });
  for (;;) {
    const update = await watch.next();
    if (typeof update.state === 'object') break;
  }
  watch.stop();
  assert.equal(await fs.readFile(join(h.root, 'tsk_once', 'counter'), 'utf8'), 'started\n');
});

test('a launch whose answer is lost after the process started is not repeated', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  let dropped = false;
  h.fake.onExec = (request) => {
    if (!dropped && request.body.cmd.includes('ALREADY')) {
      dropped = true;
      return { dropResponse: true };
    }
    return undefined;
  };
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_lost')));
  assert.ok(dropped);
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await h.cliCalls('claude'), 1);
});

test('a launch that never reached the sandbox is sent again', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  let dropped = false;
  h.fake.onExec = (request) => {
    if (!dropped && request.body.cmd.includes('ALREADY')) {
      dropped = true;
      return { drop: true };
    }
    return undefined;
  };
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_unsent')));
  assert.ok(dropped);
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await h.cliCalls('claude'), 1);
});

test('cancel stops the CLI process group, releases everything, and ends the stream quietly', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const handle = await h.runners.claude.start(await h.spec('tsk_cancel'));
  const events = reader(handle);
  await events.until(WORKING);
  const pid = await h.runPid('tsk_cancel');
  assert.equal(await isRunning(pid), true);

  await handle.cancel();
  assert.equal(await isRunning(pid), false);
  await handle.cancel();

  const rest = await events.rest();
  assert.equal(terminal(rest), undefined, 'a cancelled run reports no outcome');
  assert.equal(h.fake.leases.size, 0);
  assert.deepEqual(h.revoked, ['tsk_cancel']);
  assert.deepEqual(await h.runners.fleet.machine(h.fake.machineId).liveTaskDirs(), []);
});

test('cancel right after start leaves nothing running, whatever stage the run had reached', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const handle = await h.runners.claude.start(await h.spec('tsk_early'));
  await handle.cancel();
  await collect(handle);
  assert.deepEqual(await h.runners.fleet.machine(h.fake.machineId).liveTaskDirs(), []);
  assert.equal(h.fake.leases.size, 0);
});

test('cancel after the run ended is a no-op', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const handle = await h.runners.claude.start(await h.spec('tsk_done'));
  assert.equal(terminal(await collect(handle))?.type, 'finished');
  await handle.cancel();
});
