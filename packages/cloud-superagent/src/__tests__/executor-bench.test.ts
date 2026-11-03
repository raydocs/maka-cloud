import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BENCH_TASKS,
  type BenchBox,
  formatBenchTable,
  runExecutorBench,
} from '../executor-bench.js';
import { FakeCoder, FakeGitHost } from '../loop.js';
import { FakeSandbox } from '../sandbox.js';

test('bench: each task runs in its own box to green, the merge stays held, skips are reported', async () => {
  const sandbox = new FakeSandbox();
  const destroyed: string[] = [];
  const newBox = async (): Promise<BenchBox> => {
    const { id } = await sandbox.createMachine({ templateId: 'universal', vcpus: 1, memMiB: 512 });
    return {
      sandbox,
      machineId: id,
      createMs: 1,
      destroy: async () => {
        destroyed.push(id);
      },
    };
  };
  const report = await runExecutorBench({
    tasks: BENCH_TASKS.slice(0, 1),
    newBox,
    // A fake host stands in for GitHub so the PR, review and merge gate run offline.
    git: () => ({ git: new FakeGitHost(), repo: 'acme/app' }),
    executors: [
      { kind: 'fake', coder: () => ({ coder: new FakeCoder() }) },
      {
        kind: 'codex',
        skip: 'no OpenAI Secret in the box org',
        coder: () => {
          throw new Error('skipped executors are never built');
        },
      },
    ],
  });
  assert.deepEqual(report.skipped, [
    { executor: 'codex', reason: 'no OpenAI Secret in the box org' },
  ]);
  assert.equal(report.rows.length, 1);
  const [row] = report.rows;
  assert.ok(row);
  assert.equal(row.task, 'fix-add');
  assert.equal(row.green, true, row.error ?? 'not green');
  assert.equal(row.mergeGate, 'held', 'the bench never merges');
  assert.equal(row.usdMicros, 200);
  assert.equal(row.tokens, 40);
  assert.ok(row.pr, 'a PR was opened');
  assert.equal(row.ok, true);
  assert.deepEqual(destroyed, ['box_1']);
  assert.equal(report.summary[0]?.executor, 'fake');
  assert.match(formatBenchTable(report), /\| fake \|/);
  assert.match(formatBenchTable(report), /codex.*no OpenAI Secret/s);
});
