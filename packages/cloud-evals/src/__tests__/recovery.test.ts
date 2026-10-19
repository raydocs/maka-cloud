import assert from 'node:assert/strict';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FileAttemptStore, expandExperiment } from '@maka/eval';
import type { UnrecordedSpend } from '@maka-cloud/gateway';
import { runCloudEvalsCli } from '../cli.js';
import { FakeDriver, FakeGrader, FakeHiddenTests } from '../fake.js';
import type { EvalDeps } from '../live.js';
import { CARRIED_SPEND_FILE, carrySpend, priorSpentUsd, type RecoveredSpend } from '../recovery.js';
import { makeSpec } from '../spec-gen.js';
import { TASK, tempDir } from './fixtures.js';

/** A journal that remembers what it was asked, standing in for the next process's view of the file. */
function journal(rows: UnrecordedSpend[], events: string[] = []): RecoveredSpend {
  return {
    unrecorded: () => rows,
    recorded: () => {
      events.push('recorded');
    },
  };
}

function liveSpec(total = 3) {
  return makeSpec({
    suite: 'swe-bench-verified',
    tasks: [TASK],
    benchmarkVersion: 'test',
    subjects: ['codex'],
    taskBudgetUsd: 2,
    totalBudgetUsd: total,
    mode: 'live',
  });
}

async function runLive(
  t: TestContext,
  dir: string,
  recovered: RecoveredSpend | undefined,
  runs: { count: number },
  total = 3,
) {
  const specPath = join(dir, 'spec.json');
  await writeFile(specPath, JSON.stringify(liveSpec(total)));
  const driver = new FakeDriver('codex');
  const counting = {
    run: async (input: Parameters<FakeDriver['run']>[0]) => {
      runs.count += 1;
      return await driver.run(input);
    },
  };
  let stderr = '';
  const code = await runCloudEvalsCli(
    ['run', specPath, '--out', join(dir, 'out'), '--live', '--approve-budget', String(total)],
    {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      liveDeps: async () =>
        ({
          drivers: new Map([['codex', counting]]),
          grader: new FakeGrader(),
          hidden: new FakeHiddenTests(),
          ...(recovered ? { recovered } : {}),
        }) as EvalDeps,
    },
  );
  void t;
  return { code, stderr };
}

test('spend a crashed process left in the journal counts against the experiment budget', async (t) => {
  const dir = await tempDir(t);
  // $1.50 of the $3 total is gone, so a cell that may spend $2 no longer fits.
  const runs = { count: 0 };
  const first = await runLive(t, dir, journal([{ taskId: 'tsk_crashed', usd: 1.5 }]), runs);
  assert.notEqual(first.code, 0, 'a cell the budget has no room for is not a clean run');
  assert.equal(runs.count, 0, 'the cell was not started');

  // The next process finds the journal empty: the file in the experiment directory remembers.
  const second = await runLive(t, dir, journal([]), runs);
  assert.notEqual(second.code, 0);
  assert.equal(runs.count, 0, 'still not started');
  const carried = JSON.parse(await readFile(join(dir, 'out', CARRIED_SPEND_FILE), 'utf8'));
  assert.deepEqual(carried, { tsk_crashed: 1.5 });
});

test('without crashed spend the same cell runs', async (t) => {
  const dir = await tempDir(t);
  const runs = { count: 0 };
  const result = await runLive(t, dir, journal([]), runs);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(runs.count, 1);
});

test('the journal is told to forget only after the carried file is on disk', async (t) => {
  const dir = await tempDir(t);
  let onDisk: string | undefined;
  const recovered: RecoveredSpend = {
    unrecorded: () => [{ taskId: 'tsk_a', usd: 0.25 }],
    recorded: () => {
      // Read synchronously from the test's point of view: the write finished before this call.
      onDisk = 'called';
    },
  };
  const carried = await carrySpend(dir, recovered);
  assert.equal(onDisk, 'called');
  assert.deepEqual([...carried], [['tsk_a', 0.25]]);
  await access(join(dir, CARRIED_SPEND_FILE));
  assert.deepEqual(await readdir(dir), [CARRIED_SPEND_FILE], 'no temp file is left behind');
});

test('a crash between writing the file and forgetting the journal does not count the spend twice', async (t) => {
  const dir = await tempDir(t);
  const rows = [{ taskId: 'tsk_a', usd: 0.25 }];
  await assert.rejects(
    carrySpend(dir, {
      unrecorded: () => rows,
      recorded: () => {
        throw new Error('killed');
      },
    }),
    /killed/u,
  );
  const again = await carrySpend(dir, journal(rows));
  assert.deepEqual([...again], [['tsk_a', 0.25]]);
});

test('an unreadable carried file stops the run instead of starting it from zero', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, CARRIED_SPEND_FILE), '{"tsk_a": "lots"}');
  await assert.rejects(carrySpend(dir, undefined), /invalid amount/u);
  await writeFile(join(dir, CARRIED_SPEND_FILE), 'not json');
  await assert.rejects(carrySpend(dir, undefined));
});

test('an attempt the journal also holds is counted once, at the larger amount; the rest is added', async (t) => {
  const dir = await tempDir(t);
  const runs = { count: 0 };
  const done = await runLive(t, dir, undefined, runs, 10);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(runs.count, 1);
  const spec = liveSpec(10);
  const store = new FileAttemptStore(join(dir, 'out', 'attempts'));
  const [cell] = expandExperiment(spec);
  assert.ok(cell);
  const [attempt] = await store.list(cell.id);
  assert.ok(attempt);
  const recordedCost = attempt.result.costUsd ?? 0;
  assert.ok(recordedCost > 0);
  const taskId = (attempt.result.artifacts as { kind?: string; taskId?: string }[]).find(
    (artifact) => artifact.kind === 'gateway',
  )?.taskId;
  assert.ok(taskId, 'the attempt names the id the gateway journaled it under');

  const attempts = join(dir, 'out', 'attempts');
  assert.equal(await priorSpentUsd(spec, attempts), recordedCost, 'no journal, the recorded cost');
  const dearer = new Map([[taskId, recordedCost + 1]]);
  assert.equal(await priorSpentUsd(spec, attempts, dearer), recordedCost + 1, 'not added twice');
  const cheaper = new Map([[taskId, recordedCost / 2]]);
  assert.equal(await priorSpentUsd(spec, attempts, cheaper), recordedCost);
  const extra = new Map([
    [taskId, recordedCost],
    ['tsk_never_recorded', 0.5],
  ]);
  assert.equal(await priorSpentUsd(spec, attempts, extra), recordedCost + 0.5);
});
