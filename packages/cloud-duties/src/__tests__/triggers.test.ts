import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CI_DEFAULT,
  CI_OWN,
  ISSUES,
  issueComment,
  issueOpened,
  REVIEWS,
  review,
  reviewComment,
  rig,
  workflowRun,
} from './harness.js';

async function started(r: Awaited<ReturnType<typeof rig>>, dutyId: string) {
  return r.engine.requestsOf(dutyId).filter((request) => request.state === 'pending');
}

test('CI failing on the default branch wakes only that duty, and the run is external', async () => {
  const r = await rig();
  const [onMain, onPr, issues] = await r.activate(CI_DEFAULT, CI_OWN, ISSUES);
  const result = r.deliver('workflow_run', workflowRun({ branch: 'main', conclusion: 'failure' }));
  assert.equal(result.body.started, 1);
  assert.equal((await started(r, onMain as string)).length, 1);
  assert.equal((await started(r, onPr as string)).length, 0);
  assert.equal((await started(r, issues as string)).length, 0);

  const id = (await started(r, onMain as string))[0]?.requestId as string;
  const request = r.engine.request(id);
  assert.equal(request?.external, true, 'text from outside the owner taints the run');
  assert.equal(request?.authority, 'open-pr');
  assert.equal(request?.runBudgetUsd, 2);
  assert.equal(request?.owner, 'inv_owner');
  r.cleanup();
});

test("CI failing on the employee's own branch wakes the own-PR duty, a fork or another branch wakes nothing", async () => {
  const r = await rig();
  const [onMain, onPr] = await r.activate(CI_DEFAULT, CI_OWN);
  r.deliver('workflow_run', workflowRun({ id: 1, branch: 'maka/task_1', event: 'pull_request' }));
  assert.equal((await started(r, onPr as string)).length, 1);
  assert.equal((await started(r, onMain as string)).length, 0);

  assert.equal(
    r.deliver('workflow_run', workflowRun({ id: 2, branch: 'feature/x' })).body.ignored,
    'other_branch',
  );
  assert.equal(
    r.deliver('workflow_run', workflowRun({ id: 3, branch: 'main', headRepo: 'attacker/widgets' }))
      .body.ignored,
    'fork_or_unknown_branch',
  );
  assert.equal(
    r.deliver(
      'workflow_run',
      workflowRun({ id: 4, branch: 'maka/task_9', headRepo: 'attacker/widgets' }),
    ).body.ignored,
    'fork_or_unknown_branch',
  );
  // A pull request run on a branch named like the default one is not a default-branch failure.
  assert.equal(
    r.deliver('workflow_run', workflowRun({ id: 5, branch: 'main', event: 'pull_request' })).body
      .ignored,
    'other_branch',
  );
  assert.equal((await started(r, onMain as string)).length, 0);
  r.cleanup();
});

test('only a completed failure counts; successes, cancellations and other actions do not start a run', async () => {
  const r = await rig();
  const [duty] = await r.activate(CI_DEFAULT);
  r.deliver('workflow_run', workflowRun({ id: 1, conclusion: 'success' }));
  r.deliver('workflow_run', workflowRun({ id: 2, conclusion: 'cancelled' }));
  r.deliver('workflow_run', workflowRun({ id: 3, conclusion: null }));
  r.deliver('workflow_run', workflowRun({ id: 4, action: 'requested' }));
  assert.equal(r.engine.requestsOf(duty as string).length, 0);
  assert.equal(
    r.deliver('workflow_run', workflowRun({ id: 5, conclusion: 'timed_out' })).body.started,
    1,
  );
  r.cleanup();
});

test('a new issue wakes the issue duty; edits, pull requests, bots and the employee itself do not', async () => {
  const r = await rig();
  const [duty] = await r.activate(ISSUES);
  assert.equal(r.deliver('issues', issueOpened({ number: 1 })).body.started, 1);
  assert.equal(
    r.deliver('issues', issueOpened({ number: 2, action: 'edited' })).body.ignored,
    'action',
  );
  assert.equal(
    r.deliver('issues', issueOpened({ number: 3, senderType: 'Bot', user: 'dependabot[bot]' })).body
      .ignored,
    'self_or_bot',
  );
  assert.equal(
    r.deliver('issues', issueOpened({ number: 4, user: 'Maka-Bot' })).body.ignored,
    'self_or_bot',
  );
  assert.equal(r.engine.requestsOf(duty as string).length, 1);
  r.cleanup();
});

test("comments and reviews wake the review duty only on the employee's own pull requests", async () => {
  const r = await rig();
  const [duty] = await r.activate(REVIEWS);
  assert.equal(r.deliver('issue_comment', issueComment({ commentId: 1 })).body.started, 1);
  assert.equal(r.deliver('pull_request_review_comment', reviewComment({ id: 2 })).body.started, 1);
  assert.equal(r.deliver('pull_request_review', review({ id: 3 })).body.started, 1);

  assert.equal(
    r.deliver('issue_comment', issueComment({ commentId: 4, prAuthor: 'bob' })).body.ignored,
    'not_own_pr',
  );
  assert.equal(
    r.deliver('issue_comment', issueComment({ commentId: 5, isPr: false })).body.ignored,
    'not_a_pull_request',
  );
  assert.equal(
    r.deliver('pull_request_review_comment', reviewComment({ id: 6, prAuthor: 'bob' })).body
      .ignored,
    'not_own_pr',
  );
  // The employee's own comment on its own pull request must not wake itself.
  assert.equal(
    r.deliver('issue_comment', issueComment({ commentId: 7, commenter: 'maka-bot' })).body.ignored,
    'self_or_bot',
  );
  assert.equal(
    r.deliver(
      'issue_comment',
      issueComment({ commentId: 8, senderType: 'Bot', commenter: 'ci[bot]' }),
    ).body.ignored,
    'self_or_bot',
  );
  assert.equal(
    r.deliver('pull_request_review', review({ id: 9, state: 'approved', body: '' })).body.ignored,
    'approval_without_comment',
  );
  assert.equal(r.engine.requestsOf(duty as string).length, 3);
  r.cleanup();
});

test('a duty that is off, or only proposed, never matches an event', async () => {
  const r = await rig();
  const [duty] = await r.activate(ISSUES);
  assert.equal(r.engine.setDutyState('inv_owner', duty as string, 'off'), 'ok');
  assert.equal(r.deliver('issues', issueOpened({ number: 1 })).body.started, 0);
  assert.equal(r.engine.setDutyState('inv_owner', duty as string, 'active'), 'ok');
  assert.equal(r.deliver('issues', issueOpened({ number: 2 })).body.started, 1);
  r.cleanup();
});
