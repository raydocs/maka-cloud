import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeSandbox } from '../sandbox.js';
import {
  compareTasks,
  DEFAULT_AGE_EVERY_MS,
  effectiveRank,
  footprintsOverlap,
  pathOverlaps,
} from '../scheduler.js';
import { SqliteSuperagentStore } from '../sqlite-store.js';
import { actMandate } from '../types.js';
import { github, issuePayload, REPO, rig, TENANT } from './harness.js';

test('fair order is reserved, then effective priority, then age', () => {
  const now = 100_000;
  const low = {
    reserved: false,
    priority: 'low' as const,
    queuedAt: 0,
  };
  const high = {
    reserved: false,
    priority: 'high' as const,
    queuedAt: 1,
  };
  const aged = {
    reserved: false,
    priority: 'low' as const,
    queuedAt: 0,
  };
  assert.ok(compareTasks({ ...high, taskId: 'h' } as never, { ...low, taskId: 'l' } as never, now, DEFAULT_AGE_EVERY_MS) < 0);
  assert.equal(effectiveRank(aged, now, 10_000), 3);
  assert.equal(effectiveRank(high, now, 10_000), 3);
});

test('footprints on the same repo overlap by prefix and glob', () => {
  assert.equal(pathOverlaps('src/auth.ts', 'src/auth.ts'), true);
  assert.equal(pathOverlaps('src/', 'src/auth.ts'), true);
  assert.equal(pathOverlaps('src/**', 'src/a/b.ts'), true);
  assert.equal(footprintsOverlap(['src/a.ts'], ['docs/a.md']), false);
  assert.equal(footprintsOverlap([], ['src/a.ts']), false);
});

test('file-footprint conflict serializes; the waiter starts after the first task is done', async () => {
  const { agent } = rig({
    sandbox: new FakeSandbox(),
    scheduler: { maxWorkers: 2 },
  });
  const first = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#1', repo: REPO, number: 1 },
    title: 'edit auth',
    mandate: actMandate([REPO]),
    footprint: ['src/auth.ts'],
    priority: 'high',
  });
  assert.equal(first.state, 'running');
  const second = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#2', repo: REPO, number: 2 },
    title: 'also auth',
    mandate: actMandate([REPO]),
    footprint: ['src/auth.ts'],
    priority: 'high',
  });
  assert.equal(second.state, 'blocked');
  assert.equal(second.reason, 'footprint');
  if (!first.workerId) throw new Error('expected worker');
  const worker = agent.worker(TENANT, first.workerId);
  assert.ok(worker);
  await agent.store.putWorker({ ...worker, state: 'retired', retiredAt: 1, updatedAt: 1 });
  agent.scheduler.markDone(TENANT, first.workerId);
  await agent.admitQueued(TENANT);
  assert.equal(agent.scheduler.task(TENANT, second.taskId)?.state, 'running');
});

test('dependencies and start conditions wait until the world is true', async () => {
  const { agent, time } = rig({ sandbox: new FakeSandbox(), scheduler: { maxWorkers: 4 } });
  const blocked = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#9', repo: REPO, number: 9 },
    title: 'after merge',
    mandate: actMandate([REPO]),
    start: { kind: 'pr_merged', repo: REPO, number: 12 },
    dependencies: [{ kind: 'ci_green', repo: REPO, number: 12 }],
  });
  assert.equal(blocked.state, 'waiting');
  assert.match(blocked.reason ?? '', /start_pr_merged|dep_ci_green/);
  assert.ok((agent.statusSnapshot(TENANT).queue ?? []).some((row) => row.taskId === blocked.taskId));

  agent.scheduler.noteEvent({
    eventId: 'e-merge',
    tenantId: TENANT,
    source: 'github',
    type: 'pr_closed',
    subject: { kind: 'pull_request', tenantId: TENANT, key: 'pr:inv_test:acme/app#12', repo: REPO, number: 12 },
    idempotencyKey: 'm',
    actor: { login: 'alice', kind: 'user' },
    occurredAt: time.now,
    receivedAt: time.now,
    summary: 'merged',
    fields: [['merged', 'true']],
    closesSubject: true,
  });
  agent.scheduler.noteEvent({
    eventId: 'e-ci',
    tenantId: TENANT,
    source: 'github',
    type: 'ci_passed',
    subject: { kind: 'pull_request', tenantId: TENANT, key: 'pr:inv_test:acme/app#12', repo: REPO, number: 12 },
    idempotencyKey: 'c',
    actor: { login: 'bot', kind: 'bot' },
    occurredAt: time.now,
    receivedAt: time.now,
    summary: 'ci',
    fields: [['sha', 'abc']],
    closesSubject: false,
  });
  await agent.admitQueued(TENANT);
  assert.equal(agent.scheduler.task(TENANT, blocked.taskId)?.state, 'running');
});

test('a time start condition waits, then admits on tick', async () => {
  const { agent, time } = rig({ sandbox: new FakeSandbox() });
  const later = time.now + 60_000;
  const task = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#3', repo: REPO, number: 3 },
    title: 'cron',
    mandate: actMandate([REPO]),
    start: { kind: 'time', at: later },
    priority: 'low',
  });
  assert.equal(task.state, 'waiting');
  assert.equal(task.reason, 'start_time');
  time.advance(60_000);
  await agent.tick();
  assert.equal(agent.scheduler.task(TENANT, task.taskId)?.state, 'running');
});

test('human reserved slot is not taken by background work', async () => {
  const { agent } = rig({ sandbox: new FakeSandbox(), scheduler: { maxWorkers: 2, reservedHumanSlots: 1 } });
  const a = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#10', repo: REPO, number: 10 },
    title: 'bg-1',
    mandate: actMandate([REPO]),
    reserved: false,
    priority: 'normal',
  });
  const b = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#11', repo: REPO, number: 11 },
    title: 'bg-2',
    mandate: actMandate([REPO]),
    reserved: false,
    priority: 'normal',
  });
  assert.equal(a.state, 'running');
  assert.equal(b.state, 'running');
  const human = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'conversation', tenantId: TENANT, key: 'chat:inv_test:c1', conversationId: 'c1' },
    title: 'user reply',
    mandate: actMandate([REPO]),
    reserved: true,
    priority: 'urgent',
  });
  assert.equal(human.state, 'queued');
  assert.equal(human.reason, 'slot');
  if (!b.workerId) throw new Error('worker');
  agent.scheduler.markDone(TENANT, b.workerId);
  const worker = agent.worker(TENANT, b.workerId);
  if (worker) agent.store.putWorker({ ...worker, state: 'retired', retiredAt: 1, updatedAt: 1 });
  await agent.admitQueued(TENANT);
  assert.equal(agent.scheduler.task(TENANT, human.taskId)?.state, 'running');
});

test('daily budget exhaustion blocks a larger task', async () => {
  const { agent } = rig({
    sandbox: new FakeSandbox(),
    scheduler: { maxWorkers: 2, budget: { tokensPerDay: 60_000 } },
  });
  const first = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#20', repo: REPO, number: 20 },
    title: 'small',
    mandate: actMandate([REPO]),
    size: 'S',
    priority: 'high',
  });
  assert.equal(first.state, 'running');
  const hungry = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#21', repo: REPO, number: 21 },
    title: 'large',
    mandate: actMandate([REPO]),
    size: 'L',
    priority: 'urgent',
  });
  assert.equal(hungry.state, 'blocked');
  assert.equal(hungry.reason, 'budget_daily');
});

test('aging promotes a low task ahead of a later high task', async () => {
  const { agent, time } = rig({
    sandbox: new FakeSandbox(),
    scheduler: { maxWorkers: 1, ageEveryMs: 1_000 },
  });
  const first = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#22', repo: REPO, number: 22 },
    title: 'holder',
    mandate: actMandate([REPO]),
    size: 'S',
    priority: 'high',
  });
  const low = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#23', repo: REPO, number: 23 },
    title: 'low',
    mandate: actMandate([REPO]),
    size: 'S',
    priority: 'low',
  });
  time.advance(1);
  const high = await agent.enqueueTask({
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:inv_test:acme/app#24', repo: REPO, number: 24 },
    title: 'high waiter',
    mandate: actMandate([REPO]),
    size: 'S',
    priority: 'high',
  });
  assert.equal(low.state, 'queued');
  assert.equal(high.state, 'queued');
  if (!first.workerId) throw new Error('worker');
  agent.scheduler.markDone(TENANT, first.workerId);
  const live = agent.worker(TENANT, first.workerId);
  if (live) agent.store.putWorker({ ...live, state: 'retired', retiredAt: 1, updatedAt: 1 });
  time.advance(4_000);
  await agent.admitQueued(TENANT);
  assert.equal(agent.scheduler.task(TENANT, low.taskId)?.state, 'running');
  assert.notEqual(agent.scheduler.task(TENANT, high.taskId)?.state, 'running');
});

test('scheduler JSON survives a sqlite reopen with no user_version bump', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-sched-'));
  const path = join(dir, 'superagent.db');
  const store1 = SqliteSuperagentStore.open(path);
  const first = rig({ store: store1, sandbox: new FakeSandbox(), scheduler: { maxWorkers: 1 } });
  await first.agent.ingest(github(TENANT, 'one', 'issues', issuePayload('opened', 1)));
  await first.agent.ingest(github(TENANT, 'two', 'issues', issuePayload('opened', 2)));
  const queued = first.agent.queueOf(TENANT).filter((row) => row.state !== 'running' && row.state !== 'done');
  assert.ok(queued.length >= 1);
  store1.close();

  const store2 = SqliteSuperagentStore.open(path);
  const second = rig({ store: store2, sandbox: new FakeSandbox(), scheduler: { maxWorkers: 1 } });
  assert.ok(second.agent.queueOf(TENANT).length >= 1);
  assert.equal(
    second.store.getDocument(TENANT, 'scheduler') === undefined,
    false,
  );
  store2.close();
  await rm(dir, { recursive: true, force: true });
});

test('ledger and progress show queued reason and wait time', async () => {
  const { agent } = rig({
    sandbox: new FakeSandbox(),
    sandboxRef: 'box-1',
    admission: { maxBoxes: 1 },
  });
  const first = await agent.ingest(github(TENANT, 'q1', 'issues', issuePayload('opened', 50)));
  assert.equal(first.result, 'spawned');
  const second = await agent.ingest(github(TENANT, 'q2', 'issues', issuePayload('opened', 51)));
  assert.equal(second.result, 'queued');
  if (second.result !== 'queued') return;
  const snap = agent.statusSnapshot(TENANT);
  const row = snap.queue?.find((item) => item.taskId === second.taskId);
  assert.ok(row);
  assert.equal(row?.reason, 'box_cap');
  assert.ok((row?.waitMs ?? -1) >= 0);
  const kinds = agent.store.audit(TENANT).map((item) => item.kind);
  assert.ok(kinds.includes('scheduler_queued'));
  assert.ok(kinds.includes('scheduler_admitted') || kinds.includes('spawned'));
});
