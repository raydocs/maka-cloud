import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, reader, setup, terminal } from './harness.js';

const WORKING = (event: { type: string; note?: string }) =>
  event.type === 'progress' && event.note === 'working on it';

test('one exec per machine per tick covers every run on it', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const handles = await Promise.all(
    ['tsk_p1', 'tsk_p2', 'tsk_p3'].map(async (id) => h.runners.claude.start(await h.spec(id))),
  );
  const streams = handles.map((handle) => reader(handle));
  for (const stream of streams) await stream.until(WORKING);

  // All three are running and watched: a single poll names all three.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      const polls = h.fake.execRequests.filter((r) => r.body.cmd.includes('while IFS'));
      if (polls.some((r) => String(r.body.stdin).trim().split('\n').length === 3)) return resolve();
      if (Date.now() > deadline) return reject(new Error('no poll covered all three runs'));
      setTimeout(check, 5);
    };
    check();
  });
  const polls = h.fake.execRequests.filter((r) => r.body.cmd.includes('while IFS'));
  assert.equal(
    polls.length,
    h.runners.fleet.poller.pollCount,
    'one exec per tick, not one per task',
  );

  for (const handle of handles) await handle.cancel();
  for (const stream of streams) await stream.rest();
  assert.equal(h.runners.fleet.poller.watchCount(), 0);
});

test('a few failed polls are ridden out', async (t) => {
  const h = await setup({ cloud: { pollMaxFailures: 5 } });
  t.after(() => h.cleanup());
  let failures = 0;
  h.fake.onExec = (request) => {
    if (request.body.cmd.includes('while IFS') && failures < 3) {
      failures++;
      return {
        status: 503,
        error: { code: 'host_unavailable', message: 'blip', retryable: false },
      };
    }
    return undefined;
  };
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_blip')));
  assert.equal(failures, 3);
  assert.equal(terminal(events)?.type, 'finished');
});

test('a run that grows large output is read in capped slices without repeats', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_slices');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const content = Buffer.alloc(600_000, 'a');
  content[599_999] = 10;
  await writeFile(join(h.root, 'tsk_slices', 't1.out'), content);
  await writeFile(join(h.root, 'tsk_slices', 't1.exit'), '0');
  const watch = h.runners.fleet.poller.watch(machine, { dir: 'tsk_slices', run: 't1' });
  let total = 0;
  for (;;) {
    const update = await watch.next();
    total += update.data.length;
    if (total >= update.size) break;
  }
  watch.stop();
  assert.equal(total, 600_000);
});
