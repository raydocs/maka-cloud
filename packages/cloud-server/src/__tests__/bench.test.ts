import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeRunner, type RunSpec } from '@maka-cloud/orchestrator';
import { eventually, startHarness } from './harness.js';

/**
 * The cost of durability, measured once against plain runs, with the two gates the plan sets.
 * Offline: the runner is a fake, so this measures what we add (the SQLite log, the step log, the
 * takeover), not a sandbox or a model. The method is the one durable-harness's bench uses: the
 * median of per-round differences, with warm-up rounds left out.
 */
const ROUNDS = 25;
const WARM_UP = 5;
/** The gates. The first is the plan's; the second is the whole time of a restart to a run going again. */
const FIRST_TOKEN_GATE_MS = 150;
const RESTART_GATE_MS = 12_000;

const now = () => Number(process.hrtime.bigint()) / 1e6;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

test('bench: the first token of a durable task is within 150 ms of a plain run (median of per-round differences, warm-up left out)', async (t) => {
  const h = await startHarness(t, {
    fake: { onStart: (run) => run.progress('first token') },
  });
  const orchestrator = h.server.orchestrator;
  const info = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(info);

  const plainRound = async (): Promise<number> => {
    const runner = new FakeRunner({ onStart: (run) => run.progress('first token') });
    const started = now();
    const run = await runner.start({ taskId: 'plain' } as unknown as RunSpec);
    const first = await run.events[Symbol.asyncIterator]().next();
    assert.equal(first.value?.type, 'progress');
    const took = now() - started;
    await run.cancel();
    return took;
  };
  const durableRound = async (): Promise<number> => {
    const started = now();
    const { taskId } = await orchestrator.delegate(info, { runner: 'fake', brief: 'x' });
    await eventually(
      () => orchestrator.status(info, taskId).progress.includes('first token'),
      'the first token',
    );
    const took = now() - started;
    await orchestrator.cancel(info, taskId);
    return took;
  };

  const differences: number[] = [];
  const plain: number[] = [];
  const durable: number[] = [];
  for (let round = 0; round < WARM_UP + ROUNDS; round += 1) {
    const a = await plainRound();
    const b = await durableRound();
    if (round < WARM_UP) continue;
    plain.push(a);
    durable.push(b);
    differences.push(b - a);
  }
  const cost = median(differences);
  t.diagnostic(
    `first token: plain median ${median(plain).toFixed(2)} ms, durable median ${median(durable).toFixed(2)} ms, cost (median of differences) ${cost.toFixed(2)} ms over ${ROUNDS} rounds`,
  );
  assert.ok(cost <= FIRST_TOKEN_GATE_MS, `the first token costs ${cost.toFixed(1)} ms more`);
});

test('bench: a killed driver’s task is running again within 12 seconds of the restart', async (t) => {
  const h = await startHarness(t, { fake: { recover: true } });
  const orchestrator = h.server.orchestrator;
  const info = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(info);
  const { taskId } = await orchestrator.delegate(info, { runner: 'fake', brief: 'x' });
  await eventually(() => orchestrator.taskStateOf(taskId) === 'running', 'running');

  const started = now();
  await h.restart();
  await eventually(() => h.fake.recoveries.length === 1, 'the run to come back');
  const took = now() - started;
  assert.equal(h.server.orchestrator.taskStateOf(taskId), 'running');
  t.diagnostic(
    `restart to a run going again: ${took.toFixed(0)} ms (server stop and start included)`,
  );
  assert.ok(took <= RESTART_GATE_MS, `the restart took ${took.toFixed(0)} ms`);
});
