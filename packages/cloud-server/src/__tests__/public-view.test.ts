import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskEvent, TaskView } from '@maka-cloud/orchestrator';
import {
  scrubErrorText,
  toPublicConductorData,
  toPublicEvent,
  toPublicItem,
  toPublicView,
  WITHHELD_APPROVAL,
} from '../public-view.js';

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

test("progress notes, step lines and a view's progress carry no secret", () => {
  const note =
    'snapshot skipped: Bearer sk-live-0123456789abcdef at https://x.test/?access_token=abc123DEF456';
  const clean = (text: string) => {
    assert.ok(!text.includes('sk-live-0123'), text);
    assert.ok(!text.includes('abc123DEF456'), text);
    assert.match(text, /\[secret\]/u);
  };
  clean(
    (
      toPublicEvent({ type: 'task_progress', taskId: 'tsk_1', note } as TaskEvent) as {
        note: string;
      }
    ).note,
  );
  const intent = toPublicEvent({
    type: 'step_intent',
    taskId: 'tsk_1',
    epoch: 1,
    stepId: 's1',
    kind: 'tool',
    replay: 'never',
    label: note,
  } as TaskEvent) as { label: string };
  clean(intent.label);
  const outcome = toPublicEvent({
    type: 'step_outcome',
    taskId: 'tsk_1',
    epoch: 1,
    stepId: 's1',
    status: 'done',
    output: note,
  } as TaskEvent) as { output: string };
  clean(outcome.output);
  const view = toPublicView({
    taskId: 'tsk_1',
    runner: 'claude',
    progress: ['working', note],
  } as unknown as TaskView);
  assert.equal(view.progress[0], 'working');
  clean(view.progress[1] ?? '');
});

test('conductor notices and the note of a question carry no secret; the held call of an approval stays as it is', () => {
  const text = 'the push failed: {"Authorization":["Bearer","tok-0123456789-abcdef"]}';
  const notice = toPublicConductorData('conductor.notice', { noticeId: 'n1', text }) as {
    text: string;
  };
  assert.ok(!notice.text.includes('tok-0123456789'), notice.text);
  const action = { tool: 'open_pull_request', args: { title: 'Fix ｃodex login' } };
  const asked = toPublicConductorData('conductor.question', {
    questionId: 'q1',
    question: 'Open the PR?',
    note: `it said access_token=abc ?access_token=abc123DEF456`,
    options: [{ id: 'yes', label: 'Yes' }],
    action,
  }) as { note: string; action: unknown };
  assert.ok(!asked.note.includes('abc123DEF456'), asked.note);
  assert.deepEqual(asked.action, action);
  const answered = { questionId: 'q1', optionId: 'yes', text: 'my own words' };
  assert.deepEqual(toPublicConductorData('conductor.answered', answered), answered);
});

const KEY = 'ghp_0123456789abcdef0123456789abcdef0123';

test('a success manifest, in the task view and in task_succeeded, carries no key', () => {
  const manifest = {
    summary: `deployed with token=${KEY}`,
    done: [`set GITHUB_TOKEN=${KEY}`, 'ran the tests'],
    notDone: [`Authorization: Bearer ${KEY}`],
    confidence: 'high' as const,
    knownIssues: [`{"api_key":"${KEY}"}`],
    artifacts: [`out/${KEY}.log`],
  };
  const clean = (value: unknown) => assert.ok(!JSON.stringify(value).includes(KEY.slice(4, 30)));
  const view = toPublicView({
    taskId: 'tsk_1',
    state: 'succeeded',
    manifest,
  } as unknown as TaskView);
  clean(view.manifest);
  const event = toPublicEvent({ type: 'task_succeeded', taskId: 'tsk_1', manifest } as TaskEvent);
  clean(event);
  assert.equal((event as { manifest: { confidence: string } }).manifest.confidence, 'high');
  assert.equal((event as { manifest: { done: string[] } }).manifest.done[1], 'ran the tests');
});

test('an approval that carries a key is withheld whole, with no way to approve; a clean one is untouched (T15)', () => {
  const clean = {
    kind: 'approval',
    ask: 'Allow publish_page(title: "Hello")? It cannot be undone.',
    options: [
      { id: 'approve', label: 'Go ahead' },
      { id: 'reject', label: "Don't do it" },
    ],
    evidence: [{ kind: 'action', tool: 'publish_page', args: '{"title":"Hello"}' }],
  };
  assert.deepEqual(toPublicItem(clean), clean);
  for (const carrier of [
    { ...clean, ask: `Allow publish_page(title: "${KEY}")? It cannot be undone.` },
    { ...clean, evidence: [{ kind: 'action', tool: 'publish_page', args: `{"token":"${KEY}"}` }] },
  ]) {
    const shown = toPublicItem(carrier) as typeof clean;
    assert.equal(shown.ask, WITHHELD_APPROVAL);
    assert.deepEqual(shown.evidence, []);
    assert.deepEqual(
      shown.options.map((option) => option.id),
      ['reject'],
    );
    assert.ok(!JSON.stringify(shown).includes(KEY.slice(4, 30)));
  }
});

test("a proposed card's facts are scrubbed like its ask, and nothing else about it changes", () => {
  const item = {
    kind: 'suggestion',
    ask: 'Rebase PR #12, it conflicts with main',
    suggestion: {
      kind: 'rebase_pr',
      mode: 'quick',
      estimateUsd: 1,
      typical: false,
      repo: 'acme/widgets',
      detail:
        'PR #12 "Fix the Codex login with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA" cannot be merged.',
      external: true,
    },
  };
  const shown = toPublicItem(item) as typeof item;
  assert.equal(shown.ask, item.ask);
  assert.ok(!shown.suggestion.detail.includes('sk-ant'));
  assert.ok(!/codex/iu.test(shown.suggestion.detail));
  assert.deepEqual({ ...shown.suggestion, detail: '' }, { ...item.suggestion, detail: '' });
  assert.deepEqual(toPublicItem({ kind: 'suggestion', ask: 'x' }), {
    kind: 'suggestion',
    ask: 'x',
  });
});

// -- recheck15 items 1 to 3 ---------------------------------------------------------------------

test('a stored approval question that holds a key in its call is withheld, with no way to approve, and the call is not sent', () => {
  const token = 'ghp_0123456789abcdef0123456789abcdef0123';
  const shown = toPublicConductorData('conductor.question', {
    questionId: 'q1',
    question: `Allow open_pull_request(token: "${token}")? It cannot be undone.`,
    note: 'Open it?',
    options: [
      { id: 'approve', label: 'Go ahead' },
      { id: 'reject', label: "Don't do it" },
    ],
    action: { tool: 'open_pull_request', args: { token } },
  }) as { question: string; note: unknown; action: unknown; options: { id: string }[] };
  assert.equal(shown.question, WITHHELD_APPROVAL);
  assert.equal(shown.action, undefined);
  assert.deepEqual(
    shown.options.map((o) => o.id),
    ['reject'],
  );
  assert.ok(!JSON.stringify(shown).includes(token));
  // The key only in the call's arguments, not in the words of the card.
  const argsOnly = toPublicConductorData('conductor.question', {
    questionId: 'q2',
    question: 'Allow publish()? It cannot be undone.',
    options: [{ id: 'approve', label: 'Go ahead' }],
    action: { tool: 'publish', args: { headers: { Authorization: `token ${token}` } } },
  }) as { options: { id: string }[]; action: unknown };
  assert.deepEqual(argsOnly.options, []);
  assert.equal(argsOnly.action, undefined);
});

test('an approval that carries a key through percent escapes, \\u escapes or a second layer of JSON is withheld', () => {
  const token = 'ghp_0123456789abcdef0123456789abcdef0123';
  const forms = [
    token.replace('_', '%5F'),
    token.replace('_', '\\u005f'),
    encodeURIComponent(token),
    JSON.stringify(JSON.stringify({ k: token })).slice(1, -1),
    `${token.slice(0, 3)}​${token.slice(3)}`,
  ];
  for (const form of forms) {
    const out = toPublicItem({
      kind: 'approval',
      ask: 'Allow x()?',
      evidence: [`seen ${form}`],
      options: [{ id: 'approve' }, { id: 'reject' }],
    }) as { ask: string; options: { id: string }[] };
    assert.equal(out.ask, WITHHELD_APPROVAL, form);
    assert.deepEqual(
      out.options.map((o) => o.id),
      ['reject'],
      form,
    );
  }
  // A harmless escaped run is left alone.
  const fine = { kind: 'approval', ask: 'Allow x(path: "a%20b")?', options: [{ id: 'approve' }] };
  assert.deepEqual(toPublicItem(fine), fine);
});
