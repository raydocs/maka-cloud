import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CONSECUTIVE_FAILURES } from '../types.js';
import { issueOpened, MINUTE, rig, spec } from './harness.js';

/** One issue-triggered duty ($2 a run, $6 a day) with the first run started; returns what the tests need. */
async function started(over: Parameters<typeof spec>[0] = { trigger: { kind: 'issue_opened' } }) {
  const r = await rig({ file: true });
  const [duty] = (await r.activate(spec({ runBudgetUsd: 2, dailyCapUsd: 6, ...over }))) as [string];
  if (over.trigger.kind === 'issue_opened') r.deliver('issues', issueOpened({ number: 1 }));
  else r.clock.advance(120 * MINUTE);
  r.engine.tick();
  const first = r.engine.requestsOf(duty)[0]?.requestId as string;
  assert.ok(r.engine.beginLaunch(first));
  assert.ok(r.engine.launched(first, 'cnv_first'));
  const retries = () => r.engine.requestsOf(duty).filter((q) => q.requestId !== first);
  return { r, duty, first, retries };
}

function failuresOf(r: Awaited<ReturnType<typeof rig>>, duty: string): number {
  const found = r.engine.project('inv_owner', r.projectId)?.duties.find((d) => d.dutyId === duty);
  return found?.consecutiveFailures ?? -1;
}

test('a transient failure queues one retry two minutes later and does not count against the duty', async () => {
  const { r, duty, first, retries } = await started();
  assert.equal(r.engine.finish(first, 'transient', 0.2), true);
  assert.equal(r.engine.request(first)?.reason, 'transient');
  const [retry] = retries();
  assert.ok(retry, 'a retry request exists');
  assert.equal(retry.state, 'pending');
  assert.equal(r.engine.due().length, 0, 'not due yet');
  r.clock.advance(2 * MINUTE);
  assert.deepEqual(r.engine.due(), [retry.requestId]);
  assert.equal(failuresOf(r, duty), 0);
  // The retry carries the first request's brief and limits, and reserves its own money.
  assert.equal(r.engine.request(retry.requestId)?.brief, r.engine.request(first)?.brief);
  assert.deepEqual(r.engine.dayUsage(duty), { reservedUsd: 2, spentUsd: 0.2 });
  r.cleanup();
});

test('the retry failing, transiently or not, counts once and is never retried again', async () => {
  const { r, duty, first, retries } = await started();
  r.engine.finish(first, 'transient', 0.2);
  r.clock.advance(2 * MINUTE);
  const [retry] = retries();
  assert.ok(retry);
  assert.ok(r.engine.beginLaunch(retry.requestId));
  assert.ok(r.engine.launched(retry.requestId, 'cnv_retry'));
  r.engine.finish(retry.requestId, 'transient', 0.1);
  assert.equal(retries().length, 1, 'no second retry');
  assert.equal(r.engine.request(retry.requestId)?.reason, 'failed');
  assert.equal(failuresOf(r, duty), 1, 'the chain counts once');
  r.cleanup();
});

test('a retry that succeeds clears the count as any completed run does', async () => {
  const { r, duty, first, retries } = await started();
  r.engine.finish(first, 'transient', 0.2);
  r.clock.advance(2 * MINUTE);
  const [retry] = retries();
  assert.ok(retry && r.engine.beginLaunch(retry.requestId));
  r.engine.launched(retry.requestId, 'cnv_retry');
  r.engine.finish(retry.requestId, 'completed', 0.5);
  assert.equal(failuresOf(r, duty), 0);
  assert.equal(r.engine.request(retry.requestId)?.reason, 'completed');
  r.cleanup();
});

test('a schedule that fires again within 30 minutes is not retried; the failure counts', async () => {
  // Hourly duty: right after a slot the next one is 60 minutes away, 29 minutes before it it is 29.
  const { r, duty, first, retries } = await started({
    trigger: { kind: 'schedule', everyMinutes: 60 },
  });
  r.clock.advance(31 * MINUTE);
  r.engine.finish(first, 'transient', 0.2);
  assert.equal(retries().length, 0);
  assert.equal(r.engine.request(first)?.reason, 'failed');
  assert.equal(failuresOf(r, duty), 1);
  r.cleanup();
});

test('a schedule with more than 30 minutes to its next run is retried', async () => {
  const { r, first, retries } = await started({ trigger: { kind: 'schedule', everyMinutes: 60 } });
  r.clock.advance(29 * MINUTE);
  r.engine.finish(first, 'transient', 0.2);
  assert.equal(retries().length, 1);
  r.cleanup();
});

test('the daily cap decides: a retry that does not fit is not queued and the failure counts', async () => {
  const { r, duty, first, retries } = await started({
    trigger: { kind: 'issue_opened' },
    runBudgetUsd: 2,
    dailyCapUsd: 2,
  });
  r.engine.finish(first, 'transient', 2);
  assert.equal(retries().filter((q) => q.state === 'pending').length, 0);
  assert.equal(failuresOf(r, duty), 1);
  assert.deepEqual(r.engine.dayUsage(duty), { reservedUsd: 0, spentUsd: 2 });
  r.cleanup();
});

test('a duty that was switched off meanwhile is not retried', async () => {
  const { r, duty, first, retries } = await started();
  assert.equal(r.engine.setDutyState('inv_owner', duty, 'off'), 'ok');
  r.engine.finish(first, 'transient', 0.2);
  assert.equal(retries().length, 0);
  r.cleanup();
});

test('only a retry that was counted can turn a duty off: a transient failure alone never does', async () => {
  const r = await rig({ file: true });
  const [duty] = (await r.activate(
    spec({ trigger: { kind: 'issue_opened' }, dailyCapUsd: 100 }),
  )) as [string];
  for (let n = 1; n <= MAX_CONSECUTIVE_FAILURES; n += 1) {
    r.deliver('issues', issueOpened({ number: n }));
    const id = r.engine.requestsOf(duty).find((q) => q.state === 'pending' && q.reason === null)
      ?.requestId as string;
    assert.ok(r.engine.beginLaunch(id));
    r.engine.launched(id, `cnv_${n}`);
    r.engine.finish(id, 'transient', 0);
  }
  assert.equal(failuresOf(r, duty), 0, 'ten transient failures, ten retries waiting, none counted');
  r.cleanup();
});
