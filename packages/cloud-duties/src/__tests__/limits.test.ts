import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DutyEngine } from '../engine.js';
import {
  DutySpecSchema,
  MAX_CHAIN_DEPTH,
  MAX_CONSECUTIVE_FAILURES,
  MAX_ENABLED_DUTIES,
  MIN_SCHEDULE_MINUTES,
} from '../types.js';
import {
  CI_OWN,
  FACTS,
  issueOpened,
  OWNER,
  proposalOf,
  review,
  reviewComment,
  rig,
  SECRET,
  spec,
  workflowRun,
} from './harness.js';

const ISSUE_DUTY = spec({ trigger: { kind: 'issue_opened' }, runBudgetUsd: 0.5, dailyCapUsd: 20 });

// ------------------------------------------------------------- schedule

test('a schedule runs at most every 15 minutes: a shorter one is refused wherever a duty is made', async () => {
  assert.equal(MIN_SCHEDULE_MINUTES, 15);
  const schedule = (everyMinutes: number) =>
    DutySpecSchema.safeParse({ ...ISSUE_DUTY, trigger: { kind: 'schedule', everyMinutes } });
  assert.equal(schedule(14).success, false);
  assert.equal(schedule(1).success, false);
  assert.equal(schedule(15).success, true);

  // A proposer that offers a 5-minute schedule proposes nothing.
  const r = await rig({
    proposer: () =>
      proposalOf(spec({ trigger: { kind: 'schedule', everyMinutes: 5 } }), ISSUE_DUTY),
  });
  const result = await r.engine.propose(OWNER, r.projectId, { inspect: async () => FACTS });
  assert.equal(result.ok, false);
  r.cleanup();
});

test('a 15-minute schedule runs once per slot', async () => {
  const r = await rig();
  await r.activate(
    spec({ trigger: { kind: 'schedule', everyMinutes: 15 }, runBudgetUsd: 0.5, dailyCapUsd: 20 }),
  );
  r.clock.advance(15 * 60_000);
  assert.equal(r.engine.tick().started, 1);
  assert.equal(r.engine.tick().started, 0);
  r.clock.advance(15 * 60_000);
  assert.equal(r.engine.tick().started, 1);
  r.cleanup();
});

// ------------------------------------------------------- enabled duties

/** An engine with `projects` projects of one invite, each ready for a proposal of `duties` duties. */
function manyDuties() {
  let proposing = proposalOf(ISSUE_DUTY);
  const engine = new DutyEngine({
    dbPath: ':memory:',
    webhookSecret: SECRET,
    allowProject: () => true,
    proposer: () => proposing,
  });
  let n = 0;
  const propose = async (owner: string, count: number) => {
    n += 1;
    proposing = proposalOf(
      ...Array.from({ length: count }, (_, i) => ({ ...ISSUE_DUTY, name: `duty ${n}.${i}` })),
    );
    const added = engine.addProject(owner, {
      repo: `acme/repo${n}`,
      installationId: n,
      defaultBranch: 'main',
      selfLogins: ['maka-bot'],
    });
    assert.ok(added.ok);
    const proposed = await engine.propose(owner, added.project.projectId, {
      inspect: async () => FACTS,
    });
    assert.ok(proposed.ok);
    return { projectId: added.project.projectId, proposal: proposed.proposal };
  };
  const enable = (owner: string, proposalId: string) =>
    engine.decideProposal({ proposalId, setId: 'recommended', caller: owner });
  const enabled = (owner: string) =>
    engine
      .listProjects(owner)
      .flatMap((project) => project.duties)
      .filter((duty) => duty.state === 'active').length;
  return { engine, propose, enable, enabled };
}

test('an invite has at most 20 enabled duties: a proposal that would pass it changes nothing', async () => {
  assert.equal(MAX_ENABLED_DUTIES, 20);
  const m = manyDuties();
  const fives = [];
  for (let i = 0; i < 5; i += 1) fives.push(await m.propose(OWNER, 4));
  const two = await m.propose(OWNER, 2);
  const one = await m.propose(OWNER, 1);
  for (const x of fives) assert.ok(m.enable(OWNER, x.proposal.proposalId).ok);
  assert.equal(m.enabled(OWNER), 20);

  assert.deepEqual(m.enable(OWNER, one.proposal.proposalId), { ok: false, reason: 'duty_limit' });
  assert.equal(m.enabled(OWNER), 20, 'nothing was enabled');
  assert.equal(
    m.engine.proposal(one.proposal.proposalId)?.state,
    'open',
    'and it can still be decided',
  );
  const told = m.engine.pendingNotices();
  assert.equal(told.length, 1, 'the owner is told, because the choice closed its inbox item');
  assert.equal(told[0]?.owner, OWNER);
  assert.match(told[0]?.text ?? '', /acme\/repo7 were not set up.*20 enabled duties/u);

  // One freed is room for one, not for two.
  const [first] = m.engine.project(OWNER, fives[0]?.projectId ?? '')?.duties ?? [];
  assert.equal(m.engine.setDutyState(OWNER, first?.dutyId ?? '', 'off'), 'ok');
  assert.deepEqual(m.enable(OWNER, two.proposal.proposalId), { ok: false, reason: 'duty_limit' });
  assert.equal(m.enable(OWNER, one.proposal.proposalId).ok, true);
  assert.equal(m.enabled(OWNER), 20);

  // Switching the freed duty back on would be the 21st.
  assert.equal(m.engine.setDutyState(OWNER, first?.dutyId ?? '', 'active'), 'duty_limit');
  assert.equal(m.enabled(OWNER), 20);
  // Switching an enabled duty on again is not a new one.
  const [second] = m.engine.project(OWNER, fives[1]?.projectId ?? '')?.duties ?? [];
  assert.equal(m.engine.setDutyState(OWNER, second?.dutyId ?? '', 'active'), 'ok');
  m.engine.close();
});

test('the limit is per invite: another invite is not counted', async () => {
  const m = manyDuties();
  for (let i = 0; i < 5; i += 1) {
    assert.ok(m.enable(OWNER, (await m.propose(OWNER, 4)).proposal.proposalId).ok);
  }
  const other = await m.propose('inv_other', 4);
  assert.ok(m.enable('inv_other', other.proposal.proposalId).ok);
  assert.equal(m.enabled('inv_other'), 4);
  m.engine.close();
});

test('a removed project frees its duties', async () => {
  const m = manyDuties();
  const first = await m.propose(OWNER, 4);
  assert.ok(m.enable(OWNER, first.proposal.proposalId).ok);
  for (let i = 0; i < 4; i += 1)
    assert.ok(m.enable(OWNER, (await m.propose(OWNER, 4)).proposal.proposalId).ok);
  const more = await m.propose(OWNER, 1);
  assert.equal(m.enable(OWNER, more.proposal.proposalId).ok, false);
  assert.ok(m.engine.removeProject(OWNER, first.projectId));
  assert.equal(m.enable(OWNER, more.proposal.proposalId).ok, true);
  m.engine.close();
});

// -------------------------------------------------------------- failures

/** A started request of the issue duty. */
async function failing() {
  const r = await rig();
  const [duty] = (await r.activate(ISSUE_DUTY)) as [string];
  let n = 0;
  const run = () => {
    n += 1;
    assert.equal(r.deliver('issues', issueOpened({ number: n })).body.started, 1);
    const id = r.engine.requestsOf(duty)[0]?.requestId as string;
    assert.ok(r.engine.beginLaunch(id));
    assert.ok(r.engine.launched(id, `cnv_${n}`));
    return id;
  };
  const state = () => r.engine.project(OWNER, r.projectId)?.duties.find((d) => d.dutyId === duty);
  return { r, duty, run, state };
}

test('a duty that fails 10 times in a row turns itself off, cancels what waits, and tells the owner once', async () => {
  assert.equal(MAX_CONSECUTIVE_FAILURES, 10);
  const { r, duty, run, state } = await failing();
  for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
    assert.equal(r.engine.finish(run(), 'failed', 0.1), true);
    assert.equal(state()?.state, 'active', `still on after ${i}`);
    assert.equal(state()?.consecutiveFailures, i);
  }
  assert.deepEqual(r.engine.pendingNotices(), []);
  // One more waits for its turn when the tenth fails.
  const tenth = run();
  r.deliver('issues', issueOpened({ number: 99 }));
  const waiting = r.engine.requestsOf(duty).find((request) => request.state === 'pending');
  assert.ok(waiting);
  assert.equal(r.engine.finish(tenth, 'failed', 0.1), true);
  assert.equal(state()?.state, 'off');
  assert.equal(state()?.offReason, 'failures');
  assert.equal(
    r.engine.request(waiting.requestId)?.state,
    'cancelled',
    'a request waiting to start is cancelled',
  );
  assert.equal(r.engine.dayUsage(duty).reservedUsd, 0, 'and its reservation is released');

  const [notice, ...rest] = r.engine.pendingNotices();
  assert.equal(rest.length, 0);
  assert.equal(notice?.owner, OWNER);
  assert.match(notice?.text ?? '', /failed 10 times in a row and has turned itself off/);
  r.engine.noticeDelivered(notice?.noticeKey ?? '');
  assert.deepEqual(r.engine.pendingNotices(), []);

  // Off means off: nothing more starts.
  assert.equal(r.deliver('issues', issueOpened({ number: 100 })).body.started, 0);
  // Only the owner switching it on starts the count again, and a new run is a new count.
  assert.equal(r.engine.setDutyState(OWNER, duty, 'active'), 'ok');
  assert.equal(state()?.consecutiveFailures, 0);
  assert.equal(state()?.offReason, null);
  assert.equal(r.deliver('issues', issueOpened({ number: 101 })).body.started, 1);
  r.cleanup();
});

test('a run that completes clears the count; a stopped run neither adds nor clears', async () => {
  const { r, run, state } = await failing();
  for (let i = 0; i < 9; i += 1) r.engine.finish(run(), 'failed', 0);
  assert.equal(state()?.consecutiveFailures, 9);
  r.engine.finish(run(), 'stopped', 0);
  assert.equal(state()?.consecutiveFailures, 9);
  r.engine.finish(run(), 'completed', 0);
  assert.equal(state()?.consecutiveFailures, 0);
  for (let i = 0; i < 9; i += 1) r.engine.finish(run(), 'failed', 0);
  assert.equal(state()?.state, 'active', '9 and 9 are not 10 in a row');
  r.cleanup();
});

test('an abandoned run and a launch that ran out of attempts count as failures; a refused launch does not', async () => {
  const { r, duty, run, state } = await failing();
  r.engine.finish(run(), 'abandoned');
  assert.equal(state()?.consecutiveFailures, 1);

  r.deliver('issues', issueOpened({ number: 50 }));
  const refused = r.engine.requestsOf(duty).find((x) => x.state === 'pending')?.requestId as string;
  assert.ok(r.engine.beginLaunch(refused));
  r.engine.launchFailed(refused, { permanent: true, retryAfterMs: 0 });
  assert.equal(state()?.consecutiveFailures, 1, 'the owner being gone is not the duty failing');

  r.deliver('issues', issueOpened({ number: 51 }));
  const worn = r.engine.requestsOf(duty).find((x) => x.state === 'pending')?.requestId as string;
  for (let i = 0; i < 5; i += 1) {
    assert.ok(r.engine.beginLaunch(worn));
    r.engine.launchFailed(worn, { permanent: false, retryAfterMs: 0 });
  }
  assert.equal(r.engine.request(worn)?.state, 'cancelled');
  assert.equal(state()?.consecutiveFailures, 2);
  r.cleanup();
});

// ---------------------------------------------------------------- chains

const OWN = 'maka/fix-ci';
const OWN_DUTY = { ...CI_OWN, runBudgetUsd: 0.5, dailyCapUsd: 20 };
const REVIEW_DUTY = spec({
  trigger: { kind: 'review_comment_own_pr' },
  runBudgetUsd: 0.5,
  dailyCapUsd: 20,
});
const ownFailure = (id: number, over: { branch?: string; number?: number } = {}) =>
  workflowRun({ id, number: over.number ?? id, branch: over.branch ?? OWN, event: 'push' });

test('runs woken by the checks of their own branch stop after 3 in a row and need the user', async () => {
  assert.equal(MAX_CHAIN_DEPTH, 3);
  const r = await rig();
  const [duty] = (await r.activate(OWN_DUTY)) as [string];
  for (let id = 1; id <= MAX_CHAIN_DEPTH; id += 1) {
    assert.equal(r.deliver('workflow_run', ownFailure(id)).body.started, 1, `run ${id}`);
  }
  const fourth = r.deliver('workflow_run', ownFailure(4));
  assert.equal(fourth.body.started, 0);
  assert.equal(fourth.body.ignored, 'chain_limit');
  assert.equal(r.engine.requestsOf(duty).length, MAX_CHAIN_DEPTH, 'no fourth request');

  const [notice, ...rest] = r.engine.pendingNotices();
  assert.equal(rest.length, 0);
  assert.match(notice?.text ?? '', /woken 3 times in a row by the checks of its own work/);
  // Further failures of the same chain add nothing and tell nothing again.
  r.deliver('workflow_run', ownFailure(5));
  r.deliver('workflow_run', ownFailure(6));
  assert.equal(r.engine.pendingNotices().length, 1);
  assert.equal(r.engine.requestsOf(duty).length, MAX_CHAIN_DEPTH);
  r.cleanup();
});

test('a redelivered failure does not count twice', async () => {
  const r = await rig();
  const [duty] = (await r.activate(OWN_DUTY)) as [string];
  for (let i = 0; i < 5; i += 1) r.deliver('workflow_run', ownFailure(1), { id: `same-${i}` });
  r.deliver('workflow_run', ownFailure(2));
  r.deliver('workflow_run', ownFailure(3));
  assert.equal(r.engine.requestsOf(duty).length, 3);
  assert.equal(r.engine.pendingNotices().length, 0, 'three is allowed');
  r.cleanup();
});

test('the chain ends when the workflow passes on that branch, or when a person acts on the project', async () => {
  const r = await rig();
  const [onOwn, reviews] = (await r.activate(OWN_DUTY, REVIEW_DUTY)) as [string, string];
  for (let id = 1; id <= MAX_CHAIN_DEPTH; id += 1) r.deliver('workflow_run', ownFailure(id));
  assert.equal(r.deliver('workflow_run', ownFailure(4)).body.ignored, 'chain_limit');

  // The branch passes: a later failure is a new chain.
  r.deliver(
    'workflow_run',
    workflowRun({ id: 50, number: 50, branch: OWN, conclusion: 'success' }),
  );
  assert.equal(r.deliver('workflow_run', ownFailure(60, { number: 60 })).body.started, 1);
  for (let id = 61; id <= 62; id += 1) r.deliver('workflow_run', ownFailure(id, { number: id }));
  assert.equal(
    r.deliver('workflow_run', ownFailure(63, { number: 63 })).body.ignored,
    'chain_limit',
  );

  // A person reviews: it may go on.
  assert.equal(
    r.deliver('pull_request_review_comment', reviewComment({ id: 700 })).body.started,
    1,
  );
  assert.equal(r.deliver('workflow_run', ownFailure(70, { number: 70 })).body.started, 1);
  assert.equal(r.engine.requestsOf(reviews).length, 1);
  assert.ok(r.engine.requestsOf(onOwn).length === 7);
  r.cleanup();
});

test('chains are per branch, and a failure on the default branch is not part of one', async () => {
  const r = await rig();
  const [duty] = (await r.activate(OWN_DUTY)) as [string];
  for (let id = 1; id <= MAX_CHAIN_DEPTH; id += 1) r.deliver('workflow_run', ownFailure(id));
  assert.equal(
    r.deliver('workflow_run', ownFailure(10, { branch: 'maka/other' })).body.started,
    1,
    'another branch has its own count',
  );
  assert.equal(r.engine.requestsOf(duty).length, MAX_CHAIN_DEPTH + 1);
  r.cleanup();
});

test('a review by a person that does not start a run still lets a stopped chain go on', async () => {
  const r = await rig();
  await r.activate(OWN_DUTY);
  for (let id = 1; id <= MAX_CHAIN_DEPTH; id += 1) r.deliver('workflow_run', ownFailure(id));
  assert.equal(r.deliver('workflow_run', ownFailure(4)).body.ignored, 'chain_limit');
  // No duty listens for reviews here, but the person has looked.
  r.deliver(
    'pull_request_review',
    review({ id: 5, state: 'commented', body: 'looks fine, keep going' }),
  );
  assert.equal(r.deliver('workflow_run', ownFailure(5)).body.started, 1);
  r.cleanup();
});
