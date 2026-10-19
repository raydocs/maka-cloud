import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseExperimentSpec } from '@maka/eval';
import { makeSpec } from '../spec-gen.js';
import {
  SweBenchDataset,
  defaultTestCommand,
  selectStratified,
  terminalBenchTasks,
} from '../suites.js';
import { tempDir } from './fixtures.js';

function row(id: string, repo: string): string {
  return JSON.stringify({
    instance_id: id,
    repo,
    base_commit: 'b'.repeat(40),
    problem_statement: `statement of ${id}`,
    test_patch: `SECRET patch for ${id}`,
    FAIL_TO_PASS: JSON.stringify([`tests::f_${id}`]),
    PASS_TO_PASS: [`tests::p_${id}`],
    hints_text: 'ignored',
  });
}

test('a dataset is split once: tasks are public, tests come out only by id', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'verified.jsonl');
  await writeFile(path, `${row('a__a-1', 'a/a')}\n${row('b__b-2', 'b/b')}\n`);
  const dataset = await SweBenchDataset.read(path);
  assert.equal(dataset.rows.length, 2);
  assert.match(dataset.version, /^sha256:[0-9a-f]{16}$/u);
  const task = dataset.rows[0]?.task;
  assert.deepEqual(Object.keys(task ?? {}).sort(), [
    'baseCommit',
    'id',
    'repo',
    'statement',
    'suite',
    'testCommand',
  ]);
  assert.ok(!JSON.stringify(dataset.rows.map((r) => r.task)).includes('SECRET'));
  const hidden = await dataset.load('a__a-1');
  assert.equal(hidden.testPatch, 'SECRET patch for a__a-1');
  assert.deepEqual(hidden.failToPass, ['tests::f_a__a-1']);
  assert.deepEqual(hidden.passToPass, ['tests::p_a__a-1']);
  await assert.rejects(dataset.load('nope'), /no hidden tests/u);
});

test('a dataset with a repeated id or a missing field is refused', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'dup.jsonl');
  await writeFile(path, `${row('a__a-1', 'a/a')}\n${row('a__a-1', 'a/a')}\n`);
  await assert.rejects(SweBenchDataset.read(path), /duplicate/u);
  await writeFile(path, `${JSON.stringify({ instance_id: 'x' })}\n`);
  await assert.rejects(SweBenchDataset.read(path), /repo is required/u);
});

test('selection is deterministic, stratified by group, and exact in size', () => {
  const items = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `d-${i}`, group: 'django' })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `s-${i}`, group: 'sympy' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `f-${i}`, group: 'flask' })),
  ];
  const pick = (seed: string) => selectStratified(items, (item) => item.group, 10, seed);
  const first = pick('1');
  assert.equal(first.length, 10);
  assert.deepEqual(first, pick('1'));
  assert.notDeepEqual(
    first.map((i) => i.id),
    pick('2').map((i) => i.id),
  );
  const per = (group: string) => first.filter((item) => item.group === group).length;
  assert.deepEqual([per('django'), per('sympy'), per('flask')], [6, 3, 1]);
  assert.deepEqual(
    first.map((i) => i.id),
    [...first.map((i) => i.id)].sort(),
  );
  assert.equal(selectStratified(items, (i) => i.group, 50, '1').length, 50);
  assert.throws(() => selectStratified(items, (i) => i.group, 51, '1'), /cannot pick/u);
  assert.throws(() => selectStratified(items, (i) => i.group, 0, '1'), /positive/u);
});

test('Terminal-Bench tasks are read from a pinned experiment spec', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'tb.json');
  await writeFile(
    path,
    JSON.stringify({
      benchmark: { id: 'terminal-bench-2.1' },
      tasks: [{ id: 'hello-world', input: 'Resolved from the pinned Harbor task' }],
    }),
  );
  const [task] = await terminalBenchTasks(path);
  assert.equal(task?.suite, 'terminal-bench');
  assert.equal(task?.repo, null);
  await writeFile(path, JSON.stringify({ benchmark: { id: 'other' }, tasks: [] }));
  await assert.rejects(terminalBenchTasks(path), /not a Terminal-Bench/u);
});

test('a generated spec parses, names the cloud executor and carries public fields only', () => {
  const spec = makeSpec({
    suite: 'swe-bench-verified',
    tasks: [
      {
        id: 'a__a-1',
        suite: 'swe-bench-verified',
        repo: 'a/a',
        baseCommit: 'b'.repeat(40),
        statement: 'S',
        testCommand: null,
      },
    ],
    benchmarkVersion: 'sha256:abc',
    taskBudgetUsd: 3,
    totalBudgetUsd: 30,
    mode: 'dry-run',
  });
  assert.deepEqual(parseExperimentSpec(JSON.parse(JSON.stringify(spec))), spec);
  assert.equal(spec.executor.kind, 'cloud');
  assert.deepEqual(
    spec.subjects.map((s) => s.id),
    ['claude-agent-sdk', 'codex', 'coding-playbook'],
  );
  assert.deepEqual(spec.tasks[0]?.config, {
    suite: 'swe-bench-verified',
    repo: 'a/a',
    baseCommit: 'b'.repeat(40),
  });
  assert.deepEqual(spec.budget, { taskBudgetUsd: 3, totalBudgetUsd: 30, timeoutSeconds: 3600 });
});

test('the visible test command is an import smoke test per repository', () => {
  assert.equal(defaultTestCommand('django/django'), 'python -c "import django"');
  assert.equal(defaultTestCommand('unknown/repo'), 'true');
});
