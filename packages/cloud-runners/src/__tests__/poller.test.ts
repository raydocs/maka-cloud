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

/** A machine whose runs have `content` bytes of output, answering the poll script's way. */
function scriptedMachine(content: () => string) {
  return {
    machineId: 'm_scripted',
    root: '/r',
    logRoot: '/l',
    async execOk(_script: string, options: { stdin?: string }): Promise<string> {
      const out: string[] = [];
      for (const line of (options.stdin ?? '').trim().split('\n')) {
        const [dir, run, off, cap] = line.split(' ');
        const text = content();
        const data = Buffer.from(text).subarray(Number(off), Number(off) + Number(cap));
        out.push(`T ${dir} ${run} running ${text.length} ${data.toString('base64')}`);
      }
      return `${out.join('\n')}\n`;
    },
  } as unknown as import('../machine.js').RemoteMachine;
}

test('a run with a backoff is polled fast while output comes and doubles its wait while it is quiet', async () => {
  const { MachinePoller } = await import('../poller.js');
  const waits: number[] = [];
  const poller = new MachinePoller({ intervalMs: 2_000, sleep: async (ms) => void waits.push(ms) });
  let polls = 0;
  const machine = scriptedMachine(() => {
    polls++;
    // Two polls bring bytes, then nothing new.
    return polls <= 2 ? 'a'.repeat(5 * polls) : 'a'.repeat(10);
  });
  const watch = poller.watch(machine, {
    dir: 'd',
    run: 't1',
    backoff: { minMs: 150, maxMs: 1_000 },
  });
  for (let i = 0; i < 6; i++) await watch.next();
  watch.stop();
  assert.deepEqual(waits.slice(0, 5), [150, 150, 300, 600, 1_000]);
  assert.equal(poller.watchCount(), 0);
});

test('output after a quiet spell brings the fast polling back', async () => {
  const { MachinePoller } = await import('../poller.js');
  const waits: number[] = [];
  const poller = new MachinePoller({ intervalMs: 2_000, sleep: async (ms) => void waits.push(ms) });
  let polls = 0;
  const machine = scriptedMachine(() => {
    polls++;
    return polls === 5 ? 'a'.repeat(3) : polls < 5 ? '' : 'a'.repeat(3);
  });
  const watch = poller.watch(machine, { dir: 'd', run: 't1', backoff: { minMs: 100, maxMs: 800 } });
  for (let i = 0; i < 6; i++) await watch.next();
  watch.stop();
  // Quiet: 200, 400, 800, 800; the bytes of poll 5 reset the wait.
  assert.deepEqual(waits.slice(0, 5), [200, 400, 800, 800, 100]);
});

test('a machine polls at the shortest wait any of its runs asks for, and at the usual one when only plain runs are left', async () => {
  const { MachinePoller } = await import('../poller.js');
  const waits: number[] = [];
  const poller = new MachinePoller({ intervalMs: 2_000, sleep: async (ms) => void waits.push(ms) });
  const machine = scriptedMachine(() => '');
  const plain = poller.watch(machine, { dir: 'd', run: 't1' });
  const fast = poller.watch(machine, { dir: 'd', run: 't2', backoff: { minMs: 100, maxMs: 400 } });
  const both = async (n: number) => {
    for (let i = 0; i < n; i++) await Promise.all([plain.next(), fast.next()]);
  };
  await both(3);
  fast.stop();
  const before = waits.length;
  for (let i = 0; i < 3; i++) await plain.next();
  plain.stop();
  // While the fast run was watched, no wait was the usual 2 s; afterwards every wait was.
  assert.ok(
    waits.slice(0, 3).every((ms) => ms <= 400),
    JSON.stringify(waits),
  );
  assert.ok(
    waits.slice(before + 1).every((ms) => ms === 2_000),
    JSON.stringify(waits),
  );
});
