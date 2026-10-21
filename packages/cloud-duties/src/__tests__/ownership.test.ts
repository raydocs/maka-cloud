import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dispatcher } from '../dispatcher.js';
import { HOUR, issueOpened, rig, spec } from './harness.js';

const ISSUE = spec({ trigger: { kind: 'issue_opened' }, runBudgetUsd: 1, dailyCapUsd: 10 });

/** A project the operator's policy names, and a way to take that away or give it back. */
async function setup(extra: Parameters<typeof rig>[0] = {}) {
  const policy = { named: true };
  const r = await rig({ file: true, allowProject: () => policy.named, ...extra });
  return { r, policy };
}

test('a project the operator no longer names for its owner gets no runs from its events', async () => {
  const { r, policy } = await setup();
  const [duty] = (await r.activate(ISSUE)) as [string];
  assert.equal(r.deliver('issues', issueOpened({ number: 1 })).body.started, 1);

  // The operator ties the repository to another invite: the stored project keeps its rows.
  policy.named = false;
  const refused = r.deliver('issues', issueOpened({ number: 2 }), { id: 'after-the-change' });
  assert.equal(refused.body.ignored, 'project_not_allowed');
  assert.equal(refused.body.started, undefined);
  assert.equal(r.engine.requestsOf(duty).length, 1, 'no run for the old owner');

  // Named again: the same delivery, redelivered, is still new (the refusal recorded nothing).
  policy.named = true;
  assert.equal(
    r.deliver('issues', issueOpened({ number: 2 }), { id: 'after-the-change' }).body.started,
    1,
  );
  r.cleanup();
});

test('a scheduled duty of a project the operator no longer names does not run', async () => {
  const { r, policy } = await setup();
  const [duty] = (await r.activate(
    spec({ trigger: { kind: 'schedule', everyMinutes: 15 }, runBudgetUsd: 1, dailyCapUsd: 10 }),
  )) as [string];
  policy.named = false;
  r.clock.advance(HOUR);
  assert.equal(r.engine.tick().started, 0);
  assert.equal(r.engine.requestsOf(duty).length, 0);

  // Named again: it runs once for the latest slot; nothing was used up while it waited.
  policy.named = true;
  assert.equal(r.engine.tick().started, 1);
  r.cleanup();
});

test('a request waiting to launch is ended, and its money released, when the operator stops naming the project', async () => {
  const { r, policy } = await setup();
  const [duty] = (await r.activate(ISSUE)) as [string];
  r.deliver('issues', issueOpened({ number: 1 }));
  const id = r.engine.requestsOf(duty)[0]?.requestId as string;
  const day = new Date(r.clock.t).toISOString().slice(0, 10);
  assert.deepEqual(r.engine.dayUsage(duty, day), { reservedUsd: 1, spentUsd: 0 });

  policy.named = false;
  assert.equal(r.engine.beginLaunch(id), undefined);
  assert.equal(r.engine.request(id)?.state, 'cancelled');
  assert.equal(r.engine.request(id)?.reason, 'project_not_allowed');
  assert.deepEqual(r.engine.dayUsage(duty, day), { reservedUsd: 0, spentUsd: 0 });
  r.cleanup();
});

test('at start, a stored project the operator no longer names is parked: its waiting runs end and the owner is told once', async () => {
  const { r, policy } = await setup();
  const [duty] = (await r.activate(ISSUE)) as [string];
  r.deliver('issues', issueOpened({ number: 1 }));
  const id = r.engine.requestsOf(duty)[0]?.requestId as string;

  policy.named = false;
  r.reopen();
  assert.equal(r.engine.request(id)?.state, 'cancelled');
  assert.equal(r.engine.request(id)?.reason, 'project_not_allowed');
  const notices = r.engine.pendingNotices();
  assert.equal(notices.length, 1);
  assert.match(notices[0]?.text ?? '', /paused/);

  // Starting again with the same policy tells nothing twice.
  r.reopen();
  assert.equal(r.engine.pendingNotices().length, 1);
  // And a project the policy still names is untouched.
  policy.named = true;
  r.reopen();
  assert.equal(r.deliver('issues', issueOpened({ number: 3 })).body.started, 1);
  r.cleanup();
});

test('the policy is asked with the project that is stored, not with what a delivery claims', async () => {
  const seen: Array<{ owner: string; repo: string; installationId: number }> = [];
  const { r } = await setup({
    allowProject: (input) => {
      seen.push(input);
      return true;
    },
  });
  await r.activate(ISSUE);
  seen.length = 0;
  r.deliver('issues', issueOpened({ number: 1 }));
  assert.deepEqual(seen, [{ owner: 'inv_owner', repo: 'acme/widgets', installationId: 4242 }]);
  r.cleanup();
});

test('a request whose run an earlier attempt made is finished even when the project is parked; one with no run is ended', async () => {
  const { r, policy } = await setup();
  const [duty] = (await r.activate(ISSUE)) as [string];
  r.deliver('issues', issueOpened({ number: 1 }));
  r.deliver('issues', issueOpened({ number: 2 }));
  const [withRun, withoutRun] = r.engine.requestsOf(duty).map((request) => request.requestId) as [
    string,
    string,
  ];
  // Both launches were cut short; only the first got as far as making the run.
  assert.ok(r.engine.beginLaunch(withRun));
  assert.ok(r.engine.beginLaunch(withoutRun));
  policy.named = false;
  r.reopen();
  assert.equal(r.engine.request(withRun)?.state, 'pending', 'the sweep leaves attempted requests');

  const dispatcher = new Dispatcher({
    engine: r.engine,
    now: r.clock.now,
    launcher: {
      begun: (request) => request.requestId === withRun,
      start: async (request) => ({ conversationId: `cnv_${request.requestId}` }),
    },
  });
  dispatcher.kick();
  await dispatcher.settled();
  assert.equal(r.engine.request(withRun)?.state, 'started');
  assert.equal(r.engine.finish(withRun, 'completed', 0.5), true, 'and it settles');
  assert.equal(r.engine.request(withoutRun)?.reason, 'project_not_allowed');
  await dispatcher.close();
  r.cleanup();
});
