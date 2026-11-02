import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STUCK_REASON, formatStuckAsk } from '../stuck.js';
import { commentPayload, github, issuePayload, rig, TENANT } from './harness.js';

test('a spinning handler becomes a T33 stuck card on the watchdog tick', async () => {
  const cards: Array<{ reason: string; workerId: string }> = [];
  const { agent, handler, time } = rig({
    watchdog: { stallAfterMs: 1_000, heartbeatAfterMs: 60_000, loopRepeat: 9 },
    onEscalate: (card) => cards.push(card),
  });
  handler.script = () => ({
    progress: false,
    plan: 'keep editing login.ts',
    stepSignature: 'edit',
  });
  const opened = await agent.ingest(github(TENANT, 's1', 'issues', issuePayload('opened', 21)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  agent.store.putWorker({
    ...worker,
    state: 'running',
    lastProgressAt: time.now - 5,
    lastHeartbeatAt: time.now,
  });
  time.advance(2_000);
  const findings = await agent.tick();
  assert.equal(
    findings.some((row) => row.rule === 'stuck' && row.action === 'escalate'),
    true,
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.reason, STUCK_REASON);
  assert.equal(cards[0]?.workerId, opened.workerId);
  assert.equal(
    agent.escalations[0]?.options.some((option) => option.recommended),
    true,
  );
  assert.match(formatStuckAsk(agent.escalations[0]!), /stuck \(stuck\)/);
});

test('a comment from a login outside allowActors does not spawn', async () => {
  const { agent, judge } = rig({ admission: { allowActors: ['alice'] } });
  const denied = await agent.ingest(
    github(TENANT, 'mallory', 'issue_comment', commentPayload(3, 'please fix this', false, 1)),
  );
  assert.equal(denied.result, 'ignored');
  if (denied.result !== 'ignored') return;
  assert.equal(denied.reason, 'actor_denied');
  assert.equal(judge.calls.length, 0);
  assert.equal(agent.workers(TENANT).length, 0);

  const allowed = await agent.ingest(
    github(TENANT, 'alice-1', 'issues', issuePayload('opened', 3)),
  );
  assert.equal(allowed.result, 'spawned');
});
