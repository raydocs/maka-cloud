import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeSandbox } from '../sandbox.js';
import { formatLocalLoopReport, MERGE_BOUND_TEXT, runLocalLoop } from '../local-loop.js';

test('the local loop smoke (fakes) covers spawn, passthrough, resume, approval, watchdog, ledger', async () => {
  const sandbox = new FakeSandbox();
  const report = await runLocalLoop({ sandbox, env: {} });
  assert.equal(report.sandboxKind, 'fake');
  assert.equal(report.judgeCallsOnSpawn, 1);
  assert.equal(report.judgeCallsAfterComment, 0, 'subscription pass-through must skip the Router');
  assert.equal(report.passthroughComment, true);
  assert.equal(report.passthroughCi, true);
  assert.equal(report.resumed, true);
  assert.equal(report.approvalBoundText, MERGE_BOUND_TEXT);
  assert.equal(report.approved, true);
  assert.ok(report.watchdogRules.includes('looping'));
  assert.ok(report.ledger.events >= 3);
  assert.ok(report.ledger.tokens > 0);
  assert.match(report.evidence, /### Evidence/u);
  assert.ok(report.states.includes('sleeping'));
  assert.ok(report.states.includes('awaiting_approval'));
  assert.ok(sandbox.commands.some((row) => row.cmd === 'echo spawn'));
  assert.ok(sandbox.commands.some((row) => row.cmd === 'echo approved'));
  assert.match(formatLocalLoopReport(report), /watchdog: looping/u);
  assert.ok(report.steps.includes('spawn'));
  assert.ok(report.steps.includes('resume-store'));
  assert.ok(report.steps.includes('approval-request'));
});
