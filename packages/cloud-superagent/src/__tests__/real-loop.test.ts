import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeSandbox } from '../sandbox.js';
import { formatRealLoopReport, runRealLoop } from '../real-loop.js';

test('real-loop fake path clones, tests, pushes, resumes CI/review, holds merge', async () => {
  const sandbox = new FakeSandbox();
  const report = await runRealLoop({ sandbox, env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.live, false);
  assert.ok(report.workerId);
  assert.ok(report.branch?.startsWith('maka/sa-'));
  assert.ok(report.prUrl);
  assert.ok(report.steps.includes('spawn'));
  assert.ok(report.steps.includes('push'));
  assert.ok(report.steps.includes('ci-resume'));
  assert.ok(report.steps.includes('review-resume'));
  assert.ok(report.steps.includes('merge-held'));
  assert.ok(report.steps.includes('merge-approved'));
  assert.match(report.evidence, /### Evidence/);
  assert.ok(sandbox.commands.some((row) => row.cmd.startsWith('echo loop-verify')));
  assert.match(formatRealLoopReport(report), /ok: true/);
});

test('real-loop does not go live without MAKA_CLOUD_LOOP_LIVE=1', async () => {
  const report = await runRealLoop({
    env: { INSTABOX_API_KEY: 'ibx-must-not-be-used' },
    sandbox: new FakeSandbox(),
  });
  assert.equal(report.live, false);
  assert.equal(report.machineId, null);
  assert.equal(report.ok, true);
});
