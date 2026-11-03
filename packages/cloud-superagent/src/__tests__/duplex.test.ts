import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DUPLEX_ACK, DuplexLoop, isPreemptEvent, coalesceInbox } from '../index.js';
import { sequentialIds } from '../ids.js';
import { RecordingJudge } from '../router.js';
import { Superagent } from '../runtime.js';
import { FakeSandbox } from '../sandbox.js';
import { MemorySuperagentStore } from '../memory-store.js';
import { commentPayload, github, issuePayload, rig, TENANT } from './harness.js';

async function spin(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for duplex boundary');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('start() returns started and a mid-run comment is applied before the run ends', async () => {
  const sandbox = new FakeSandbox();
  sandbox.holdStarts = true;
  let runEnded = false;
  let appliedBeforeEnd = false;
  const loop = new DuplexLoop({
    async next(ctx) {
      if (ctx.applied.some((event) => event.type === 'issue_comment')) {
        appliedBeforeEnd = !runEnded;
        return { kind: 'done', plan: 'applied comment' };
      }
      if (ctx.jobs.size === 0) return { kind: 'tool', cmd: 'sleep 30' };
      return { kind: 'wait' };
    },
  });
  const { agent } = rig({ handler: loop, sandbox, sandboxRef: 'box' });
  const openedP = agent.ingest(github(TENANT, 'dx1', 'issues', issuePayload('opened', 41)));
  await spin(() => sandbox.jobs.size > 0);
  const started = [...sandbox.jobs.values()][0];
  assert.ok(started);
  assert.equal(started.result, undefined);
  const mid = await agent.ingest(
    github(TENANT, 'dx1c', 'issue_comment', commentPayload(41, 'please use logs', false, 7)),
  );
  assert.equal(mid.result, 'passthrough');
  if (mid.result !== 'passthrough') return;
  const worker = agent.workers(TENANT)[0];
  assert.equal(worker?.progress?.lastActivity, DUPLEX_ACK);
  sandbox.finish(started.jobId);
  const opened = await openedP;
  runEnded = true;
  assert.equal(opened.result, 'spawned');
  assert.equal(appliedBeforeEnd, true);
  assert.equal(
    loop.applied.some((event) => event.eventId === mid.eventId),
    true,
  );
  assert.ok(loop.applied.findIndex((event) => event.type === 'issue_comment') >= 0);
});

test('a cancel message preempts the running loop', async () => {
  const sandbox = new FakeSandbox();
  sandbox.holdStarts = true;
  let doneAfterCancel = 0;
  const loop = new DuplexLoop({
    async next(ctx) {
      if (ctx.applied.some((event) => isPreemptEvent(event))) {
        throw new Error('provider should not run after cancel');
      }
      if (ctx.jobs.size === 0) return { kind: 'tool', cmd: 'sleep 30' };
      return { kind: 'wait' };
    },
  });
  const original = loop.provider.next.bind(loop.provider);
  loop.provider.next = async (ctx) => {
    const step = await original(ctx);
    if (step.kind === 'done') doneAfterCancel += 1;
    return step;
  };
  const { agent } = rig({ handler: loop, sandbox, sandboxRef: 'box' });
  const openedP = agent.ingest(github(TENANT, 'dx2', 'issues', issuePayload('opened', 42)));
  await spin(() => sandbox.jobs.size > 0);
  const mid = await agent.ingest(
    github(TENANT, 'dx2c', 'issue_comment', commentPayload(42, 'cancel', false, 8)),
  );
  assert.equal(mid.result, 'passthrough');
  const opened = await openedP;
  assert.equal(opened.result, 'spawned');
  assert.equal(
    loop.applied.some((event) => event.type === 'issue_comment'),
    true,
  );
  assert.equal(doneAfterCancel, 0);
  assert.match(
    loop.applied.at(-1)?.fields.find(([name]) => name === 'comment')?.[1] ?? '',
    /cancel/i,
  );
});

test('resume does not re-apply a mid-run event that was already consumed', async () => {
  const store = new MemorySuperagentStore();
  const sandbox = new FakeSandbox();
  sandbox.holdStarts = true;
  const loop1 = new DuplexLoop({
    async next(ctx) {
      if (ctx.applied.some((event) => event.type === 'issue_comment')) {
        throw new Error('crash after apply');
      }
      if (ctx.jobs.size === 0) return { kind: 'tool', cmd: 'sleep 30' };
      return { kind: 'wait' };
    },
  });
  const agent1 = new Superagent({
    store,
    handler: loop1,
    sandbox,
    sandboxRef: 'box',
    judge: new RecordingJudge(),
    ids: sequentialIds(),
  });
  const openedP = agent1.ingest(github(TENANT, 'dx3', 'issues', issuePayload('opened', 43)));
  await spin(() => sandbox.jobs.size > 0);
  const mid = await agent1.ingest(
    github(TENANT, 'dx3c', 'issue_comment', commentPayload(43, 'use a lock', false, 9)),
  );
  assert.equal(mid.result, 'passthrough');
  if (mid.result !== 'passthrough') return;
  await openedP;
  const worker = agent1.workers(TENANT)[0];
  assert.ok(worker);
  assert.equal(worker.state, 'crashed');
  const commentId = loop1.applied.find((event) => event.eventId === mid.eventId)?.eventId;
  assert.equal(commentId, mid.eventId);
  assert.equal(worker.seenEventIds?.includes(mid.eventId), true);

  store.putWorker({ ...worker, state: 'running' });
  const loop2 = new DuplexLoop({
    async next() {
      return { kind: 'done', plan: 'resumed' };
    },
  });
  const agent2 = new Superagent({
    store,
    handler: loop2,
    judge: new RecordingJudge(),
    ids: sequentialIds(200),
  });
  await agent2.restore();
  assert.equal(loop2.applied.filter((event) => event.eventId === mid.eventId).length, 0);
});

test('coalesceInbox lets a cancel preempt an approval', () => {
  const base = {
    tenantId: TENANT,
    source: 'internal' as const,
    subject: { kind: 'issue' as const, tenantId: TENANT, key: 'k' },
    actor: { login: 'owner', kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: '',
    fields: [] as Array<[string, string]>,
    closesSubject: false,
  };
  const approval = {
    ...base,
    eventId: 'evt_a',
    type: 'approval_granted',
    idempotencyKey: 'a',
  };
  const cancel = {
    ...base,
    eventId: 'evt_c',
    type: 'user_cancel',
    idempotencyKey: 'c',
    fields: [['text', 'cancel']] as Array<[string, string]>,
  };
  assert.equal(coalesceInbox([approval, cancel]).eventId, 'evt_c');
});
