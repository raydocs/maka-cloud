import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CONSECUTIVE_FAILURES } from '../types.js';
import { HOUR, issueOpened, MINUTE, rig, spec } from './harness.js';

/**
 * An issue duty ($2 a run, $6 a day) that has failed 9 times in a row, whose 10th run (opened at
 * 23:58 UTC) fails on a transient model error and leaves a retry waiting. `n` numbers the issues.
 */
async function tenthFailsTransiently(extra: Parameters<typeof rig>[0] = {}) {
  const policy = { named: true };
  const r = await rig({ file: true, allowProject: () => policy.named, ...extra });
  const [duty] = (await r.activate(
    spec({ trigger: { kind: 'issue_opened' }, runBudgetUsd: 2, dailyCapUsd: 6 }),
  )) as [string];
  let n = 0;
  const open = () => {
    n += 1;
    r.deliver('issues', issueOpened({ number: n }));
    return r.engine.requestsOf(duty).find((q) => q.state === 'pending')?.requestId as string;
  };
  const run = (outcome: 'failed' | 'transient') => {
    const id = open();
    assert.ok(r.engine.beginLaunch(id));
    assert.ok(r.engine.launched(id, `cnv_${n}`));
    r.engine.finish(id, outcome, 0.1);
    return id;
  };
  const state = () =>
    r.engine.project('inv_owner', r.projectId)?.duties.find((d) => d.dutyId === duty);
  for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i += 1) run('failed');
  assert.equal(state()?.consecutiveFailures, MAX_CONSECUTIVE_FAILURES - 1);
  r.clock.advance(11 * HOUR + 58 * MINUTE); // 23:58 UTC
  const tenth = run('transient');
  const retry = r.engine
    .requestsOf(duty)
    .find((q) => q.requestId !== tenth && q.state === 'pending');
  assert.ok(retry, 'the retry is waiting');
  assert.equal(
    state()?.consecutiveFailures,
    MAX_CONSECUTIVE_FAILURES - 1,
    'held back for the retry',
  );
  return { r, policy, duty, open, state, retry: retry.requestId };
}

test("a retry the day's cap turns away after midnight settles the failure it was retrying", async () => {
  const { r, open, state, retry } = await tenthFailsTransiently();
  r.clock.advance(5 * MINUTE); // past UTC midnight
  open();
  open();
  open(); // today holds $6 of $6, so the retry no longer fits
  assert.equal(r.engine.beginLaunch(retry), undefined);
  assert.equal(r.engine.request(retry)?.reason, 'daily_cap');
  assert.equal(state()?.consecutiveFailures, MAX_CONSECUTIVE_FAILURES, 'the 10th failure counts');
  assert.equal(state()?.state, 'off');
  assert.equal(state()?.offReason, 'failures');
  r.cleanup();
});

test('a retry the launcher is refused for settles the failure it was retrying', async () => {
  const { r, state, retry } = await tenthFailsTransiently();
  r.clock.advance(2 * MINUTE);
  assert.ok(r.engine.beginLaunch(retry));
  assert.equal(r.engine.launchFailed(retry, { permanent: true, retryAfterMs: 0 }), 'cancelled');
  assert.equal(state()?.consecutiveFailures, MAX_CONSECUTIVE_FAILURES);
  assert.equal(state()?.state, 'off');
  r.cleanup();
});

test('a retry the operator stops naming the project for settles the failure it was retrying', async () => {
  const { r, policy, state, retry } = await tenthFailsTransiently();
  r.clock.advance(2 * MINUTE);
  policy.named = false;
  assert.equal(r.engine.beginLaunch(retry), undefined);
  assert.equal(r.engine.request(retry)?.reason, 'project_not_allowed');
  assert.equal(state()?.consecutiveFailures, MAX_CONSECUTIVE_FAILURES);
  r.cleanup();
});

test('a retry parked at start settles the failure it was retrying', async () => {
  const { r, policy, duty, retry } = await tenthFailsTransiently();
  policy.named = false;
  r.reopen();
  assert.equal(r.engine.request(retry)?.reason, 'project_not_allowed');
  const found = r.engine.project('inv_owner', r.projectId)?.duties.find((d) => d.dutyId === duty);
  assert.equal(found?.consecutiveFailures, MAX_CONSECUTIVE_FAILURES);
  r.cleanup();
});

test('a retry the person stops before it starts adds no failure of its own', async () => {
  const { r, state, retry } = await tenthFailsTransiently();
  assert.equal(r.engine.finish(retry, 'stopped'), true); // stopped before it started
  assert.equal(state()?.consecutiveFailures, MAX_CONSECUTIVE_FAILURES - 1);
  r.cleanup();
});
