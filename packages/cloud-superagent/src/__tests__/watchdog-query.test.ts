import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordingLead } from '../lead.js';
import { handleProgressRequest, runStatusCli } from '../status.js';
import { formatWatchdogAnswer, parseWatchdogText, type WatchdogAnswer } from '../watchdog-query.js';
import { commentPayload, github, issuePayload, rig, TENANT } from './harness.js';

test('parseWatchdogText keeps questions as asks and imperatives as commands', () => {
  const stuck = parseWatchdogText('why is worker wrk_0002 stuck');
  assert.equal(stuck.kind, 'ask');
  if (stuck.kind !== 'ask') return;
  assert.equal(stuck.topic, 'stuck');
  assert.equal(stuck.workerId, 'wrk_0002');

  const happened = parseWatchdogText("what happened to yesterday's issue #9");
  assert.equal(happened.kind, 'ask');
  if (happened.kind !== 'ask') return;
  assert.equal(happened.topic, 'happened');
  assert.equal(happened.issue, 9);
  assert.equal(happened.when, 'yesterday');

  const everyone = parseWatchdogText('what is everyone doing');
  assert.equal(everyone.kind, 'ask');
  if (everyone.kind !== 'ask') return;
  assert.equal(everyone.topic, 'everyone');

  const nudge = parseWatchdogText('nudge wrk_0002');
  assert.equal(nudge.kind, 'command');
  if (nudge.kind !== 'command') return;
  assert.equal(nudge.command, 'nudge');
  assert.equal(nudge.workerId, 'wrk_0002');

  assert.equal(parseWatchdogText('please cancel worker wrk_aa').kind, 'command');
  assert.equal(parseWatchdogText('re-run stuck-check').kind, 'command');
});

test('askWatchdog answers why-stuck from findings and cites ids', async () => {
  const { agent, handler, time } = rig({
    watchdog: { loopRepeat: 3, stallAfterMs: 60_000, heartbeatAfterMs: 120_000, maxRestarts: 3 },
  });
  handler.script = () => ({ stepSignature: 'edit-login.ts', progress: false });
  const opened = await agent.ingest(github(TENANT, 'wq1', 'issues', issuePayload('opened', 21)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  await agent.ingest(github(TENANT, 'wq1c1', 'issue_comment', commentPayload(21, 'one', false, 1)));
  await agent.ingest(github(TENANT, 'wq1c2', 'issue_comment', commentPayload(21, 'two', false, 2)));
  time.advance(1);
  await agent.tick();
  const answer = await agent.askWatchdog(TENANT, `why is worker ${opened.workerId} stuck`);
  assert.equal(answer.source, 'fallback');
  assert.match(answer.text, /looping|stuck|repeats/i);
  assert.equal(
    answer.citations.some((id) => id === opened.workerId),
    true,
    answer.text,
  );
  assert.match(answer.text, /ids:/);
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'stuck');
});

test("askWatchdog recalls yesterday's issue through the trigger-thread-worker chain", async () => {
  const { agent, time } = rig();
  time.now = Date.UTC(2026, 10, 1, 18, 0, 0);
  const opened = await agent.ingest(github(TENANT, 'wq2', 'issues', issuePayload('opened', 9)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  time.now = Date.UTC(2026, 10, 2, 18, 0, 0);
  const answer = await agent.askWatchdog(TENANT, "what happened to yesterday's issue #9");
  assert.match(answer.text, /#9|issue:.*#9/i);
  assert.equal(
    answer.citations.some((id) => id === opened.workerId),
    true,
    answer.text,
  );
  assert.equal(
    answer.citations.some((id) => id.startsWith('evt_')),
    true,
    answer.text,
  );
});

test('askWatchdog lists everyone and a configured narrator still cites ids', async () => {
  const { agent, handler } = rig({
    watchdogNarrator: {
      async narrate() {
        return 'Everyone is editing. See the ids below.';
      },
    },
  });
  handler.script = () => ({
    progress: true,
    plan: 'fix login',
    progressUpdate: { phase: 'edit', activity: 'model step' },
  });
  const opened = await agent.ingest(github(TENANT, 'wq3', 'issues', issuePayload('opened', 22)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const { agent: fallbackAgent } = rig();
  fallbackAgent.store.putWorker(agent.worker(TENANT, opened.workerId)!);
  const fallback = await fallbackAgent.askWatchdog(TENANT, 'what is everyone doing');
  assert.equal(fallback.source, 'fallback');
  assert.match(fallback.text, /Everyone/);
  const narrated = await agent.askWatchdog(TENANT, 'what is everyone doing');
  assert.equal(narrated.source, 'model');
  assert.equal(
    narrated.citations.some((id) => id === opened.workerId),
    true,
  );
  assert.match(narrated.text, /ids:/);
});

test('an ask never nudges; instruct nudge / pause / resume / cancel / stuck-check do', async () => {
  const lead = new RecordingLead();
  const { agent, handler } = rig({ lead });
  handler.script = () => ({ progress: true, plan: 'keep going' });
  const opened = await agent.ingest(github(TENANT, 'wq4', 'issues', issuePayload('opened', 23)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const asked = await agent.askWatchdog(TENANT, `nudge ${opened.workerId}`);
  assert.equal(asked.intent.kind, 'command');
  assert.equal(asked.action, undefined);
  assert.equal(agent.worker(TENANT, opened.workerId)?.nudges ?? 0, 0);
  assert.match(asked.text, /instruct/);

  const nudged = await agent.instructWatchdog(TENANT, `nudge ${opened.workerId}`);
  assert.equal(nudged.action?.ok, true);
  assert.equal(nudged.action?.kind, 'nudge');
  assert.equal(agent.worker(TENANT, opened.workerId)?.nudges, 1);

  const paused = await agent.instructWatchdog(TENANT, `pause ${opened.workerId}`);
  assert.equal(paused.action?.ok, true);
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'paused');

  const resumed = await agent.instructWatchdog(TENANT, `resume ${opened.workerId}`);
  assert.equal(resumed.action?.ok, true);
  assert.notEqual(agent.worker(TENANT, opened.workerId)?.state, 'paused');

  const checked = await agent.instructWatchdog(TENANT, 're-run stuck-check');
  assert.equal(checked.action?.ok, true);
  assert.equal(checked.action?.kind, 'stuck_check');

  const cancelled = await agent.instructWatchdog(TENANT, `cancel ${opened.workerId}`);
  assert.equal(cancelled.action?.ok, true);
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'retired');
});

test('CLI --ask and GET ?ask= attach a watchdog answer that cites ids', async () => {
  const answer: WatchdogAnswer = {
    text: 'wrk_1 is editing.\nids: wrk_1',
    citations: ['wrk_1'],
    source: 'fallback',
    intent: { kind: 'ask', topic: 'everyone', text: 'what is everyone doing' },
  };
  const lines: string[] = [];
  const code = await runStatusCli({
    snapshot: {
      at: 1,
      workers: [
        {
          workerId: 'wrk_1',
          tenantId: TENANT,
          state: 'running',
          phase: 'edit',
          k: 1,
          n: 3,
          percent: 10,
          elapsedMs: 1,
          etaMs: 1,
          lastActivity: 'model',
          heartbeatAt: 1,
          look: 'running',
        },
      ],
    },
    argv: ['--ask', 'what is everyone doing'],
    askWatchdog: () => answer,
    stdout: (text) => lines.push(text),
  });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /wrk_1/);
  assert.match(lines.join('\n'), /ids:/);

  const json = handleProgressRequest({
    method: 'GET',
    url: '/v1/superagent/progress?ask=what+is+everyone+doing',
    snapshot: {
      at: 2,
      workers: [],
      watchdog: { text: answer.text, citations: answer.citations, source: 'fallback' },
    },
  });
  assert.equal(json.status, 200);
  const body = JSON.parse(json.body) as { watchdog?: { citations: string[] } };
  assert.deepEqual(body.watchdog?.citations, ['wrk_1']);
  assert.match(formatWatchdogAnswer(answer), /wrk_1/);
});
