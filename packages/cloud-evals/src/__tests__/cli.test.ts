import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { assertLiveApproved, type EvalDeps } from '../live.js';
import { runCloudEvalsCli } from '../cli.js';
import { FakeDriver, FakeGrader, FakeHiddenTests } from '../fake.js';
import { makeSpec } from '../spec-gen.js';
import { TASK, tempDir } from './fixtures.js';

async function cli(argv: string[], liveDeps?: (...args: never[]) => Promise<EvalDeps>) {
  let stdout = '';
  let stderr = '';
  const code = await runCloudEvalsCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...(liveDeps ? { liveDeps: liveDeps as never } : {}),
  });
  return { code, stdout, stderr };
}

async function attemptFiles(dir: string): Promise<number> {
  let count = 0;
  for (const cell of await readdir(join(dir, 'attempts'))) {
    if (cell.startsWith('.')) continue;
    count += (await readdir(join(dir, 'attempts', cell))).length;
  }
  return count;
}

async function syntheticSpec(t: TestContext, mode: 'dry-run' | 'live', extra: string[] = []) {
  const dir = await tempDir(t);
  const specPath = join(dir, 'spec.json');
  const made = await cli([
    'make-spec',
    '--suite',
    'swe-bench-verified',
    '--synthetic',
    '50',
    '--task-budget-usd',
    '5',
    '--total-budget-usd',
    '750',
    '--mode',
    mode,
    '--out',
    specPath,
    ...extra,
  ]);
  assert.equal(made.code, 0, made.stderr);
  return { dir, specPath };
}

test('dry run: 50 synthetic tasks, three fake subjects, a full report, and a second run does nothing', async (t) => {
  const { dir, specPath } = await syntheticSpec(t, 'dry-run');
  const out = join(dir, 'out');
  const first = await cli(['run', specPath, '--out', out]);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout.trim().split('\n')[0] ?? ''), {
    experimentId: 'cloud-evals-swe-bench-verified-50-dry-run',
    cells: 150,
    incomplete: 0,
  });
  assert.equal(await attemptFiles(out), 150);

  const report = join(out, 'report');
  assert.deepEqual((await readdir(report)).sort(), [
    'pareto.svg',
    'per-task.csv',
    'per-task.json',
    'report.md',
    'summary.json',
  ]);
  const summary = JSON.parse(await readFile(join(report, 'summary.json'), 'utf8')) as {
    mode: string;
    pairedCells: number;
    subjects: { subjectId: string; cells: number; resolveRate: number; meanCostUsd: number }[];
  };
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.pairedCells, 150);
  const rate = (id: string) => summary.subjects.find((s) => s.subjectId === id)?.resolveRate ?? NaN;
  assert.ok(rate('coding-playbook') > rate('codex'), 'the fake profiles differ');
  assert.ok(summary.subjects.every((s) => s.cells === 50 && s.meanCostUsd > 0));
  assert.match(await readFile(join(report, 'report.md'), 'utf8'), /Synthetic dry run/u);
  assert.ok((await readFile(join(report, 'per-task.csv'), 'utf8')).split('\n').length > 150);

  const firstSvg = await readFile(join(report, 'pareto.svg'), 'utf8');
  const second = await cli(['run', specPath, '--out', out]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await attemptFiles(out), 150, 'finished cells are not run again');
  assert.equal(
    await readFile(join(report, 'pareto.svg'), 'utf8'),
    firstSvg,
    'the chart is reproducible',
  );
});

test('report rebuilds the files from the experiment directory alone', async (t) => {
  const { dir, specPath } = await syntheticSpec(t, 'dry-run');
  const out = join(dir, 'out');
  await cli(['run', specPath, '--out', out]);
  const before = await readFile(join(out, 'report', 'summary.json'), 'utf8');
  const again = await cli(['report', out]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(await readFile(join(out, 'report', 'summary.json'), 'utf8'), before);
});

test('a dry run needs no flag, and refuses --live', async (t) => {
  const { dir, specPath } = await syntheticSpec(t, 'dry-run');
  const result = await cli([
    'run',
    specPath,
    '--out',
    join(dir, 'out'),
    '--live',
    '--approve-budget',
    '9999',
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /not "live"/u);
});

test('a live spec does nothing without --live, without approval, or below the worst case', async (t) => {
  const { dir, specPath } = await syntheticSpec(t, 'live');
  let built = 0;
  const liveDeps = async (): Promise<EvalDeps> => {
    built += 1;
    throw new Error('must not be built');
  };
  for (const [flags, reason] of [
    [[], /needs --live/u],
    [['--live'], /--approve-budget/u],
    [['--live', '--approve-budget', '749'], /below the worst case \$750/u],
    [['--live', '--approve-budget', 'lots'], /--approve-budget/u],
  ] as const) {
    const result = await cli(['run', specPath, '--out', join(dir, 'out'), ...flags], liveDeps);
    assert.equal(result.code, 2);
    assert.match(result.stderr, reason);
  }
  assert.equal(built, 0, 'nothing was built or contacted');
  await assert.rejects(readdir(join(dir, 'out')), 'no experiment directory was created');
});

test('an approved live run goes through the injected dependencies, never the real ones', async (t) => {
  const { dir, specPath } = await syntheticSpec(t, 'live');
  let built = 0;
  const result = await cli(
    ['run', specPath, '--out', join(dir, 'out'), '--live', '--approve-budget', '750'],
    async () => {
      built += 1;
      return {
        drivers: new Map([
          ['claude-agent-sdk', new FakeDriver('claude-agent-sdk')],
          ['codex', new FakeDriver('codex')],
          ['coding-playbook', new FakeDriver('coding-playbook')],
        ]),
        grader: new FakeGrader(),
        hidden: new FakeHiddenTests(),
      };
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(built, 1);
});

test('the live gate is exact about the worst case and the total', () => {
  const spec = (total: number) =>
    makeSpec({
      suite: 'swe-bench-verified',
      tasks: [TASK],
      benchmarkVersion: 'x',
      taskBudgetUsd: 2,
      totalBudgetUsd: total,
      mode: 'live',
    });
  assertLiveApproved(spec(6), { live: true, approvedUsd: 6 });
  assert.throws(
    () => assertLiveApproved(spec(6), { live: true, approvedUsd: 5.99 }),
    /below the worst case/u,
  );
  assert.throws(
    () => assertLiveApproved(spec(100), { live: true, approvedUsd: 6 }),
    /above the approved/u,
  );
});

test('make-spec has no default for money', async (t) => {
  const dir = await tempDir(t);
  const result = await cli([
    'make-spec',
    '--suite',
    'swe-bench-verified',
    '--synthetic',
    '3',
    '--out',
    join(dir, 's.json'),
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--task-budget-usd is required/u);
});

test('select writes a stratified, reproducible id list from a prepared dataset', async (t) => {
  const dir = await tempDir(t);
  const rows = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({
      instance_id: `r${i % 2}__x-${i}`,
      repo: `org/r${i % 2}`,
      base_commit: 'c'.repeat(40),
      problem_statement: 's',
      test_patch: 'p',
      FAIL_TO_PASS: '[]',
      PASS_TO_PASS: '[]',
    }),
  );
  await writeFile(join(dir, 'd.jsonl'), `${rows.join('\n')}\n`);
  const args = [
    'select',
    '--suite',
    'swe-bench-verified',
    '--dataset',
    join(dir, 'd.jsonl'),
    '--size',
    '6',
    '--seed',
    'a',
  ];
  const one = await cli([...args, '--out', join(dir, 'one.json')]);
  const two = await cli([...args, '--out', join(dir, 'two.json')]);
  assert.equal(one.code, 0, one.stderr);
  assert.equal(
    await readFile(join(dir, 'one.json'), 'utf8'),
    await readFile(join(dir, 'two.json'), 'utf8'),
  );
  const picked = JSON.parse(await readFile(join(dir, 'one.json'), 'utf8')) as { ids: string[] };
  assert.equal(picked.ids.length, 6);
  assert.equal(picked.ids.filter((id) => id.startsWith('r0')).length, 3);
  assert.equal(two.code, 0);
});

// A live smoke may exist, but it must skip unless its env vars are set; they are not set here.
const smoke = process.env.MAKA_EVALS_SMOKE_SPEC;
test('live smoke (skipped unless MAKA_EVALS_SMOKE_SPEC, MAKA_EVALS_SMOKE_OUT and MAKA_EVALS_SMOKE_APPROVE_USD are set)', {
  skip: !(smoke && process.env.MAKA_EVALS_SMOKE_OUT && process.env.MAKA_EVALS_SMOKE_APPROVE_USD),
}, async () => {
  const result = await cli([
    'run',
    smoke as string,
    '--out',
    process.env.MAKA_EVALS_SMOKE_OUT as string,
    '--live',
    '--approve-budget',
    process.env.MAKA_EVALS_SMOKE_APPROVE_USD as string,
  ]);
  assert.equal(result.code, 0, result.stderr);
});
