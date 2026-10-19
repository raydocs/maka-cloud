import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRunScript } from '../scripts.js';
import { collect, deferred, exists, isRunning, reader, setup, terminal, until } from './harness.js';

test('the cleanup of a finished run cannot kill the turn that resumed after it', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_next');

  // Park the cleanup's kill (the only one that names runs to cancel) until the resume is running.
  const parked = deferred();
  const release = deferred();
  let held = false;
  const exec = h.client.exec.bind(h.client);
  h.client.exec = async (machineId, request, options) => {
    if (!held && request.envs?.MAKA_CANCEL_RUNS !== undefined) {
      held = true;
      parked.resolve();
      await release.promise;
    }
    return await exec(machineId, request, options);
  };

  const first = reader(await h.runners.claude.start(spec));
  await first.until((event) => event.type === 'finished');
  await parked.promise; // the orchestrator has its terminal event; the cleanup has not run yet
  await h.setMode('wait');
  const second = await h.runners.claude.resume('tsk_next', { prompt: 'again', spec });
  await until(() => exists(join(h.home, 'fake-cli', 'waiting'))); // the new turn is running

  release.resolve(); // now the old cleanup's kill goes out
  await first.rest(); // and it is done: its stream is closed
  await fs.writeFile(join(h.home, 'fake-cli', 'go'), '');
  const events = await collect(second);
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(events));
});

test('a kill that names runs leaves the other runs of the task, and their output, alone', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_two');
  for (const run of ['t1', 't2']) {
    await machine.launch({
      dirName: 'tsk_two',
      run,
      script: buildRunScript({
        preamble: '',
        command: 'echo out-$MAKA_RUN; while :; do sleep 1; done',
      }),
      envs: {},
      runToken: `token-${run}`,
      workdir: join(h.root, 'tsk_two'),
    });
  }
  const leader = (run: string) =>
    fs.readFile(join(h.root, 'tsk_two', `${run}.pid`), 'utf8').then((text) => Number(text.trim()));
  await h.runPid('tsk_two', 't1');
  await h.runPid('tsk_two', 't2');
  const out = (run: string) => join(h.logRoot, 'tsk_two', `${run}.out`);
  await until(async () => (await exists(out('t1'))) && (await exists(out('t2'))));

  assert.deepEqual(await machine.kill('tsk_two', { graceTenths: 2, runs: ['t1'] }), ['t1']);
  assert.equal(await isRunning(await leader('t1')), false);
  assert.equal(await isRunning(await leader('t2')), true, 'the other run is still alive');
  assert.equal(await exists(out('t1')), false);
  assert.equal(await exists(out('t2')), true, 'and keeps its output');
  assert.equal(
    await exists(join(h.root, 'tsk_two', 't2.cancel')),
    false,
    'and is not marked cancelled',
  );

  assert.deepEqual(
    await machine.kill('tsk_two', { graceTenths: 2 }),
    ['t2'],
    'without runs, the whole task',
  );
});
