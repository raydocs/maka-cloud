import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { formatEvidence } from '../evidence.js';
import { UnconfiguredOrgSecrets } from '../secrets.js';
import { openSuperagentDatabase, SqliteSuperagentStore } from '../sqlite-store.js';
import { github, issuePayload, rig, TENANT } from './harness.js';

test('usage deltas append to a per-tenant ledger and tenant B cannot read them', async () => {
  const { agent, handler } = rig();
  handler.script = () => ({
    usage: { tokens: 10, usdMicros: 100, wallMs: 5 },
    evidence: [{ kind: 'step', label: 'ran tests', body: 'ok' }],
    progress: true,
  });
  const opened = await agent.ingest(github(TENANT, 'led1', 'issues', issuePayload('opened', 3)));
  assert.equal(opened.result, 'spawned');
  const ledger = agent.ledger(TENANT);
  assert.equal(ledger.tokens, 10);
  assert.equal(ledger.usdMicros, 100);
  assert.equal(ledger.events, 1);
  assert.deepEqual(agent.ledger('inv_other'), {
    tenantId: 'inv_other',
    tokens: 0,
    usdMicros: 0,
    wallMs: 0,
    events: 0,
  });
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.evidence[0]?.kind, 'step');
  assert.match(formatEvidence(worker?.evidence ?? []), /### Evidence/u);
});

test('Org Secrets stay an interface: the stub never returns a raw value', async () => {
  const secrets = new UnconfiguredOrgSecrets();
  assert.equal(await secrets.has({ tenantId: TENANT, name: 'GH_TOKEN' }), false);
  const injected = await secrets.inject(
    { tenantId: TENANT, name: 'GH_TOKEN' },
    { kind: 'env', name: 'GITHUB_TOKEN' },
  );
  assert.deepEqual(injected, { ok: false, reason: 'unavailable' });
  assert.equal(JSON.stringify(injected).includes('sk-'), false);
});

test('sqlite v1 gains usage_events in place; not a cloud-server migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-ledger-'));
  const path = join(dir, 'superagent.db');
  const old = new DatabaseSync(path);
  old.exec('PRAGMA user_version = 1');
  old.exec(`
    CREATE TABLE events (event_id TEXT PRIMARY KEY, tenant_id TEXT, idempotency_key TEXT, subject_key TEXT, source TEXT, type TEXT, occurred_at INTEGER, received_at INTEGER, json TEXT);
    CREATE TABLE workers (worker_id TEXT PRIMARY KEY, tenant_id TEXT, subject_key TEXT, state TEXT, generation INTEGER, json TEXT, created_at INTEGER, updated_at INTEGER, retired_at INTEGER);
    CREATE TABLE subscriptions (subscription_id TEXT PRIMARY KEY, tenant_id TEXT, subject_key TEXT, worker_id TEXT, created_at INTEGER, retired_at INTEGER);
    CREATE TABLE inbox (worker_id TEXT, seq INTEGER, event_id TEXT, delivered_at INTEGER, consumed_at INTEGER, PRIMARY KEY (worker_id, seq));
    CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, tenant_id TEXT, worker_id TEXT, kind TEXT, bound_text TEXT, state TEXT, created_at INTEGER, expires_at INTEGER, decided_at INTEGER);
    CREATE TABLE audit (audit_id TEXT PRIMARY KEY, tenant_id TEXT, worker_id TEXT, kind TEXT, at INTEGER, json TEXT);
    CREATE TABLE usage (tenant_id TEXT, worker_id TEXT, tokens INTEGER, usd_micros INTEGER, wall_ms INTEGER, updated_at INTEGER, PRIMARY KEY (tenant_id, worker_id));
  `);
  old.close();
  const db = openSuperagentDatabase(path);
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  assert.equal(version, 2);
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'`)
    .get() as { name: string } | undefined;
  assert.equal(tables?.name, 'usage_events');
  db.close();
  const store = SqliteSuperagentStore.open(path);
  store.appendUsageEvent({
    tenantId: TENANT,
    workerId: 'wrk_1',
    tokens: 3,
    usdMicros: 7,
    wallMs: 1,
    at: 9,
  });
  assert.equal(store.tenantUsage(TENANT).tokens, 3);
  store.close();
  const reopened = SqliteSuperagentStore.open(path);
  assert.equal(reopened.tenantUsage(TENANT).tokens, 3);
  assert.equal(reopened.tenantUsage(TENANT).events, 1);
  reopened.close();
  await rm(dir, { recursive: true, force: true });
});
