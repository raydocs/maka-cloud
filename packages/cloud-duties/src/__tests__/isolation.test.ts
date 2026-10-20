import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig, spec, workflowRun } from './harness.js';

test('an owner sees and changes only their own projects and duties', async () => {
  const r = await rig();
  const [duty] = (await r.activate(spec({ trigger: { kind: 'issue_opened' } }))) as [string];
  assert.equal(r.engine.listProjects('inv_other').length, 0);
  assert.equal(r.engine.project('inv_other', r.projectId), undefined);
  assert.equal(r.engine.removeProject('inv_other', r.projectId), false);
  assert.equal(r.engine.setDutyState('inv_other', duty, 'off'), 'not_found');
  assert.equal(r.engine.listProjects('inv_owner').length, 1);
  assert.equal(r.engine.project('inv_owner', r.projectId)?.duties[0]?.state, 'active');

  // The project's repository belongs to one project: another owner cannot register it too.
  assert.deepEqual(
    r.engine.addProject('inv_other', {
      repo: 'ACME/Widgets',
      installationId: 4242,
      defaultBranch: 'main',
      selfLogins: ['x'],
    }),
    { ok: false, reason: 'exists' },
  );
  r.cleanup();
});

test('a removed project stops matching events, and its repository cannot be taken over by an old delivery', async () => {
  const r = await rig();
  await r.activate(spec({ trigger: { kind: 'ci_failed_default_branch' } }));
  assert.equal(r.engine.removeProject('inv_owner', r.projectId), true);
  assert.equal(r.deliver('workflow_run', workflowRun()).body.ignored, 'unknown_project');
  assert.equal(r.engine.listProjects('inv_owner').length, 0);
  r.cleanup();
});

test('repository names match without regard to case', async () => {
  const r = await rig();
  const [duty] = (await r.activate(spec({ trigger: { kind: 'ci_failed_default_branch' } }))) as [
    string,
  ];
  const payload = { ...workflowRun(), repository: { full_name: 'ACME/Widgets' } };
  assert.equal(r.deliver('workflow_run', payload).body.started, 1);
  assert.equal(r.engine.requestsOf(duty).length, 1);
  r.cleanup();
});
