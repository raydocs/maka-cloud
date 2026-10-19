import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calls, type ModelRequest, text, tool, toolResults } from './fake-model.js';
import { makeHarness } from './harness.js';

function effortOf(request: ModelRequest): unknown {
  const body = request.body as Record<string, unknown>;
  return (body.output_config as Record<string, unknown> | undefined)?.effort;
}

test('a research request runs the research playbook: plan at high effort, delegate, verify, deliver', async (t) => {
  const h = await makeHarness(t);
  h.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'research', goal: 'Compare two databases' })),
    (request) => {
      const [plan] = toolResults(request);
      assert.equal(plan?.isError, false, plan?.text);
      assert.equal(plan?.json?.playbook, 'research');
      assert.match(String(plan?.json?.plan), /Search the docs/);
      return calls(
        tool('delegate_task', {
          runner: 'claude-agent-sdk',
          brief: 'Research and draft the comparison.',
          mode: 'wait',
          timeoutMs: 10_000,
          budgetUsd: 1,
        }),
      );
    },
    (request) => {
      const [delegated] = toolResults(request);
      assert.equal(delegated?.isError, false, delegated?.text);
      const task = delegated?.json?.task as Record<string, unknown>;
      assert.equal(task.state, 'succeeded');
      assert.deepEqual(task.verification, { ok: true, problems: [] });
      return text('Here is the checked comparison.');
    },
  );
  h.model.script(
    'planner',
    text('1. Search the docs of both databases.\n2. Draft and check citations.'),
  );

  await h.send('cnv_1', 'Compare Postgres and SQLite for a small app.');
  await h.conductor.idle();

  assert.deepEqual(
    h.outbox.messages.map((message) => message.text),
    ['Here is the checked comparison.'],
  );
  assert.equal(h.claude.runs.length, 1);
  assert.equal(h.codex.runs.length, 0);
  const run = h.conductor.state.runsInState('done');
  assert.equal(run.length, 1);
  assert.equal(run[0]?.playbook, 'research');

  const conductorRequests = h.model.requests.filter((request) => request.lane === 'conductor');
  const plannerRequests = h.model.requests.filter((request) => request.lane === 'planner');
  assert.equal(conductorRequests.length, 3);
  assert.equal(plannerRequests.length, 1);
  for (const request of conductorRequests) assert.equal(effortOf(request), 'medium');
  assert.equal(effortOf(plannerRequests[0] as ModelRequest), 'high');
  assert.deepEqual(h.conductor.stats(), {
    runningTurns: 0,
    waitingForSlot: 0,
    queued: 0,
    planners: 0,
    timers: 0,
    openClients: 0,
    outboxSending: 0,
    outboxRetrying: 0,
    stopChecks: 0,
  });
});
