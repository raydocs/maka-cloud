import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposeDuties, MAX_PROPOSED, MIN_PROPOSED, type RepoFacts } from '../propose.js';
import { DutyEngine } from '../engine.js';
import { DutySpecSchema } from '../types.js';
import { DAY, FACTS, issueOpened, REPO, rig, SECRET, workflowRun } from './harness.js';

const inspector = (facts: RepoFacts = FACTS) => ({ inspect: async () => facts });

test('a proposal is two to four valid duties, the recommended set first, and it activates nothing', async () => {
  const r = await rig({ proposer: proposeDuties });
  const result = await r.engine.propose('inv_owner', r.projectId, inspector());
  assert.ok(result.ok && result.created);
  const { proposal } = result;
  const project = r.engine.project('inv_owner', r.projectId);
  assert.ok(project);
  assert.ok(project.duties.length >= MIN_PROPOSED && project.duties.length <= MAX_PROPOSED);
  assert.ok(project.duties.every((duty) => duty.state === 'proposed' && duty.activatedAt === null));
  for (const duty of project.duties)
    assert.ok(
      DutySpecSchema.safeParse({
        name: duty.name,
        trigger: duty.trigger,
        instruction: duty.instruction,
        authority: duty.authority,
        runBudgetUsd: duty.runBudgetUsd,
        dailyCapUsd: duty.dailyCapUsd,
      }).success,
    );
  assert.equal(proposal.sets[0]?.recommended, true);
  assert.equal(proposal.sets[0]?.id, 'recommended');
  assert.equal(proposal.sets.at(-1)?.id, 'none');
  assert.equal(proposal.sets.filter((set) => set.recommended).length, 1);
  r.cleanup();
});

test('nothing runs until the owner approves: events and schedules before approval start no run', async () => {
  const r = await rig({ proposer: proposeDuties });
  await r.engine.propose('inv_owner', r.projectId, inspector());
  const events = [r.deliver('workflow_run', workflowRun()), r.deliver('issues', issueOpened())];
  assert.ok(events.every((event) => event.body.started === 0));
  r.clock.advance(30 * DAY);
  assert.deepEqual(r.engine.tick(), { started: 0, missedSlots: 0 });
  assert.deepEqual(r.engine.due(), []);
  r.cleanup();
});

test('approving a set activates exactly its duties; the same answer again changes nothing, a different one conflicts', async () => {
  const r = await rig({ proposer: proposeDuties });
  const proposed = await r.engine.propose('inv_owner', r.projectId, inspector());
  assert.ok(proposed.ok);
  const { proposalId } = proposed.proposal;
  const readOnly = proposed.proposal.sets.find((set) => set.id === 'read-only');
  assert.ok(readOnly && readOnly.dutyIds.length > 0);

  const first = r.engine.decideProposal({ proposalId, setId: 'read-only', caller: 'inv_owner' });
  assert.ok(first.ok && !first.duplicate);
  const active = (r.engine.project('inv_owner', r.projectId)?.duties ?? []).filter(
    (duty) => duty.state === 'active',
  );
  assert.deepEqual(active.map((duty) => duty.dutyId).sort(), [...readOnly.dutyIds].sort());
  assert.ok(active.every((duty) => duty.authority === 'read-only' && duty.activatedAt !== null));

  const again = r.engine.decideProposal({ proposalId, setId: 'read-only', caller: 'inv_owner' });
  assert.ok(again.ok && again.duplicate);
  const conflict = r.engine.decideProposal({
    proposalId,
    setId: 'recommended',
    caller: 'inv_owner',
  });
  assert.deepEqual(conflict, { ok: false, reason: 'conflict' });
  assert.equal(
    (r.engine.project('inv_owner', r.projectId)?.duties ?? []).filter(
      (duty) => duty.state === 'active',
    ).length,
    active.length,
  );
  r.cleanup();
});

test('choosing none activates nothing and a duty the owner declined cannot be switched on', async () => {
  const r = await rig({ proposer: proposeDuties });
  const proposed = await r.engine.propose('inv_owner', r.projectId, inspector());
  assert.ok(proposed.ok);
  assert.ok(
    r.engine.decideProposal({
      proposalId: proposed.proposal.proposalId,
      setId: 'none',
      caller: 'inv_owner',
    }).ok,
  );
  const duties = r.engine.project('inv_owner', r.projectId)?.duties ?? [];
  assert.ok(duties.every((duty) => duty.state === 'off'));
  assert.equal(
    r.engine.setDutyState('inv_owner', duties[0]?.dutyId as string, 'active'),
    'not_approved',
  );
  assert.equal(r.deliver('workflow_run', workflowRun()).body.started, 0);
  r.cleanup();
});

test("only the project's owner can decide, and an unknown set or proposal is refused", async () => {
  const r = await rig({ proposer: proposeDuties });
  const proposed = await r.engine.propose('inv_owner', r.projectId, inspector());
  assert.ok(proposed.ok);
  const { proposalId } = proposed.proposal;
  assert.deepEqual(
    r.engine.decideProposal({ proposalId, setId: 'recommended', caller: 'inv_other' }),
    { ok: false, reason: 'forbidden' },
  );
  assert.deepEqual(
    r.engine.decideProposal({ proposalId, setId: 'everything', caller: 'inv_owner' }),
    { ok: false, reason: 'unknown_set' },
  );
  assert.deepEqual(
    r.engine.decideProposal({ proposalId: 'prp_nope', setId: 'recommended', caller: 'inv_owner' }),
    { ok: false, reason: 'not_found' },
  );
  assert.ok(
    (r.engine.project('inv_owner', r.projectId)?.duties ?? []).every(
      (duty) => duty.state === 'proposed',
    ),
  );
  r.cleanup();
});

test('asking again returns the open proposal; once decided the project is set up and is not proposed to again', async () => {
  const r = await rig({ proposer: proposeDuties });
  const first = await r.engine.propose('inv_owner', r.projectId, inspector());
  const second = await r.engine.propose('inv_owner', r.projectId, inspector());
  assert.ok(first.ok && second.ok);
  assert.equal(second.created, false);
  assert.equal(second.proposal.proposalId, first.proposal.proposalId);
  r.engine.decideProposal({
    proposalId: first.proposal.proposalId,
    setId: 'recommended',
    caller: 'inv_owner',
  });
  assert.deepEqual(await r.engine.propose('inv_owner', r.projectId, inspector()), {
    ok: false,
    reason: 'already_set_up',
  });
  r.cleanup();
});

test('an inspector that fails leaves no proposal, and another owner cannot propose for the project', async () => {
  const r = await rig({ proposer: proposeDuties });
  const failed = await r.engine.propose('inv_owner', r.projectId, {
    inspect: async () => {
      throw new Error('GitHub is down');
    },
  });
  assert.deepEqual(failed, { ok: false, reason: 'inspect_failed' });
  assert.equal((r.engine.project('inv_owner', r.projectId)?.duties ?? []).length, 0);
  assert.deepEqual(await r.engine.propose('inv_other', r.projectId, inspector()), {
    ok: false,
    reason: 'not_found',
  });
  r.cleanup();
});

test('the rules choose by what the repository has, the same facts always give the same proposal', () => {
  const quiet = proposeDuties({
    defaultBranch: 'main',
    workflows: [],
    openIssues: 0,
    failedRunsLast30Days: 0,
  });
  assert.ok(quiet.duties.length >= MIN_PROPOSED);
  assert.ok(
    quiet.duties.every(
      (duty) =>
        duty.trigger.kind !== 'ci_failed_default_branch' &&
        duty.trigger.kind !== 'ci_failed_own_pr',
    ),
    'no CI, no CI duty',
  );

  const noisy = proposeDuties({
    defaultBranch: 'main',
    workflows: ['CI'],
    openIssues: 30,
    failedRunsLast30Days: 12,
  });
  assert.equal(noisy.duties.length, MAX_PROPOSED);
  assert.equal(
    noisy.duties[0]?.trigger.kind,
    'ci_failed_default_branch',
    'recent failures put the CI duty first',
  );
  assert.deepEqual(proposeDuties(FACTS), proposeDuties(FACTS));
  for (const proposal of [quiet, noisy]) {
    assert.equal(proposal.sets[0]?.recommended, true);
    assert.ok(
      proposal.duties.every((duty) => duty.authority !== 'merge-when-green'),
      'merging is never proposed',
    );
  }
});

test('a project can only be registered where the operator allows it, once, with a valid shape', async () => {
  const r = await rig({ allowProject: ({ repo }) => repo === 'acme/widgets' });
  const shape = {
    repo: 'acme/other',
    installationId: 1,
    defaultBranch: 'main',
    selfLogins: ['bot'],
  };
  assert.deepEqual(r.engine.addProject('inv_owner', shape), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(r.engine.addProject('inv_owner', { ...shape, repo: REPO }), {
    ok: false,
    reason: 'exists',
  });
  for (const bad of [
    { ...shape, selfLogins: [] },
    { ...shape, repo: 'no-slash' },
    { ...shape, extra: 1 },
    { ...shape, installationId: 'x' },
    null,
  ]) {
    assert.deepEqual(r.engine.addProject('inv_owner', bad), { ok: false, reason: 'invalid' });
  }
  r.cleanup();

  // With no policy at all, nothing can be registered.
  const closed = new DutyEngine({ dbPath: ':memory:', webhookSecret: SECRET });
  assert.deepEqual(closed.addProject('inv_owner', { ...shape, repo: REPO }), {
    ok: false,
    reason: 'not_allowed',
  });
  closed.close();
});
