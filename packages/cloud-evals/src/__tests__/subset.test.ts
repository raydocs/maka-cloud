import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseExperimentSpec } from '@maka/eval';
import { runCloudEvalsCli } from '../cli.js';
import { tempDir } from './fixtures.js';

const LIST = new URL('../../suites/swe-bench-verified-50.json', import.meta.url);

async function committedList(): Promise<{
  suite: string;
  size: number;
  seed: string;
  version: string;
  source: { instances: number; sha256: string; url: string };
  ids: string[];
}> {
  return JSON.parse(await readFile(LIST, 'utf8'));
}

test('the committed SWE-bench Verified subset is 50 distinct instance ids with its provenance', async () => {
  const list = await committedList();
  assert.equal(list.suite, 'swe-bench-verified');
  assert.equal(list.size, 50);
  assert.equal(list.ids.length, 50);
  assert.equal(new Set(list.ids).size, 50);
  for (const id of list.ids) assert.match(id, /^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+$/u, id);
  assert.deepEqual(list.ids, [...list.ids].sort(), 'ids are in the order `select` writes them');
  assert.equal(list.source.instances, 500);
  assert.match(list.source.sha256, /^[0-9a-f]{64}$/u);
  assert.match(list.version, /^sha256:[0-9a-f]{16}$/u);
  assert.equal(list.seed, '1');
  // Stratified by repository: no repository takes more than its share of 500 plus rounding.
  const perRepo = new Map<string, number>();
  for (const id of list.ids) {
    const repo = id.split('__')[0] ?? '';
    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
  }
  assert.ok((perRepo.get('django') ?? 0) <= 25, 'django is 231 of 500 instances');
  assert.ok(perRepo.size >= 8, `${[...perRepo.keys()].join(', ')}`);
});

test('make-spec accepts the committed list as --ids-file, in its order', async (t) => {
  const list = await committedList();
  const dir = await tempDir(t);
  // A stand-in dataset with the same ids (the real one is not checked in).
  const rows = [...list.ids, 'zzz__zzz-1'].map((id) =>
    JSON.stringify({
      instance_id: id,
      repo: id.split('__')[0]?.replace('__', '/') ?? 'a/a',
      base_commit: 'b'.repeat(40),
      problem_statement: `statement of ${id}`,
      test_patch: 'p',
      FAIL_TO_PASS: ['f'],
      PASS_TO_PASS: ['p'],
    }),
  );
  await writeFile(join(dir, 'verified.jsonl'), `${rows.join('\n')}\n`);
  const specPath = join(dir, 'spec.json');
  let stderr = '';
  const code = await runCloudEvalsCli(
    [
      'make-spec',
      '--suite',
      'swe-bench-verified',
      '--dataset',
      join(dir, 'verified.jsonl'),
      '--ids-file',
      new URL(LIST).pathname,
      '--task-budget-usd',
      '5',
      '--total-budget-usd',
      '750',
      '--out',
      specPath,
    ],
    {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    },
  );
  assert.equal(code, 0, stderr);
  const spec = parseExperimentSpec(JSON.parse(await readFile(specPath, 'utf8')));
  assert.deepEqual(
    spec.tasks.map((task) => task.id),
    list.ids,
  );
});
