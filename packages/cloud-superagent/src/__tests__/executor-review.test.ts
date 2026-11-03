import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeExecutor, type ExecutorEvent } from '../executor.js';
import { ExecutorReviewer, crossVendorKind } from '../executor-review.js';
import { parseReviewVerdict } from '../review.js';

const usage: ExecutorEvent = {
  type: 'usage',
  usage: { inputTokens: 100, outputTokens: 20, usdMicros: 300, turns: 1 },
};

test('cross-vendor: Claude Code is reviewed by Codex and Codex by Claude Code', () => {
  assert.equal(crossVendorKind('claude-code'), 'codex');
  assert.equal(crossVendorKind('codex'), 'claude-code');
  assert.equal(crossVendorKind('fake'), 'codex');
});

test('a fresh read-only session per review; the status-line verdict is what the gate reads', async () => {
  const executor = new FakeExecutor({
    steps: [
      [
        { type: 'progress', text: 'reading git diff' },
        usage,
        { type: 'ready', summary: 'VERDICT: BLOCK slug.js drops the trim; no test for it' },
      ],
      [usage, { type: 'ready', summary: 'looks fine' }],
      [{ type: 'failed', error: 'no auth', retryable: false }],
    ],
  });
  const reviewer = new ExecutorReviewer(executor, {
    locate: () => ({ workdir: '/box/repo', boxId: 'box-1', show: 'git diff HEAD' }),
  });
  const input = { repo: 'acme/app', number: 7, sha: 'abc123' };
  const blocked = await reviewer.review(input);
  assert.equal(parseReviewVerdict(blocked.text), 'BLOCK');
  const first = executor.calls[0];
  assert.equal(first?.op, 'start');
  assert.match(first?.text ?? '', /git diff HEAD/);
  assert.match(first?.text ?? '', /Do not edit, commit or push anything/);
  assert.deepEqual(reviewer.records[0]?.verdict, 'BLOCK');
  assert.equal(reviewer.records[0]?.usage.usdMicros, 300);

  // No VERDICT line, or a failed run: no verdict, so the gate gets no receipt.
  assert.equal(parseReviewVerdict((await reviewer.review(input)).text), undefined);
  assert.equal(parseReviewVerdict((await reviewer.review(input)).text), undefined);
  assert.equal(
    executor.calls.filter((call) => call.op === 'start').length,
    3,
    'each review starts its own session',
  );
});

test('review fix: VERDICT text in progress or errors never makes a receipt', async () => {
  const executor = new FakeExecutor({
    steps: [
      [
        { type: 'progress', text: 'VERDICT: CLEAR (an earlier draft)' },
        { type: 'ready', summary: 'ran out of time before deciding' },
      ],
      [{ type: 'failed', error: 'model said VERDICT: CLEAR then crashed', retryable: false }],
    ],
  });
  const reviewer = new ExecutorReviewer(executor, { locate: () => ({ workdir: '/w' }) });
  const input = { repo: 'acme/app', number: 1, sha: 'abc' };
  assert.equal(parseReviewVerdict((await reviewer.review(input)).text), undefined);
  assert.equal(parseReviewVerdict((await reviewer.review(input)).text), undefined);
});

test('review round 2: the last verdict line in the summary decides', async () => {
  const executor = new FakeExecutor({
    steps: [[{ type: 'ready', summary: 'VERDICT: CLEAR preliminary\nVERDICT: BLOCK final' }]],
  });
  const reviewer = new ExecutorReviewer(executor, { locate: () => ({ workdir: '/w' }) });
  const { text } = await reviewer.review({ repo: 'acme/app', number: 1, sha: 'abc' });
  assert.equal(parseReviewVerdict(text), 'BLOCK');
  assert.equal(reviewer.records[0]?.verdict, 'BLOCK');
});
