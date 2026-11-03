import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  formatLiveSmokeReport,
  LIVE_SMOKE_CMD,
  redactSecret,
  runLiveSmoke,
} from '../live-smoke.js';
import {
  DEFAULT_LIVE_SMOKE_TEMPLATE,
  InstaboxCredentialsError,
  instaboxApiFromEnv,
  instaboxCreateSourceFromEnv,
  SMALLEST_SANDBOX,
} from '../sandbox.js';

const KEY = 'ibx-live-secret-do-not-print';

interface Recorded {
  method: string;
  path: string;
  query: string;
  apiKey: string | undefined;
  confirmDelete: string | undefined;
  body: unknown;
}

async function mockInstabox(
  routes: Record<string, (req: Recorded) => { status?: number; body?: unknown }>,
) {
  const requests: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      const q = url.indexOf('?');
      const recorded: Recorded = {
        method: req.method ?? '',
        path: q === -1 ? url : url.slice(0, q),
        query: q === -1 ? '' : url.slice(q + 1),
        apiKey: header(req, 'x-api-key'),
        confirmDelete: header(req, 'x-confirm-delete'),
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(recorded);
      const key = `${recorded.method} ${recorded.path}`;
      const reply = routes[key] ?? routes['*'];
      if (!reply) {
        res.writeHead(404).end('missing route');
        return;
      }
      const answer = reply(recorded);
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

test('live-smoke refuses to start without a key and never fetches', async () => {
  let fetched = false;
  const fetchImpl: typeof fetch = async () => {
    fetched = true;
    return new Response('no');
  };
  await assert.rejects(
    () => runLiveSmoke({ env: {}, fetch: fetchImpl }),
    (error: unknown) =>
      error instanceof InstaboxCredentialsError && /INSTABOX_API_KEY/.test(error.message),
  );
  assert.equal(fetched, false);
  assert.throws(() => instaboxApiFromEnv({}), InstaboxCredentialsError);
  assert.deepEqual(instaboxCreateSourceFromEnv({}), { templateId: DEFAULT_LIVE_SMOKE_TEMPLATE });
  assert.deepEqual(instaboxCreateSourceFromEnv({ INSTABOX_TEMPLATE_ID: 'herdr' }), {
    templateId: 'herdr',
  });
  assert.deepEqual(instaboxCreateSourceFromEnv({ INSTABOX_SNAPSHOT_ID: 'snap_1' }), {
    snapshotId: 'snap_1',
  });
  assert.throws(
    () =>
      instaboxCreateSourceFromEnv({
        INSTABOX_TEMPLATE_ID: 'universal',
        INSTABOX_SNAPSHOT_ID: 'snap_1',
      }),
    /only one/,
  );
});

test('live-smoke defaults to universal and Instabox Pro smallest 2/4096', async () => {
  const fake = await mockInstabox({
    'POST /v1/machines': () => ({
      body: { id: 'op_c', machineId: 'mch_default', type: 'create', state: 'succeeded' },
    }),
    'GET /v1/machines/mch_default': () => ({ body: { id: 'mch_default', state: 'running' } }),
    'POST /v1/machines/mch_default/exec': () => ({
      body: { stdout: 'live-smoke\n', stderr: '', exitCode: 0 },
    }),
    'DELETE /v1/machines/mch_default': () => ({
      body: { id: 'op_d', machineId: 'mch_default', type: 'delete', state: 'succeeded' },
    }),
  });
  try {
    const report = await runLiveSmoke({
      env: { INSTABOX_API_KEY: KEY, INSTABOX_API_URL: fake.url },
    });
    assert.equal(report.ok, true);
    const create = fake.requests.find(
      (row) => row.method === 'POST' && row.path === '/v1/machines',
    );
    const body = create?.body as { vcpus?: number; memMiB?: number; templateId?: string };
    assert.equal(SMALLEST_SANDBOX.vcpus, 2);
    assert.equal(SMALLEST_SANDBOX.memMiB, 4096);
    assert.equal(DEFAULT_LIVE_SMOKE_TEMPLATE, 'universal');
    assert.equal(body.vcpus, 2);
    assert.equal(body.memMiB, 4096);
    assert.equal(body.templateId, 'universal');
    assert.match(formatLiveSmokeReport(report), /2 vCPU \/ 4096 MiB/);
  } finally {
    await fake.close();
  }
});

test('live-smoke creates the smallest box, execs, always deletes, and never prints the key', async () => {
  const fake = await mockInstabox({
    'POST /v1/machines': () => ({
      body: { id: 'op_c', machineId: 'mch_smoke', type: 'create', state: 'succeeded' },
    }),
    'GET /v1/machines/mch_smoke': () => ({ body: { id: 'mch_smoke', state: 'running' } }),
    'POST /v1/machines/mch_smoke/exec': () => ({
      body: { stdout: 'live-smoke\n', stderr: '', exitCode: 0 },
    }),
    'DELETE /v1/machines/mch_smoke': () => ({
      body: { id: 'op_d', machineId: 'mch_smoke', type: 'delete', state: 'succeeded' },
    }),
  });
  try {
    let clock = 1_000;
    const report = await runLiveSmoke({
      env: {
        INSTABOX_API_KEY: KEY,
        INSTABOX_API_URL: fake.url,
        INSTABOX_TEMPLATE_ID: 'tpl_small',
      },
      now: () => {
        clock += 25;
        return clock;
      },
    });
    assert.equal(report.ok, true);
    assert.equal(report.created, true);
    assert.equal(report.destroyed, true);
    assert.equal(report.machineId, 'mch_smoke');
    assert.equal(report.execExit, 0);
    assert.equal(report.stdout, 'live-smoke');
    assert.ok(report.timings.createMs > 0);
    assert.ok(report.timings.execMs > 0);
    assert.ok(report.timings.deleteMs > 0);
    assert.ok(report.timings.totalMs >= report.timings.createMs);
    const create = fake.requests.find(
      (row) => row.method === 'POST' && row.path === '/v1/machines',
    );
    const body = create?.body as {
      vcpus?: number;
      memMiB?: number;
      templateId?: string;
      desiredState?: string;
    };
    assert.equal(body.vcpus, SMALLEST_SANDBOX.vcpus);
    assert.equal(body.memMiB, SMALLEST_SANDBOX.memMiB);
    assert.equal(body.templateId, 'tpl_small');
    assert.equal(body.desiredState, 'running');
    assert.ok(
      fake.requests.some((row) => row.method === 'DELETE' && row.path === '/v1/machines/mch_smoke'),
    );
    const printed = formatLiveSmokeReport(report);
    assert.equal(printed.includes(KEY), false);
    assert.equal(redactSecret(`key=${KEY}`, KEY).includes(KEY), false);
    assert.match(printed, /timings_ms:/);
    assert.ok(fake.requests.every((row) => row.apiKey === KEY));
  } finally {
    await fake.close();
  }
});

test('live-smoke deletes the box when exec fails', async () => {
  const fake = await mockInstabox({
    'POST /v1/machines': () => ({
      body: { id: 'op_c', machineId: 'mch_fail', type: 'create', state: 'succeeded' },
    }),
    'GET /v1/machines/mch_fail': () => ({ body: { id: 'mch_fail', state: 'running' } }),
    'POST /v1/machines/mch_fail/exec': () => ({ status: 500, body: { error: { message: KEY } } }),
    'DELETE /v1/machines/mch_fail': () => ({
      body: { id: 'op_d', machineId: 'mch_fail', type: 'delete', state: 'succeeded' },
    }),
  });
  try {
    const report = await runLiveSmoke({
      env: {
        INSTABOX_API_KEY: KEY,
        INSTABOX_API_URL: fake.url,
        MAKA_CLOUD_BOX_TEMPLATE: 'tpl_from_host',
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.created, true);
    assert.equal(report.destroyed, true);
    assert.ok(fake.requests.some((row) => row.method === 'DELETE'));
    assert.equal(JSON.stringify(report).includes(KEY), false);
    assert.equal(formatLiveSmokeReport(report).includes(KEY), false);
    assert.match(report.error ?? '', /HTTP 500/);
    assert.match(report.error ?? '', /<redacted>/);
    assert.equal((report.error ?? '').includes(KEY), false);
  } finally {
    await fake.close();
  }
});

test('live-smoke create 400 includes HTTP status and redacted body', async () => {
  const fake = await mockInstabox({
    'POST /v1/machines': () => ({
      status: 400,
      body: {
        error: {
          code: 'spec_not_allowed',
          message: `size 1/512 not allowed; key=${KEY}`,
        },
      },
    }),
  });
  try {
    const report = await runLiveSmoke({
      env: { INSTABOX_API_KEY: KEY, INSTABOX_API_URL: fake.url },
    });
    assert.equal(report.ok, false);
    assert.equal(report.created, false);
    assert.equal(report.destroyed, false);
    assert.match(report.error ?? '', /HTTP 400/);
    assert.match(report.error ?? '', /spec_not_allowed/);
    assert.match(report.error ?? '', /<redacted>/);
    assert.equal((report.error ?? '').includes(KEY), false);
  } finally {
    await fake.close();
  }
});

test('live-smoke waits for a slow create with wait=25s then deletes', async () => {
  let polls = 0;
  const fake = await mockInstabox({
    'POST /v1/machines': () => ({
      body: { id: 'op_c', machineId: 'mch_slow', type: 'create', state: 'pending' },
    }),
    'GET /v1/operations/op_c': () => {
      polls += 1;
      return {
        body: {
          id: 'op_c',
          machineId: 'mch_slow',
          type: 'create',
          state: polls >= 3 ? 'succeeded' : 'pending',
        },
      };
    },
    'GET /v1/machines/mch_slow': () => ({ body: { id: 'mch_slow', state: 'running' } }),
    'POST /v1/machines/mch_slow/exec': () => ({
      body: { stdout: 'live-smoke\n', stderr: '', exitCode: 0 },
    }),
    'DELETE /v1/machines/mch_slow': () => ({
      body: { id: 'op_d', machineId: 'mch_slow', type: 'delete', state: 'succeeded' },
    }),
  });
  try {
    const report = await runLiveSmoke({
      env: { INSTABOX_API_KEY: KEY, INSTABOX_API_URL: fake.url },
      sleep: async () => {},
    });
    assert.equal(report.ok, true);
    assert.equal(report.destroyed, true);
    assert.equal(polls, 3);
    const waits = fake.requests.filter(
      (row) => row.method === 'GET' && row.path === '/v1/operations/op_c',
    );
    assert.equal(waits.length, 3);
    assert.ok(waits.every((row) => row.query === 'wait=25s'));
  } finally {
    await fake.close();
  }
});

test('live-smoke retries DELETE after 409 operation_conflict', async () => {
  let deletes = 0;
  const fake = await mockInstabox({
    'POST /v1/machines': () => ({
      body: { id: 'op_c', machineId: 'mch_409', type: 'create', state: 'succeeded' },
    }),
    'GET /v1/machines/mch_409': () => ({ body: { id: 'mch_409', state: 'running' } }),
    'POST /v1/machines/mch_409/exec': () => ({
      body: { stdout: 'live-smoke\n', stderr: '', exitCode: 0 },
    }),
    'DELETE /v1/machines/mch_409': () => {
      deletes += 1;
      if (deletes === 1) {
        return {
          status: 409,
          body: {
            error: {
              code: 'operation_conflict',
              message: 'machine has an active create operation',
              retryable: false,
            },
          },
        };
      }
      return { body: { id: 'op_d', machineId: 'mch_409', type: 'delete', state: 'succeeded' } };
    },
  });
  try {
    const report = await runLiveSmoke({
      env: { INSTABOX_API_KEY: KEY, INSTABOX_API_URL: fake.url },
      sleep: async () => {},
    });
    assert.equal(report.ok, true);
    assert.equal(report.destroyed, true);
    assert.equal(deletes, 2);
    const deleteReqs = fake.requests.filter(
      (row) => row.method === 'DELETE' && row.path === '/v1/machines/mch_409',
    );
    assert.equal(deleteReqs.length, 2);
    assert.ok(deleteReqs.every((row) => row.confirmDelete === undefined));
    assert.equal(report.error, undefined);
  } finally {
    await fake.close();
  }
});

test('live-smoke command is the trivial echo', () => {
  assert.equal(LIVE_SMOKE_CMD, 'echo live-smoke');
});
