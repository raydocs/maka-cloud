import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InstaboxClient } from '../client.js';
import { InstaboxApiError, isQuotaExceeded } from '../errors.js';

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | 'drop';

/** A client whose fetch is a script: each call takes the next reply and is recorded. */
function scripted(replies: Reply[]): { client: InstaboxClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    seen.push({
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('no scripted reply left');
    if (reply === 'drop') throw new TypeError('connection reset');
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as typeof fetch;
  const client = new InstaboxClient({
    apiKey: 'ibk_test',
    baseUrl: 'http://instabox.test',
    fetch: fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });
  return { client, seen };
}

const operation = (type: string, machineId = 'm_1') => ({
  status: 202,
  body: { id: 'op_1', machineId, type, state: 'queued', error: null },
});

describe('InstaboxClient box lifecycle calls', () => {
  it('creates a sandbox from a snapshot with labels, under a key the caller saved first', async () => {
    const { client, seen } = scripted([operation('create')]);
    const op = await client.createMachine(
      { name: 'mk-abc-0', snapshotId: 'sn_1', metadata: { 'maka.invite': 'inv_abc' } },
      { idempotencyKey: 'maka-box-inv_abc-0-1' },
    );
    assert.equal(op.machineId, 'm_1');
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.url.pathname, '/v1/machines');
    assert.equal(seen[0]?.headers['Idempotency-Key'], 'maka-box-inv_abc-0-1');
    assert.deepEqual(seen[0]?.body, {
      name: 'mk-abc-0',
      snapshotId: 'sn_1',
      metadata: { 'maka.invite': 'inv_abc' },
    });
  });

  it('sends one key on every transport retry of a create, so a dropped answer makes one sandbox', async () => {
    const { client, seen } = scripted(['drop', operation('create')]);
    await client.createMachine({ templateId: 't_node' });
    assert.equal(seen.length, 2);
    const keys = seen.map((s) => s.headers['Idempotency-Key']);
    assert.ok(keys[0] && keys[0] === keys[1]);
  });

  it('uses a fresh key for each separate create', async () => {
    const { client, seen } = scripted([operation('create'), operation('create')]);
    await client.createMachine({ templateId: 't_node' });
    await client.createMachine({ templateId: 't_node' });
    assert.notEqual(seen[0]?.headers['Idempotency-Key'], seen[1]?.headers['Idempotency-Key']);
  });

  it('refuses a create that names both a template and a snapshot, or neither, before any request', async () => {
    const { client, seen } = scripted([]);
    await assert.rejects(client.createMachine({ templateId: 't', snapshotId: 's' }), /exactly one/);
    await assert.rejects(client.createMachine({ name: 'x' }), /exactly one/);
    assert.equal(seen.length, 0);
  });

  it('reports the account limit as quota_exceeded and does not retry it', async () => {
    const { client, seen } = scripted([
      {
        status: 429,
        body: {
          error: {
            code: 'quota_exceeded',
            message: 'sandbox limit of 5 reached',
            retryable: false,
          },
        },
      },
    ]);
    await assert.rejects(client.createMachine({ templateId: 't_node' }), (error: unknown) => {
      assert.ok(error instanceof InstaboxApiError);
      assert.ok(isQuotaExceeded(error));
      return true;
    });
    assert.equal(seen.length, 1);
    assert.equal(isQuotaExceeded(new Error('quota_exceeded')), false);
    assert.equal(
      isQuotaExceeded(new InstaboxApiError(429, { code: 'rate_limited', message: 'slow down' })),
      false,
    );
  });

  it('lists by every label as repeated metadata terms and follows the cursor', async () => {
    const { client, seen } = scripted([
      { body: { machines: [{ id: 'm_1', state: 'running' }], nextCursor: 'c2' } },
      { body: { machines: [{ id: 'm_2', state: 'suspended' }], nextCursor: null } },
    ]);
    const machines = await client.listMachines({
      metadata: { 'maka.pool': '1', 'maka.invite': 'inv_abc' },
    });
    assert.deepEqual(
      machines.map((m) => m.id),
      ['m_1', 'm_2'],
    );
    assert.deepEqual(seen[0]?.url.searchParams.getAll('metadata'), [
      'maka.pool:1',
      'maka.invite:inv_abc',
    ]);
    assert.equal(seen[0]?.url.searchParams.get('cursor'), null);
    assert.equal(seen[1]?.url.searchParams.get('cursor'), 'c2');
    assert.deepEqual(seen[1]?.url.searchParams.getAll('metadata'), [
      'maka.pool:1',
      'maka.invite:inv_abc',
    ]);
  });

  it('replaces the labels with a patch', async () => {
    const { client, seen } = scripted([{ body: { id: 'm_1', state: 'running' } }]);
    await client.patchMachineMetadata('m_1', { 'maka.task': 'task_9' });
    assert.equal(seen[0]?.method, 'PATCH');
    assert.equal(seen[0]?.url.pathname, '/v1/machines/m_1');
    assert.deepEqual(seen[0]?.body, { metadata: { 'maka.task': 'task_9' } });
  });

  it('suspends and deletes with an Idempotency-Key', async () => {
    const { client, seen } = scripted([operation('suspend'), operation('delete')]);
    await client.suspendMachine('m_1');
    await client.deleteMachine('m_1');
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.url.pathname, '/v1/machines/m_1/suspend');
    assert.equal(seen[1]?.method, 'DELETE');
    assert.equal(seen[1]?.url.pathname, '/v1/machines/m_1');
    for (const call of seen) assert.ok(call.headers['Idempotency-Key']);
  });

  it('lists snapshots', async () => {
    const { client, seen } = scripted([
      { body: { snapshots: [{ id: 'sn_1', name: 'mk-a-b', status: 'ready' }] } },
    ]);
    const snapshots = await client.listSnapshots();
    assert.equal(seen[0]?.url.pathname, '/v1/snapshots');
    assert.deepEqual(
      snapshots.map((s) => s.name),
      ['mk-a-b'],
    );
  });
});
