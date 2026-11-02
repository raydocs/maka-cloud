import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BOX_NPM_CACHE,
  BOX_TIMING_WORKERS,
  BoxCapError,
  BoxPool,
  evaluateTenantBox,
  leaseHolder,
} from '../box-pool.js';
import { MemorySuperagentStore } from '../memory-store.js';
import { FakeSandbox } from '../sandbox.js';
import { openSuperagentDatabase, SqliteSuperagentStore } from '../sqlite-store.js';
import {
  DEFAULT_BOX_DELETE_AFTER_SECONDS,
  DEFAULT_SHARED_BOX,
  DEFAULT_WORKERS_PER_BOX,
  actMandate,
} from '../types.js';
import { initLocalRepo } from '../workspace.js';
import { clock, commentPayload, github, issuePayload, REPO, rig, TENANT } from './harness.js';

const TENANT_B = 'inv_other';

async function repo(): Promise<string> {
  return initLocalRepo({
    'readme.md': 'base\n',
    'package.json': '{"name":"loop"}\n',
  });
}

test('concurrent workers share one box, worktrees, and cannot read each other', async () => {
  const source = await repo();
  const sandbox = new FakeSandbox();
  const store = new MemorySuperagentStore();
  const pool = new BoxPool({ sandbox, store, idleMs: 60_000 });
  const first = await pool.acquire({
    tenantId: TENANT,
    workerId: 'wrk_a',
    repoUrl: source,
    mandate: { ...actMandate([REPO]), box: DEFAULT_SHARED_BOX },
  });
  const second = await pool.acquire({ tenantId: TENANT, workerId: 'wrk_b', repoUrl: source });
  assert.equal(second.boxId, first.boxId);
  assert.equal(first.created, true);
  assert.equal(store.tenantBox(TENANT)?.activeWorkers.length, 2);
  assert.equal(store.tenantBox(TENANT)?.deleteAfterSeconds, DEFAULT_BOX_DELETE_AFTER_SECONDS);
  assert.equal(store.tenantBox(TENANT)?.vcpus, 4);
  assert.equal(store.tenantBox(TENANT)?.memMiB, 8192);

  const wroteA = await pool.exec(TENANT, 'wrk_a', { cmd: 'echo secret-a > secret.txt' });
  const wroteB = await pool.exec(TENANT, 'wrk_b', { cmd: 'echo secret-b > secret.txt' });
  assert.equal(wroteA.exitCode, 0, wroteA.stderr);
  assert.equal(wroteB.exitCode, 0, wroteB.stderr);
  const readA = await pool.exec(TENANT, 'wrk_a', { cmd: 'cat secret.txt' });
  const readB = await pool.exec(TENANT, 'wrk_b', { cmd: 'cat secret.txt' });
  assert.match(readA.stdout, /secret-a/);
  assert.match(readB.stdout, /secret-b/);
  const cross = await pool.exec(TENANT, 'wrk_b', { cmd: 'cat ../wrk_a/secret.txt' });
  assert.equal(cross.exitCode, 1);
  assert.match(cross.stderr, /refused/);

  const root = sandbox.roots.get(first.boxId);
  assert.ok(root);
  assert.equal(await readFile(join(root, 'work/wrk_a/secret.txt'), 'utf8'), 'secret-a\n');
  assert.equal(await readFile(join(root, 'work/wrk_b/secret.txt'), 'utf8'), 'secret-b\n');
  assert.ok(sandbox.leases.has(`${first.boxId}:${leaseHolder(TENANT)}`));
  assert.ok(
    sandbox.commands.some((row) => row.cmd.includes('worktree add')),
    'workers are cut from the cached base clone',
  );
  assert.ok(sandbox.commands.some((row) => row.cmd.includes(BOX_NPM_CACHE)));
  assert.equal(
    store.usageEvents(TENANT).some((row) => row.workerId === BOX_TIMING_WORKERS.create),
    true,
  );
});

test('idle drop of the lease suspends; the next event wakes and records the time', async () => {
  const source = await repo();
  const sandbox = new FakeSandbox();
  const store = new MemorySuperagentStore();
  const time = clock();
  const spoken: Array<{ workerId: string; phase?: string; activity?: string }> = [];
  const pool = new BoxPool({
    sandbox,
    store,
    now: time.read,
    idleMs: 5_000,
    reportProgress: async (_tenant, workerId, patch) => {
      spoken.push({ workerId, phase: patch.phase, activity: patch.activity });
    },
  });
  const slot = await pool.acquire({ tenantId: TENANT, workerId: 'wrk_wake', repoUrl: source });
  await pool.release(TENANT, 'wrk_wake');
  assert.equal(sandbox.leases.size, 0);
  assert.equal(store.tenantBox(TENANT)?.idleSince, time.now);
  assert.equal((await sandbox.getMachine(slot.boxId)).state, 'running');

  time.advance(4_999);
  await pool.tick();
  assert.equal((await sandbox.getMachine(slot.boxId)).state, 'running');

  time.advance(2);
  await pool.tick();
  assert.equal((await sandbox.getMachine(slot.boxId)).state, 'suspended');
  assert.equal(store.tenantBox(TENANT)?.state, 'suspended');
  assert.ok(store.tenantBox(TENANT)?.lastSuspendAt);

  const woke = await pool.wake(TENANT, 'wrk_wake');
  assert.equal(woke.boxId, slot.boxId);
  assert.equal(woke.woke, true);
  assert.equal((await sandbox.getMachine(slot.boxId)).state, 'running');
  assert.equal(
    store.usageEvents(TENANT).some((row) => row.workerId === BOX_TIMING_WORKERS.wake && row.wallMs >= 0),
    true,
  );
  assert.ok(spoken.some((row) => row.phase === 'waking' && /woke in/.test(row.activity ?? '')));
});

test('a gone box rebuilds from the base snapshot and records restore time', async () => {
  const source = await repo();
  const sandbox = new FakeSandbox();
  const store = new MemorySuperagentStore();
  const pool = new BoxPool({ sandbox, store });
  const first = await pool.acquire({ tenantId: TENANT, workerId: 'wrk_r', repoUrl: source });
  await pool.exec(TENANT, 'wrk_r', { cmd: 'echo from-base > stamp.txt' });
  const snap = store.tenantBox(TENANT)?.snapshotId;
  assert.ok(snap);
  await pool.release(TENANT, 'wrk_r');
  sandbox.gone(first.boxId);
  assert.equal((await sandbox.getMachine(first.boxId)).state, 'unknown');

  const rebuilt = await pool.acquire({ tenantId: TENANT, workerId: 'wrk_r2', repoUrl: source });
  assert.notEqual(rebuilt.boxId, first.boxId);
  assert.equal(rebuilt.restored, true);
  assert.equal(store.tenantBox(TENANT)?.snapshotId, snap);
  assert.equal(
    store.usageEvents(TENANT).some((row) => row.workerId === BOX_TIMING_WORKERS.restore),
    true,
  );
  const stamp = await sandbox.exec(rebuilt.boxId, {
    cmd: 'test -f work/.base/.installed && echo yes',
  });
  assert.match(stamp.stdout, /yes/);
});

test('a fifth concurrent worker is refused; spend admission is unchanged', async () => {
  const sandbox = new FakeSandbox();
  const store = new MemorySuperagentStore();
  const pool = new BoxPool({ sandbox, store, maxWorkers: DEFAULT_WORKERS_PER_BOX });
  for (let i = 0; i < 4; i += 1) {
    await pool.acquire({ tenantId: TENANT, workerId: `wrk_${i}` });
  }
  await assert.rejects(
    () => pool.acquire({ tenantId: TENANT, workerId: 'wrk_5' }),
    (error: unknown) => error instanceof BoxCapError,
  );
});

test('watchdog treats a stuck suspend/resume or a leftover lease as box_stuck', () => {
  const at = 1_000_000;
  const base = {
    tenantId: TENANT,
    boxId: 'box_1',
    snapshotId: null,
    vcpus: 4,
    memMiB: 8192,
    activeWorkers: [] as string[],
    idleSince: at,
    lastWakeAt: null,
    lastSuspendAt: null,
    lastCreateAt: at,
    lastRestoreAt: null,
    leaseHolder: null as string | null,
    leaseRenewedAt: null as number | null,
    deleteAfterSeconds: DEFAULT_BOX_DELETE_AFTER_SECONDS,
    createdAt: at,
    updatedAt: at,
  };
  const suspending = evaluateTenantBox(
    { ...base, state: 'suspending', updatedAt: at - 11 * 60_000 },
    at,
  );
  assert.equal(suspending?.rule, 'box_stuck');
  assert.match(suspending?.detail ?? '', /suspending/);
  const lease = evaluateTenantBox(
    {
      ...base,
      state: 'running',
      leaseHolder: leaseHolder(TENANT),
      leaseRenewedAt: at - 120_000,
    },
    at,
  );
  assert.equal(lease?.rule, 'box_stuck');
  assert.match(lease?.detail ?? '', /lease/);
});

test('tenant box JSON survives a sqlite reopen with no schema bump', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-box-db-'));
  const path = join(dir, 'superagent.db');
  const first = SqliteSuperagentStore.open(path);
  const sandbox = new FakeSandbox();
  const pool = new BoxPool({ sandbox, store: first });
  await pool.acquire({ tenantId: TENANT, workerId: 'wrk_db' });
  const saved = first.tenantBox(TENANT);
  assert.ok(saved);
  first.close();

  const db = openSuperagentDatabase(path);
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(version, 2);
  db.close();
  const second = SqliteSuperagentStore.open(path);
  const loaded = second.tenantBox(TENANT);
  assert.ok(loaded);
  assert.equal(loaded.boxId, saved.boxId);
  assert.equal(loaded.vcpus, 4);
  second.close();
});

test('Superagent sharedBox: two workers one box; idle suspend; wake on the next event', async () => {
  const sandbox = new FakeSandbox();
  const time = clock();
  const store = new MemorySuperagentStore();
  const pool = new BoxPool({ sandbox, store, now: time.read, idleMs: 1_000 });
  const { agent } = rig({
    store,
    sandbox,
    sharedBox: true,
    boxPool: pool,
    clock: time.read,
    admission: { maxWorkersPerBox: 4 },
  });
  const first = await agent.ingest(github(TENANT, 's1', 'issues', issuePayload('opened', 40)));
  const second = await agent.ingest(github(TENANT, 's2', 'issues', issuePayload('opened', 41)));
  assert.equal(first.result, 'spawned');
  assert.equal(second.result, 'spawned');
  if (first.result !== 'spawned' || second.result !== 'spawned') return;
  const left = agent.worker(TENANT, first.workerId);
  const right = agent.worker(TENANT, second.workerId);
  assert.ok(left?.sandboxRef);
  assert.equal(left.sandboxRef, right?.sandboxRef);
  assert.equal(store.allTenantBoxes().length, 1);

  const third = await agent.ingest(
    github(TENANT_B, 's3', 'issues', issuePayload('opened', 42)),
  );
  assert.equal(third.result, 'spawned');

  time.advance(1_001);
  await agent.tick();
  const boxId = left.sandboxRef;
  assert.equal((await sandbox.getMachine(boxId)).state, 'suspended');

  await agent.ingest(github(TENANT, 's1c', 'issue_comment', commentPayload(40, 'go on', false, 8)));
  assert.equal((await sandbox.getMachine(boxId)).state, 'running');
  const after = agent.worker(TENANT, first.workerId);
  assert.equal(after?.progress?.phase === 'waking' || /woke|waking/.test(after?.progress?.lastActivity ?? ''), true);
});

test('sharedBox spawn admission caps workers on the tenant box, not a 30-minute kill', async () => {
  const { agent } = rig({
    sharedBox: true,
    admission: { maxWorkersPerBox: 1, spendCapUsd: 50 },
  });
  const first = await agent.ingest(github(TENANT, 'c1', 'issues', issuePayload('opened', 50)));
  assert.equal(first.result, 'spawned');
  const second = await agent.ingest(github(TENANT, 'c2', 'issues', issuePayload('opened', 51)));
  assert.equal(second.result, 'ignored');
  if (second.result !== 'ignored') return;
  assert.equal(second.reason, 'worker_cap');
});
