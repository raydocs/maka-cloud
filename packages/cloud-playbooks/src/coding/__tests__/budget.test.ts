import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, fixes, gate, setup, terminal, testOnly, zeroStats } from './harness.js';

test("the agents' spend is reported as one running total for the task, and usage is not an end", async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    turn.usage(0.1);
    turn.usage(0.4);
    return turn.n === 1 ? testOnly(turn) : fixes(turn);
  };
  const spec = await h.spec('tsk_usage');
  const events = await collect(await h.runner.start(spec));
  assert.deepEqual(terminal(events), { type: 'finished' });
  assert.deepEqual(
    events.filter((event) => event.type === 'usage'),
    [
      { type: 'usage', costUsd: 0.1 },
      { type: 'usage', costUsd: 0.4 },
      { type: 'usage', costUsd: 0.5 },
      { type: 'usage', costUsd: 0.8 },
    ],
  );
  assert.equal(h.claude.turns[0]!.spec.budgetUsd, undefined);
  zeroStats(h.runner);
});

test('each agent run gets what is left of the budget, and the task stops when it is spent', {
  timeout: 60_000,
}, async (t) => {
  const h = await setup(t);
  const spent = gate();
  h.claude.script = async (turn) => {
    if (turn.n === 1) {
      turn.usage(0.6);
      return testOnly(turn);
    }
    turn.usage(0.5);
    spent.open();
    // Keeps working until the coding runner stops it.
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    return 'ok';
  };
  const spec = { ...(await h.spec('tsk_budget')), budgetUsd: 1, budgetRootId: 'tsk_root' };
  const events = await collect(await h.runner.start(spec));
  await spent.promise;
  assert.deepEqual(
    h.claude.turns.map((turn) => turn.spec.budgetUsd),
    [1, 0.4],
  );
  assert.deepEqual(
    h.claude.turns.map((turn) => turn.spec.budgetRootId),
    ['tsk_root', 'tsk_root'],
    'every agent run draws on the same tree',
  );
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(
    end?.type === 'failed' ? end.reason : '',
    /budget of \$1\.00 reached \(\$1\.10 spent\)/,
  );
  // A spent budget is not a vendor failure: nothing is handed over.
  assert.equal(h.codex.turns.length, 0);
  assert.equal(h.claude.open, 0);
  zeroStats(h.runner);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
});

test('the spend an agent run reports as the task is cancelled is reported before the task ends', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    turn.usage(0.2);
    // A metered run settles its last requests as it stops.
    turn.signal.addEventListener('abort', () => turn.usage(0.9), { once: true });
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    return 'ok';
  };
  const handle = await h.runner.start(await h.spec('tsk_cancelcost'));
  // The task is cancelled once it has reported the first spend, so the agent run is being read.
  const reading = gate();
  const usage: number[] = [];
  const ended = (async () => {
    for await (const event of handle.events) {
      if (event.type !== 'usage') continue;
      usage.push(event.costUsd);
      reading.open();
    }
  })();
  await reading.promise;
  await handle.cancel();
  await ended;
  assert.deepEqual(usage, [0.2, 0.9]);
  zeroStats(h.runner);
});

test('an agent run whose stream stays open after its release does not hold the cancel: the spend read so far stands and the failure is reported', async (t) => {
  const failures: string[] = [];
  const h = await setup(t, {
    lastSpendMs: 20,
    onCleanupError: (failure) => failures.push(failure.step),
  });
  h.claude.script = async (turn) => {
    turn.usage(0.2);
    turn.signal.addEventListener('abort', () => turn.usage(0.9), { once: true });
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    return 'ok';
  };
  const realStart = h.claude.start.bind(h.claude);
  h.claude.start = async (spec) => {
    const handle = await realStart(spec);
    return {
      ...handle,
      events: (async function* () {
        yield* handle.events;
        await new Promise<never>(() => {});
      })(),
    };
  };
  const handle = await h.runner.start(await h.spec('tsk_hungstream'));
  const reading = gate();
  const usage: number[] = [];
  const ended = (async () => {
    for await (const event of handle.events) {
      if (event.type !== 'usage') continue;
      usage.push(event.costUsd);
      reading.open();
    }
  })();
  await reading.promise;
  await handle.cancel();
  await ended;
  assert.deepEqual(usage, [0.2, 0.9]);
  assert.deepEqual(failures, ['read the last spend of the agent run']);
  zeroStats(h.runner);
});
