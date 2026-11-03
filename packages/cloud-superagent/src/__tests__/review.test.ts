import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeBoundText } from '../loop.js';
import {
  FakeReviewer,
  hasClearReceipt,
  parseReviewVerdict,
  prRef,
  receiptFromReview,
} from '../review.js';
import { actMandate } from '../types.js';
import { github, prPayload, REPO, rig, TENANT } from './harness.js';

test('parseReviewVerdict takes the last VERDICT line; missing means no receipt', () => {
  assert.equal(parseReviewVerdict('looks fine'), undefined);
  assert.equal(parseReviewVerdict('VERDICT: MAYBE'), undefined);
  assert.equal(parseReviewVerdict('VERDICT: BLOCK\nVERDICT: CLEAR'), 'CLEAR');
  const receipt = receiptFromReview('nits\nVERDICT: BLOCK', {
    repo: REPO,
    number: 12,
    sha: 'abc1234',
    at: 1,
  });
  assert.equal(receipt?.verdict, 'BLOCK');
  assert.equal(hasClearReceipt(receipt ? [receipt] : [], prRef(REPO, 12), 'abc1234'), false);
});

test('merge stays review_required until a CLEAR receipt is pinned to the head sha', async () => {
  const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const MERGE = mergeBoundText(REPO, 12, sha);
  const reviewer = new FakeReviewer();
  reviewer.verdict = 'none';
  const { agent, handler, judge } = rig({ reviewer });
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'PR' };
    },
  };
  handler.script = () => ({ action: { kind: 'merge', boundText: MERGE } });
  const opened = await agent.ingest(github(TENANT, 'rv-none', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.notEqual(agent.worker(TENANT, opened.workerId)?.state, 'awaiting_approval');
  assert.equal(agent.store.pendingApprovals(TENANT, opened.workerId).length, 0);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'review_no_verdict'),
    true,
  );
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.detail.reason === 'review_required'),
    true,
  );

  reviewer.verdict = 'CLEAR';
  const reviewed = await agent.review(TENANT, opened.workerId, { repo: REPO, number: 12, sha });
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  assert.equal(reviewed.receipt.verdict, 'CLEAR');
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  const held = agent.safety.gate(worker, { kind: 'merge', boundText: MERGE }, Date.now());
  assert.equal(held.allowed, false);
  if (held.allowed || held.reason !== 'held') return;
  assert.equal(
    agent.store
      .audit(TENANT)
      .some((row) => row.kind === 'review_receipt' && row.detail.verdict === 'CLEAR'),
    true,
  );
});

test('a BLOCK receipt is recorded and is not a merge precondition', async () => {
  const sha = 'cccccccccccccccccccccccccccccccccccccccc';
  const MERGE = mergeBoundText(REPO, 9, sha);
  const reviewer = new FakeReviewer();
  reviewer.verdict = 'BLOCK';
  const { agent, handler, judge } = rig({ reviewer });
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'PR' };
    },
  };
  handler.script = () => ({ action: { kind: 'merge', boundText: MERGE } });
  const opened = await agent.ingest(
    github(TENANT, 'rv-block', 'pull_request', prPayload('opened', 9)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.reviewReceipts?.[0]?.verdict, 'BLOCK');
  const gate = agent.safety.gate(worker!, { kind: 'merge', boundText: MERGE }, Date.now());
  assert.equal(gate.allowed, false);
  if (!gate.allowed) assert.equal(gate.reason, 'review_required');
});
