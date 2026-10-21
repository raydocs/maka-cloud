import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODES } from '@maka-cloud/modes';
import { collect, fixes, setup, terminal, zeroStats } from './harness.js';

const MODES = DEFAULT_MODES;

async function started(
  t: Parameters<typeof setup>[0],
  id: string,
  options: { budgetUsd?: number; lead?: string },
) {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  const spec = {
    ...(await h.spec(id, undefined, options.lead)),
    ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }),
  };
  const events = await collect(await h.runner.start(spec));
  return { h, events };
}

const reasonOf = (events: Parameters<typeof terminal>[0]): string => {
  const end = terminal(events);
  return end?.type === 'failed' ? end.reason : '';
};

test('a deep task with $0.20 is refused before anything is acquired or started', async (t) => {
  const { h, events } = await started(t, 'tsk_d1', { lead: 'maka-mode: deep\n', budgetUsd: 0.2 });
  assert.equal(terminal(events)?.type, 'failed');
  assert.match(
    reasonOf(events),
    /a deep run needs a budget of at least \$10\.00, this one has \$0\.20/,
  );
  assert.deepEqual(h.leases, { acquired: 0, released: 0 });
  assert.equal(h.claude.turns.length, 0);
  assert.equal(h.codex.turns.length, 0);
  zeroStats(h.runner);
});

test('every mode needs its own minimum, and a task with exactly the minimum starts', async (t) => {
  for (const [mode, min] of [
    ['quick', 0.5],
    ['standard', 2],
    ['deep', 10],
  ] as const) {
    const low = await started(t, `tsk_low_${mode}`, {
      lead: `maka-mode: ${mode}\n`,
      budgetUsd: min - 0.01,
    });
    assert.equal(terminal(low.events)?.type, 'failed', `${mode} below its minimum`);
    assert.match(reasonOf(low.events), new RegExp(`a ${mode} run needs a budget of at least`));
    assert.equal(low.h.claude.turns.length, 0);

    const exact = await started(t, `tsk_min_${mode}`, {
      lead: `maka-mode: ${mode}\n`,
      budgetUsd: min,
    });
    assert.ok(exact.h.claude.turns.length > 0, `${mode} at its minimum starts`);
  }
});

test('a brief with no mode line takes its mode from the budget, never above standard', async (t) => {
  const efforts: [number, string][] = [
    [1, 'low'], // quick
    [5, 'high'], // standard
    [500, 'high'], // still standard: deep is something somebody asks for
  ];
  for (const [budgetUsd, effort] of efforts) {
    const { h } = await started(t, `tsk_b${budgetUsd}`, { budgetUsd });
    assert.equal(h.claude.turns[0]?.spec.effort, effort, `$${budgetUsd}`);
  }
  const tiny = await started(t, 'tsk_tiny', { budgetUsd: 0.2 });
  assert.equal(terminal(tiny.events)?.type, 'failed');
  assert.match(
    reasonOf(tiny.events),
    /a quick run needs a budget of at least \$0\.50, this one has \$0\.20/,
  );
  assert.equal(tiny.h.claude.turns.length, 0);
});

test('a task with no budget cap is not held to a minimum', async (t) => {
  const { h, events } = await started(t, 'tsk_nocap', { lead: 'maka-mode: deep\n' });
  assert.deepEqual(terminal(events), { type: 'finished' });
  assert.ok(h.claude.turns.length > 0);
});
