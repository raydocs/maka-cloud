import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readEvent, type AgentEvent, type TurnResult } from '../src/boat.ts';
import { LoopGuard } from '../src/guards.ts';
import { repoSlug } from '../src/pipeline.ts';
import {
  describeTool,
  extractJson,
  integrityFlags,
  namesAModel,
  scrubModelNames,
} from '../src/text.ts';

test('model and vendor names never reach the owner', () => {
  const text =
    'I asked Claude Code and Codex to check it; GPT-6.1-sol and Opus 5.5 agreed. Grok Build too.\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
  const out = scrubModelNames(text);
  assert.equal(namesAModel(out), false, out);
  assert.ok(!/Co-Authored-By/u.test(out));
  assert.equal(scrubModelNames('修好了登录页'), '修好了登录页');
});

test('the work order is read from the last json block, or the last object', () => {
  assert.deepEqual(extractJson('plan:\n```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```'), {
    a: 2,
  });
  assert.deepEqual(extractJson('Done. {"summary":"x","changes":["a {b}"]}'), {
    summary: 'x',
    changes: ['a {b}'],
  });
  assert.equal(extractJson('no json here'), undefined);
});

test('the status line says what a tool call is doing', () => {
  assert.equal(describeTool('Bash', { command: 'npm test' }), '正在跑测试：npm test');
  assert.equal(
    describeTool('Edit', { file_path: '/home/user/work/src/login.ts' }),
    '正在修改 src/login.ts',
  );
  assert.equal(describeTool('Read', { file_path: 'README.md' }), '正在阅读 README.md');
});

test('the integrity scan flags weakened tests, not new ones', () => {
  const names =
    'M\tsrc/login.ts\nM\tsrc/login.test.ts\nA\tsrc/remember.test.ts\nD\ttests/old_test.py\nM\t.github/workflows/ci.yml';
  const patch = [
    '--- a/src/login.test.ts',
    '+++ b/src/login.test.ts',
    '@@ -3 +3 @@',
    '-  expect(x).toBe(1)',
    '+  expect(x).toBeTruthy()',
    '--- /dev/null',
    '+++ b/src/remember.test.ts',
    '@@ -0,0 +1 @@',
    '+it.skip("later", () => {})',
  ].join('\n');
  const flags = integrityFlags(names, patch).map((f) => `${f.file}: ${f.why}`);
  assert.deepEqual(flags.sort(), [
    '.github/workflows/ci.yml: 改动了测试配置或 CI',
    'src/login.test.ts: 删改了已有测试的 1 行',
    'src/remember.test.ts: 加了跳过或只跑某个测试的标记：it.skip("later", () => {})',
    'tests/old_test.py: 删除了已有的测试',
  ]);
  // Only adding tests to an existing file is fine.
  const added = [
    '--- a/src/a.test.ts',
    '+++ b/src/a.test.ts',
    '@@ -9,0 +10 @@',
    '+it("new", () => {})',
  ].join('\n');
  assert.deepEqual(integrityFlags('M\tsrc/a.test.ts', added), []);
});

test('the loop guard stops the sixth identical call', () => {
  const guard = new LoopGuard();
  for (let i = 0; i < 5; i++) assert.equal(guard.check('Bash', { command: 'ls', cwd: '.' }), null);
  assert.ok(guard.check('Bash', { cwd: '.', command: 'ls' }));
  assert.equal(guard.check('Bash', { command: 'ls -la' }), null);
});

test('boat events become text, tools and the turn status', () => {
  const result: TurnResult = { conversationId: '', text: '', status: 'unknown' };
  const seen: AgentEvent[] = [];
  const on = (e: AgentEvent) => seen.push(e);
  readEvent({ promptId: 'p1', conversationId: 'c1', status: 'queued' }, result, on);
  readEvent(
    {
      type: 'response',
      conversationId: 'c1',
      data: {
        content: 'partial',
        is_streaming: true,
        tools: [{ name: 'Bash', input: { command: 'npm test' } }],
      },
    },
    result,
    on,
  );
  readEvent({ type: 'response', conversationId: 'c1', data: { content: 'all done' } }, result, on);
  readEvent({ type: 'prompt', conversationId: 'c1', data: { status: 'finished' } }, result, on);
  assert.equal(result.conversationId, 'c1');
  assert.equal(result.text, 'all done');
  assert.equal(result.status, 'finished');
  assert.deepEqual(
    seen.map((e) => e.kind),
    ['tool', 'text', 'status'],
  );
  assert.equal(seen[0]?.conversationId, 'c1');
});

test('a repository is named however the owner types it', () => {
  assert.equal(repoSlug('raydocs/maka-cloud'), 'raydocs/maka-cloud');
  assert.equal(repoSlug('https://github.com/raydocs/maka-cloud.git'), 'raydocs/maka-cloud');
  assert.equal(repoSlug('git@github.com:raydocs/maka-cloud.git'), 'raydocs/maka-cloud');
});
