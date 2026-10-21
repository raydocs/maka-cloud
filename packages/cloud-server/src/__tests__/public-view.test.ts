import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskEvent, TaskView } from '@maka-cloud/orchestrator';
import { scrubErrorText, toPublicEvent, toPublicItem, toPublicView } from '../public-view.js';

test("an approval item's ask reaches the client exactly as the approval binds it; other asks are scrubbed (T15)", () => {
  const card =
    'Allow open_pull_request(taskId: "tsk_1", title: "Fix ｃodex login")? It cannot be undone.\n\nRepository: acme/codex-secrets';
  assert.deepEqual(toPublicItem({ kind: 'approval', ask: card }), { kind: 'approval', ask: card });
  assert.deepEqual(toPublicItem({ kind: 'blocked', ask: 'Codex failed on ｃlaude.' }), {
    kind: 'blocked',
    ask: 'assistant failed on assistant.',
  });
});

const LEAKS = [
  'Bearer sk-live-0123456789abcdef.payload',
  'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
  'ghp_0123456789abcdef0123456789abcdef0123',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
  'AIzaSyA-0123456789abcdefghijklmnop',
  'ibx-0123456789abcdef',
  'mki_0123456789abcdef',
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
];

test('error text shown to clients loses bearer tokens, keys and the headers that carry them', () => {
  for (const leak of LEAKS) {
    const out = scrubErrorText(`request failed: ${leak} (HTTP 401)`);
    assert.ok(!out.includes(leak.slice(8, 30)), `${leak} -> ${out}`);
    assert.match(out, /\[secret\]/u);
    assert.match(out, /^request failed: /u);
  }
  assert.equal(
    scrubErrorText('401 {"headers":{"Authorization":"Bearer abc.def","x-api-key":"zzz-123"}}'),
    '401 {"headers":{"Authorization":"[secret]","x-api-key":"[secret]"}}',
  );
  // A hidden character cannot split a token past the patterns.
  assert.ok(!scrubErrorText('Bear\u200ber ghp_0123456789abcdef0123456789').includes('ghp_0123'));
});

test('ordinary text and page titles pass through', () => {
  for (const text of [
    'Token budget exceeded for the task',
    'Why the password reset email is slow',
    'Merge conflict in src/api-key.ts at 3f2a9c1',
  ]) {
    assert.equal(scrubErrorText(text), text);
  }
});

test('a task view, its failure events and an inbox ask carry no secret', () => {
  const secret = 'Bearer sk-live-0123456789abcdef';
  const view = { taskId: 'tsk_1', runner: 'claude', failureReason: `upstream said ${secret}` };
  assert.equal(
    (toPublicView(view as unknown as TaskView) as { failureReason: string }).failureReason,
    'upstream said [secret]',
  );
  for (const type of ['task_failed', 'task_pause_failed', 'task_resume_failed'] as const) {
    const event = { type, taskId: 'tsk_1', reason: `boom ${secret}` } as TaskEvent;
    assert.equal((toPublicEvent(event) as { reason: string }).reason, 'boom [secret]');
  }
  assert.deepEqual(toPublicItem({ kind: 'blocked', ask: `Failed: ${secret}` }), {
    kind: 'blocked',
    ask: 'Failed: [secret]',
  });
});
