import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CI_DEFAULT,
  DAY,
  ISSUES,
  issueOpened,
  request,
  rig,
  spec,
  workflowRun,
} from './harness.js';

test('the same delivery id twice starts one run, and the second answer says duplicate', async () => {
  const r = await rig();
  const [duty] = await r.activate(ISSUES);
  const first = r.deliver('issues', issueOpened({ number: 1 }), { id: 'same-id' });
  const second = r.deliver('issues', issueOpened({ number: 1 }), { id: 'same-id' });
  assert.equal(first.body.started, 1);
  assert.equal(second.body.duplicate, true);
  assert.equal(r.engine.requestsOf(duty as string).length, 1);
  r.cleanup();
});

test('the same event under a new delivery id still starts one run (a second webhook, a manual redelivery)', async () => {
  const r = await rig();
  const [duty] = await r.activate(ISSUES, CI_DEFAULT);
  r.deliver('issues', issueOpened({ number: 1 }), { id: 'a' });
  r.deliver('issues', issueOpened({ number: 1 }), { id: 'b' });
  r.deliver('workflow_run', workflowRun({ id: 50, attempt: 1 }), { id: 'c' });
  r.deliver('workflow_run', workflowRun({ id: 50, attempt: 1 }), { id: 'd' });
  assert.equal(r.engine.requestsOf(duty as string).length, 1);
  // A re-run of the same workflow run is a new attempt, so a new event.
  assert.equal(
    r.deliver('workflow_run', workflowRun({ id: 50, attempt: 2 }), { id: 'e' }).body.started,
    1,
  );
  r.cleanup();
});

test('deliveries submitted together start each event once', async () => {
  const r = await rig();
  const [duty] = await r.activate(ISSUES);
  const sends = Array.from({ length: 8 }, (_, index) => {
    const { headers, body } = request('issues', issueOpened({ number: 1 + (index % 2) }), {
      id: `d${index % 4}`,
    });
    return Promise.resolve().then(() => r.engine.receive(headers, body));
  });
  await Promise.all(sends);
  assert.equal(
    r.engine.requestsOf(duty as string).length,
    2,
    'two issues, however many deliveries',
  );
  r.cleanup();
});

test('a retained event key blocks a replay after the delivery record is pruned', async () => {
  const r = await rig();
  const [duty] = await r.activate(ISSUES);
  r.deliver('issues', issueOpened({ number: 1 }), { id: 'old' });
  r.clock.advance(31 * DAY);
  r.engine.tick();
  const replay = r.deliver('issues', issueOpened({ number: 1 }), { id: 'old' });
  assert.equal(replay.body.started, 0, 'the delivery id was pruned, the event key was not');
  assert.equal(r.engine.requestsOf(duty as string).length, 1);
  r.cleanup();
});

test('a CI failure that arrives after a later success of the same workflow is stale', async () => {
  const r = await rig();
  const [duty] = await r.activate(CI_DEFAULT);
  // Success (run 12) first, then the failure of run 11: stale.
  r.deliver('workflow_run', workflowRun({ id: 2, number: 12, conclusion: 'success' }));
  const late = r.deliver('workflow_run', workflowRun({ id: 1, number: 11, conclusion: 'failure' }));
  assert.equal(late.body.ignored, 'stale');
  assert.equal(r.engine.requestsOf(duty as string).length, 0);

  // A newer failure (run 13) is not stale.
  assert.equal(
    r.deliver('workflow_run', workflowRun({ id: 3, number: 13, conclusion: 'failure' })).body
      .started,
    1,
  );
  // A different workflow or branch has its own history.
  assert.equal(
    r.deliver('workflow_run', workflowRun({ id: 4, number: 5, workflowId: 99 })).body.started,
    1,
  );
  r.cleanup();
});

test("a success that arrives after a failure cancels the failure's run if it has not started, and releases its reservation", async () => {
  const r = await rig();
  const [duty] = await r.activate(CI_DEFAULT);
  r.deliver('workflow_run', workflowRun({ id: 1, number: 11, conclusion: 'failure' }));
  assert.equal(r.engine.dayUsage(duty as string).reservedUsd, 2);
  const result = r.deliver(
    'workflow_run',
    workflowRun({ id: 2, number: 12, conclusion: 'success' }),
  );
  assert.equal(result.body.cancelled, 1);
  const [request0] = r.engine.requestsOf(duty as string);
  assert.equal(request0?.state, 'cancelled');
  assert.equal(request0?.reason, 'superseded');
  assert.deepEqual(r.engine.dayUsage(duty as string), { reservedUsd: 0, spentUsd: 0 });

  // A failure whose run already started is not touched by a later success.
  r.deliver('workflow_run', workflowRun({ id: 3, number: 13, conclusion: 'failure' }));
  const id = r.engine.due()[0] as string;
  assert.ok(r.engine.beginLaunch(id));
  r.engine.launched(id, 'cnv_1');
  r.deliver('workflow_run', workflowRun({ id: 4, number: 14, conclusion: 'success' }));
  assert.equal(r.engine.request(id)?.state, 'started');
  r.cleanup();
});

test('the daily cap stops runs once the day is full, and the next UTC day starts fresh', async () => {
  const r = await rig();
  const [duty] = await r.activate(
    spec({ trigger: { kind: 'issue_opened' }, runBudgetUsd: 2, dailyCapUsd: 5 }),
  );
  assert.equal(r.deliver('issues', issueOpened({ number: 1 })).body.started, 1);
  assert.equal(r.deliver('issues', issueOpened({ number: 2 })).body.started, 1);
  const third = r.deliver('issues', issueOpened({ number: 3 }));
  assert.equal(third.body.started, 0);
  assert.equal(third.body.capped, 1);
  const states = r.engine
    .requestsOf(duty as string)
    .map((request) => `${request.state}:${request.reason ?? ''}`);
  assert.deepEqual(states.sort(), ['pending:', 'pending:', 'skipped:daily_cap']);
  // The refused event is not retried by a redelivery.
  assert.equal(r.deliver('issues', issueOpened({ number: 3 })).body.started, 0);

  r.clock.advance(DAY);
  assert.equal(r.deliver('issues', issueOpened({ number: 4 })).body.started, 1);
  r.cleanup();
});

test('many events in one burst cannot reserve more than the daily cap', async () => {
  const r = await rig();
  const [duty] = await r.activate(
    spec({ trigger: { kind: 'issue_opened' }, runBudgetUsd: 1, dailyCapUsd: 4 }),
  );
  for (let n = 1; n <= 20; n += 1) r.deliver('issues', issueOpened({ number: n }));
  assert.equal(r.engine.dayUsage(duty as string).reservedUsd, 4);
  assert.equal(
    r.engine.requestsOf(duty as string).filter((request) => request.state === 'pending').length,
    4,
  );
  r.cleanup();
});
