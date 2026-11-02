import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  createInstaboxSandboxFromEnv,
  createSandboxFromEnv,
  FakeSandbox,
  HttpSandbox,
  InstaboxCredentialsError,
} from '../sandbox.js';

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
        path: req.url ?? '',
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

test('createSandboxFromEnv is Fake without a key and throws when the key has no machine', () => {
  assert.ok(createSandboxFromEnv({}) instanceof FakeSandbox);
  assert.throws(
    () => createSandboxFromEnv({ INSTABOX_API_KEY: 'ibx-test' }),
    (error: unknown) =>
      error instanceof InstaboxCredentialsError && /INSTABOX_MACHINE_ID/.test(error.message),
  );
  assert.throws(
    () => createInstaboxSandboxFromEnv({}),
    (error: unknown) =>
      error instanceof InstaboxCredentialsError && /INSTABOX_API_KEY/.test(error.message),
  );
});

test('HttpSandbox talks Instabox paths and never echoes the API key', async () => {
  const fake = await mockInstabox({
    'GET /v1/machines/mch_1': () => ({ body: { id: 'mch_1', state: 'stopped' } }),
    'POST /v1/machines/mch_1/start': () => ({ body: { id: 'op_1', state: 'succeeded' } }),
    'POST /v1/machines/mch_1/exec': () => ({
      body: { stdout: 'ok', stderr: '', exitCode: 0 },
    }),
    'POST /v1/machines/mch_1/suspend': () => ({ body: { id: 'op_2', state: 'succeeded' } }),
    'POST /v1/machines/mch_1/snapshots': () => ({ body: { id: 'snap_1' } }),
    'DELETE /v1/snapshots/snap_1': () => ({ body: {} }),
    'PUT /v1/machines/mch_1/activity-leases/loop': () => ({ body: {} }),
  });
  try {
    const box = new HttpSandbox({ apiKey: 'ibx-secret-key', baseUrl: fake.url });
    await box.ensureRunning('mch_1');
    const ran = await box.exec('mch_1', { cmd: 'echo hi', cwd: '/tmp' });
    assert.deepEqual(ran, { stdout: 'ok', stderr: '', exitCode: 0 });
    await box.suspend('mch_1');
    const snap = await box.createSnapshot('mch_1', 'before');
    assert.equal(snap.id, 'snap_1');
    await box.deleteSnapshot('snap_1');
    await box.putActivityLease('mch_1', 'loop');
    assert.deepEqual(
      fake.requests.map((row) => `${row.method} ${row.path}`),
      [
        'GET /v1/machines/mch_1',
        'POST /v1/machines/mch_1/start',
        'POST /v1/machines/mch_1/exec',
        'POST /v1/machines/mch_1/suspend',
        'POST /v1/machines/mch_1/snapshots',
        'DELETE /v1/snapshots/snap_1',
        'PUT /v1/machines/mch_1/activity-leases/loop',
      ],
    );
    assert.equal((fake.requests[2]?.body as { cmd?: string } | undefined)?.cmd, 'echo hi');
    assert.ok(fake.requests.every((row) => row.apiKey === 'ibx-secret-key'));
    const printed = JSON.stringify(fake.requests.map((row) => row.path));
    assert.equal(printed.includes('ibx-secret-key'), false);
  } finally {
    await fake.close();
  }
});

test('HttpSandbox fails clearly on HTTP errors and createSandboxFromEnv uses the recorded URL', async () => {
  const fake = await mockInstabox({
    'GET /v1/machines/mch_1': () => ({ status: 401, body: { error: { message: 'no' } } }),
  });
  try {
    const box = createSandboxFromEnv(
      {
        INSTABOX_API_KEY: 'ibx-other',
        INSTABOX_MACHINE_ID: 'mch_1',
        INSTABOX_API_URL: fake.url,
      },
      fetch,
    );
    assert.ok(box instanceof HttpSandbox);
    await assert.rejects(
      box.getMachine('mch_1'),
      (error: unknown) =>
        error instanceof Error &&
        /HTTP 401/.test(error.message) &&
        error.message.includes('"message":"no"'),
    );
  } finally {
    await fake.close();
  }
});

test('HttpSandbox 400 includes status and redacted body', async () => {
  const key = 'ibx-echoed-secret';
  const fake = await mockInstabox({
    'POST /v1/machines': () => ({
      status: 400,
      body: { error: { code: 'spec_not_allowed', message: `denied ${key}` } },
    }),
  });
  try {
    const box = new HttpSandbox({ apiKey: key, baseUrl: fake.url, fetch });
    await assert.rejects(box.createMachine({ templateId: 'universal', vcpus: 1, memMiB: 512 }), {
      message: /HTTP 400.*spec_not_allowed.*<redacted>/,
    });
  } finally {
    await fake.close();
  }
});
