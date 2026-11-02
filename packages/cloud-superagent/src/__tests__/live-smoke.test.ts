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
import { InstaboxCredentialsError, instaboxApiFromEnv, SMALLEST_SANDBOX } from '../sandbox.js';

const KEY = 'ibx-live-secret-do-not-print';

interface Recorded {
  method: string;
  path: string;
  apiKey: string | undefined;
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
      const recorded: Recorded = {
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0] ?? '',
        apiKey: header(req, 'x-api-key'),
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

test('live-smoke refuses to start without a key or template and never fetches', async () => {
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
  await assert.rejects(
    () => runLiveSmoke({ env: { INSTABOX_API_KEY: KEY }, fetch: fetchImpl }),
    /INSTABOX_TEMPLATE_ID|MAKA_CLOUD_BOX_TEMPLATE/,
  );
  assert.equal(fetched, false);
  assert.throws(() => instaboxApiFromEnv({}), InstaboxCredentialsError);
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
  } finally {
    await fake.close();
  }
});

test('live-smoke command is the trivial echo', () => {
  assert.equal(LIVE_SMOKE_CMD, 'echo live-smoke');
});
