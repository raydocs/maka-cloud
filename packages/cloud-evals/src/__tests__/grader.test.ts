import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CommandRunner, SweBenchGrader, parseSweBenchReport } from '../swebench-grader.js';
import { outcomeOf } from '../sandbox-ops.js';
import { TASK, tempDir } from './fixtures.js';

const HIDDEN = {
  suite: 'swe-bench-verified' as const,
  testPatch: 'T',
  failToPass: [],
  passToPass: [],
};

test('a report puts an instance in exactly one bucket; an error is thrown, not scored', () => {
  const report = (extra: object) =>
    JSON.stringify({
      resolved_ids: [],
      unresolved_ids: [],
      error_ids: [],
      empty_patch_ids: [],
      ...extra,
    });
  assert.equal(parseSweBenchReport(report({ resolved_ids: ['x'] }), 'x').resolved, true);
  assert.equal(parseSweBenchReport(report({ unresolved_ids: ['x'] }), 'x').resolved, false);
  assert.equal(parseSweBenchReport(report({ empty_patch_ids: ['x'] }), 'x').detail, 'empty patch');
  assert.throws(
    () => parseSweBenchReport(report({ error_ids: ['x'] }), 'x'),
    /could not evaluate/u,
  );
  assert.throws(() => parseSweBenchReport(report({}), 'x'), /does not mention/u);
});

test('the SWE-bench grader hands the harness a prediction file and cleans up after it', async (t) => {
  const workDir = await tempDir(t);
  let seen: { argv: readonly string[]; predictions: string } | undefined;
  const runner: CommandRunner = {
    async run(argv, options) {
      const at = argv.indexOf('--predictions_path');
      seen = { argv, predictions: await readFile(argv[at + 1] as string, 'utf8') };
      const runId = argv[argv.indexOf('--run_id') + 1];
      await writeFile(
        join(options.cwd, `maka-cloud-evals.${runId}.json`),
        JSON.stringify({ resolved_ids: [TASK.id] }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const grader = new SweBenchGrader({
    python: '/venv/bin/python',
    datasetPath: '/data/v.jsonl',
    workDir,
    runner,
  });
  const outcome = outcomeOf('diff --git a/a b/a\n+1\n', ['a']);
  const grade = await grader.grade({ task: TASK, hidden: HIDDEN, outcome });
  assert.equal(grade.resolved, true);
  assert.deepEqual(seen?.argv.slice(0, 3), [
    '/venv/bin/python',
    '-m',
    'swebench.harness.run_evaluation',
  ]);
  assert.ok(seen?.argv.includes(TASK.id));
  assert.deepEqual(JSON.parse(seen?.predictions ?? ''), {
    instance_id: TASK.id,
    model_name_or_path: 'maka-cloud-evals',
    model_patch: outcome.patch,
  });
  assert.deepEqual(await readdir(workDir), [], 'the grading directory is removed');
});

test('a harness that exits non-zero is an error, and the directory is still removed', async (t) => {
  const workDir = await tempDir(t);
  const grader = new SweBenchGrader({
    python: 'python',
    datasetPath: '/d.jsonl',
    workDir,
    runner: { run: async () => ({ exitCode: 3, stdout: '', stderr: 'docker not running' }) },
  });
  await assert.rejects(
    grader.grade({ task: TASK, hidden: HIDDEN, outcome: outcomeOf('d', ['a']) }),
    /exited 3: docker not running/u,
  );
  assert.deepEqual(await readdir(workDir), []);
});
