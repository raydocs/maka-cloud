import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compactHistory,
  emptyAutonomy,
  estimateTokens,
  evaluateAutonomy,
  observeStreamSilence,
  observeTimeLimit,
  observeToolCall,
  observeTurn,
} from '../autonomy.js';
import { RecordingLead } from '../lead.js';
import { DEFAULT_AUTONOMY } from '../types.js';
import { clock, commentPayload, github, issuePayload, rig, TENANT } from './harness.js';

test('4 minutes of stream silence is a dropped stream that retries', () => {
  const { incident } = observeStreamSilence(emptyAutonomy(), 10);
  assert.equal(incident.action, 'retry');
  assert.equal(incident.rule, 'stream_silence');
});

test('a hard time limit gets at most two attempts then stops', () => {
  const first = observeTimeLimit(emptyAutonomy(), 1);
  assert.equal(first.incident.action, 'retry');
  const second = observeTimeLimit(first.state, 2);
  assert.equal(second.incident.action, 'stop');
  assert.equal(second.state.timeLimitAttempts, DEFAULT_AUTONOMY.timeLimitAttempts);
  const custom = observeTimeLimit(emptyAutonomy(), 1, { ...DEFAULT_AUTONOMY, timeLimitAttempts: 1 });
  assert.equal(custom.incident.action, 'stop');
});

test('three consecutive turns with no visible output stop the worker', () => {
  let state = emptyAutonomy();
  for (let i = 1; i <= 2; i += 1) {
    const next = observeTurn(state, { visible: false }, i);
    assert.equal(next.incident, undefined);
    state = next.state;
  }
  const third = observeTurn(state, { visible: false }, 3);
  assert.equal(third.incident?.action, 'stop');
  assert.equal(third.incident?.rule, 'empty_turns');
  const reset = observeTurn(third.state, { visible: true }, 4);
  assert.equal(reset.state.emptyTurns, 0);
});

test('three identical tool calls nudge; six stop; new results may continue', () => {
  let state = emptyAutonomy();
  const call = { name: 'bash', args: { cmd: 'ls' }, result: 'same' };
  for (let i = 1; i <= 2; i += 1) {
    const next = observeToolCall(state, call, i);
    assert.equal(next.incident, undefined);
    state = next.state;
  }
  const nudged = observeToolCall(state, call, 3);
  assert.equal(nudged.incident?.action, 'nudge');
  assert.equal(nudged.incident?.rule, 'repeat_tools');
  state = nudged.state;
  for (let i = 4; i <= 5; i += 1) {
    state = observeToolCall(state, call, i).state;
  }
  const stopped = observeToolCall(state, call, 6);
  assert.equal(stopped.incident?.action, 'stop');

  let poll = emptyAutonomy();
  poll = observeToolCall(poll, { name: 'gh', args: { cmd: 'ci' }, result: 'pending' }, 1).state;
  const fresh = observeToolCall(poll, { name: 'gh', args: { cmd: 'ci' }, result: 'success' }, 2);
  assert.equal(fresh.incident, undefined);
  assert.equal(fresh.state.identicalToolRuns, 1);
});

test('compaction summaries have a 16k token budget', () => {
  assert.equal(DEFAULT_AUTONOMY.compactionSummaryTokens, 16_000);
  const huge = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(2_000),
  }));
  const compacted = compactHistory(huge);
  assert.equal(compacted.summarized, true);
  assert.ok(compacted.tokens <= 16_000, `summary used ${compacted.tokens} tokens`);
  assert.ok(estimateTokens(huge.map((row) => row.content).join('')) > 16_000);
});

test('Superagent stop/nudge incidents hit the ledger, watchdog, progress, and lead', async () => {
  const lead = new RecordingLead();
  const time = clock();
  const { agent, handler, store } = rig({
    lead,
    clock: time.read,
    watchdog: { stallAfterMs: 60_000, heartbeatAfterMs: 120_000, loopRepeat: 9 },
  });
  handler.script = (_event, worker) => {
    const first = observeTurn(worker.autonomy ?? emptyAutonomy(), { visible: false }, time.now);
    const second = observeTurn(first.state, { visible: false }, time.now);
    const third = observeTurn(second.state, { visible: false }, time.now);
    return {
      progress: false,
      autonomy: third.state,
      incident: third.incident,
      progressUpdate: {
        phase: 'edit',
        activity: third.incident?.detail,
        reason: third.incident?.detail,
      },
    };
  };
  const opened = await agent.ingest(github(TENANT, 'au1', 'issues', issuePayload('opened', 70)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.state, 'stuck');
  assert.equal(worker?.progress?.lastReason, worker?.autonomy?.lastIncident?.detail);
  assert.equal(
    store.usageEvents(TENANT).some((row) => row.kind === 'autonomy_stop' && row.workerId === opened.workerId),
    true,
  );
  assert.equal(
    store.audit(TENANT).some((row) => row.kind === 'autonomy_stop'),
    true,
  );
  assert.match(lead.messages.at(-1)?.text ?? '', /no visible output|empty/i);
  const view = agent.statusSnapshot(TENANT).workers[0];
  assert.ok(view?.reason);
  assert.match(view.reason, /visible output/);

  const pending = evaluateAutonomy(
    {
      ...worker,
      autonomy: {
        ...emptyAutonomy(),
        pending: {
          action: 'nudge',
          rule: 'repeat_tools',
          detail: '3 identical bash calls; nudging.',
          at: time.now,
        },
      },
      state: 'running',
    },
    time.now,
  );
  assert.equal(pending?.action, 'nudge');
  assert.equal(pending?.rule, 'repeat_tools');
});

test('an empty-turn stop is a watchdog finding on tick when still pending', async () => {
  const { agent, store, time } = rig({
    watchdog: { stallAfterMs: 60_000, heartbeatAfterMs: 120_000, loopRepeat: 9 },
  });
  const opened = await agent.ingest(github(TENANT, 'au2', 'issues', issuePayload('opened', 71)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  store.putWorker({
    ...worker,
    state: 'running',
    lastProgressAt: time.now,
    lastHeartbeatAt: time.now,
    autonomy: {
      ...emptyAutonomy(),
      pending: {
        action: 'stop',
        rule: 'empty_turns',
        detail: '3 consecutive turns with no visible output.',
        at: time.now,
      },
    },
  });
  const findings = await agent.tick();
  assert.equal(
    findings.some((row) => row.rule === 'empty_turns' && row.action === 'stop'),
    true,
  );
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'stuck');
});

test('comment follow-up still pass-through after an autonomy nudge', async () => {
  const { agent, handler } = rig();
  let calls = 0;
  handler.script = () => {
    calls += 1;
    const state = emptyAutonomy();
    const nudged = observeToolCall(
      { ...state, lastToolKey: 'bash:{"cmd":"ls"}', lastToolResultHash: 'h:4:1', identicalToolRuns: 2 },
      { name: 'bash', args: { cmd: 'ls' }, result: 'same' },
      1,
    );
    return {
      progress: true,
      autonomy: nudged.state,
      incident: nudged.incident,
    };
  };
  const opened = await agent.ingest(github(TENANT, 'au3', 'issues', issuePayload('opened', 72)));
  assert.equal(opened.result, 'spawned');
  const follow = await agent.ingest(
    github(TENANT, 'au3c', 'issue_comment', commentPayload(72, 'go on', false, 9)),
  );
  assert.equal(follow.result, 'passthrough');
  assert.equal(calls, 2);
});
