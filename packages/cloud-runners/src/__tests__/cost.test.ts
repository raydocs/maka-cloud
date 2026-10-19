import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerEvent } from '@maka-cloud/orchestrator';
import { collect, setup, terminal } from './harness.js';

/** Dollars per million tokens, round numbers so the sums are easy to check. */
const PRICES = {
  'claude-agent-sdk': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  codex: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
};

function costs(events: RunnerEvent[]): number[] {
  return events.flatMap((event) => (event.type === 'usage' ? [event.costUsd] : []));
}

test('claude runner meters each model call as it happens, then takes the cost the CLI reports', async (t) => {
  const h = await setup({ cloud: { prices: PRICES } });
  t.after(() => h.cleanup());
  await h.setMode('spend');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_spend')));
  assert.equal(terminal(events)?.type, 'finished');
  // m1: 100k in + 50k out = $0.20 (its second event repeats the same call); m2: 200k in = $0.20.
  // The CLI's own total ($0.50) replaces the estimate at the end.
  assert.deepEqual(costs(events), [0.2, 0.4, 0.5]);
});

test('codex runner meters the usage a turn reports', async (t) => {
  const h = await setup({ cloud: { prices: PRICES } });
  t.after(() => h.cleanup());
  await h.setMode('spend');
  const spec = await h.spec('tsk_codex_spend', { runner: 'codex' });
  const events = await collect(await h.runners.codex.start(spec));
  assert.equal(terminal(events)?.type, 'finished');
  // 200k uncached in + 100k cached in + 50k out.
  assert.deepEqual(costs(events), [0.31]);
});

test('a runner stops its CLI once the task budget is spent', async (t) => {
  const h = await setup({ cloud: { prices: PRICES } });
  t.after(() => h.cleanup());
  await h.setMode('spendhang');
  const events = await collect(
    await h.runners.claude.start(await h.spec('tsk_over', { budgetUsd: 0.3 })),
  );
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(
    end?.type === 'failed' ? end.reason : '',
    /budget of \$0\.30 reached \(\$0\.40 spent\)/,
  );
  assert.deepEqual(costs(events), [0.2, 0.4]);
  assert.equal(h.runners.fleet.openRuns, 0, 'the run was cleaned up, its CLI stopped');
});
