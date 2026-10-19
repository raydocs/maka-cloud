import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, formatFailure, runSeed } from './world.js';

/**
 * Seeds CI runs on every push. FUZZ_SEEDS=<n> runs seeds 1..n instead (with
 * FUZZ_FIRST_SEED to start elsewhere), and FUZZ_SEED=<n> replays one seed.
 * FUZZ_TRACE=1 prints the trace of a replayed seed even when it passes.
 */
const CI_SEEDS = 2_500;
const CATALOGS: Catalog[] = ['memory', 'evicting'];

function seeds(): number[] {
  const one = process.env.FUZZ_SEED;
  if (one !== undefined && one !== '') return [Number(one)];
  const count = Number(process.env.FUZZ_SEEDS ?? CI_SEEDS);
  const first = Number(process.env.FUZZ_FIRST_SEED ?? 1);
  return Array.from({ length: count }, (_, i) => first + i);
}

test('orchestrator invariants hold across seeded random schedules', async () => {
  const list = seeds();
  let runs = 0;
  let tasks = 0;
  for (const seed of list) {
    for (const catalog of CATALOGS) {
      const result = await runSeed(seed, catalog);
      runs += 1;
      tasks += result.tasks;
      if (process.env.FUZZ_TRACE === '1') console.log(formatFailure(result));
      if (result.violations.length > 0) assert.fail(formatFailure(result));
    }
  }
  console.log(
    `schedule fuzzer: ${list.length} seeds (${list[0]}..${list.at(-1)}), ${runs} runs, ${tasks} tasks`,
  );
});
