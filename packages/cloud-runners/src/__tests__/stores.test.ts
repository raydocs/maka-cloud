import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as runners from '../index.js';
import {
  FixedMachineProvider,
  JsonFileSessionStore,
  MemorySessionStore,
  referencedSnapshotIds,
  type RunnerSessionRecord,
  TenantMachineProvider,
} from '../index.js';
import { collect, setup, terminal } from './harness.js';
import { envModelAccess } from './live-access.js';

const record = (taskId: string, snapshotIds: string[] = []): RunnerSessionRecord => ({
  taskId,
  runner: 'codex',
  tenantId: 'default',
  machineId: 'm_1',
  turns: 1,
  snapshotIds,
  updatedAt: 1,
});

test('memory store hands out copies', async () => {
  const store = new MemorySessionStore();
  await store.put(record('a', ['s1']));
  const got = await store.get('a');
  got?.snapshotIds.push('mutated');
  assert.deepEqual((await store.get('a'))?.snapshotIds, ['s1']);
  await store.delete('a');
  assert.equal(await store.get('a'), undefined);
});

test('file store survives a restart and serializes concurrent writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runners-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'sessions.json');
  const first = new JsonFileSessionStore(path);
  await Promise.all(Array.from({ length: 20 }, (_, i) => first.put(record(`t${i}`, [`s${i}`]))));
  const second = new JsonFileSessionStore(path);
  assert.equal((await second.list()).length, 20);
  assert.deepEqual((await second.get('t7'))?.snapshotIds, ['s7']);
  await second.delete('t7');
  assert.equal(await new JsonFileSessionStore(path).get('t7'), undefined);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).t8.taskId, 't8');
});

test('referenced snapshots are the union over all records', () => {
  assert.deepEqual(
    [...referencedSnapshotIds([record('a', ['s1', 's2']), record('b', ['s2', 's3'])])].sort(),
    ['s1', 's2', 's3'],
  );
});

test('a sandbox is never handed to a tenant it does not belong to', async () => {
  const fixed = new FixedMachineProvider('m_1', 'acme');
  assert.equal((await fixed.acquire({ tenantId: 'acme', taskId: 't' })).machineId, 'm_1');
  await assert.rejects(
    fixed.acquire({ tenantId: 'other', taskId: 't' }),
    /No sandbox is assigned to tenant "other"/,
  );

  const tenants = new TenantMachineProvider({ acme: 'm_1', globex: 'm_2' });
  assert.equal((await tenants.acquire({ tenantId: 'globex', taskId: 't' })).machineId, 'm_2');
  await assert.rejects(
    tenants.acquire({ tenantId: 'initech', taskId: 't' }),
    /No sandbox is assigned/,
  );
  assert.deepEqual(tenants.knownMachines(), ['m_1', 'm_2']);
});

test('a task of another tenant fails instead of running on the shared machine', async (t) => {
  const h = await setup({ cloud: { tenantOf: () => 'initech' } });
  t.after(() => h.cleanup());
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_tenant')));
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  assert.match(
    last?.type === 'failed' ? last.reason : '',
    /No sandbox is assigned to tenant "initech"/,
  );
  assert.equal(await h.cliCalls('claude'), 0);
});

test('the package offers no way to put a vendor key from the environment into a sandbox', async () => {
  assert.equal('envModelAccess' in runners, false, 'the env-key provider is not exported');
  // No production source reads a vendor key from an environment: a run's key comes only from
  // the model access it is given (the gateway's per-run token).
  const src = new URL('../../src/', import.meta.url);
  const sources = (await readdir(src)).filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length > 0);
  for (const name of sources) {
    const text = await readFile(new URL(name, src), 'utf8');
    assert.doesNotMatch(text, /\benv\.(ANTHROPIC|OPENAI)_(API_KEY|BASE_URL)\b/u, name);
  }
});

test("the live smoke test's env-key provider takes keys per vendor, and requires them", async () => {
  const access = envModelAccess({
    ANTHROPIC_API_KEY: 'a',
    ANTHROPIC_BASE_URL: 'https://gw',
    OPENAI_API_KEY: 'o',
  });
  assert.deepEqual(await access.issue({ taskId: 't', runner: 'claude-agent-sdk' }), {
    apiKey: 'a',
    baseUrl: 'https://gw',
  });
  assert.deepEqual(await access.issue({ taskId: 't', runner: 'codex' }), { apiKey: 'o' });
  await assert.rejects(
    envModelAccess({}).issue({ taskId: 't', runner: 'codex' }),
    /OPENAI_API_KEY is not set/,
  );
  await assert.rejects(
    envModelAccess({}).issue({ taskId: 't', runner: 'claude-agent-sdk' }),
    /ANTHROPIC_API_KEY is not set/,
  );
});
