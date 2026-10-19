import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, formatFailure, runSeed } from './world.js';

/** Seeds that found a real bug, replayed on every run. Each fails on the code before its fix. */
const PINNED: Array<{ seed: number; catalog: Catalog; bug: string }> = [
  {
    seed: 10,
    catalog: 'memory',
    bug: 'a delegate already under way when its token was rotated still recorded its task',
  },
  {
    seed: 7,
    catalog: 'memory',
    bug: 'spend a run reported after its cancel was requested was never recorded',
  },
];

for (const { seed, catalog, bug } of PINNED) {
  test(`pinned seed ${seed} (${catalog} catalog): ${bug}`, async () => {
    const result = await runSeed(seed, catalog);
    assert.deepEqual(result.violations, [], formatFailure(result));
  });
}
