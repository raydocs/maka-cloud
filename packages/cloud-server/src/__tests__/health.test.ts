import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { PublicApi, type PublicApiDeps } from '../http.js';
import { startHarness } from './harness.js';

test('the health route answers without a token and says only that the server is ok', async (t) => {
  const h = await startHarness(t);
  for (const token of [null, 'nope', h.token]) {
    const res = await h.api('/healthz', { token });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('www-authenticate'), null);
  }
  const head = await h.api('/healthz', { method: 'HEAD', token: null });
  assert.equal(head.status, 200);
});

test('the health route is GET and HEAD only, and nothing under it is public', async (t) => {
  const h = await startHarness(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await h.api('/healthz', { method, token: null });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  }
  for (const path of ['/healthz/', '/healthz/x', '/health', '/v1/healthz']) {
    assert.equal((await h.api(path, { token: null })).status, 401, path);
  }
});

async function bareApi(t: TestContext, db: DatabaseSync, active: () => boolean) {
  const api = new PublicApi({ db, invites: { active } } as unknown as PublicApiDeps);
  const server = createServer((req, res) => void api.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`;
  return { api, ask: () => fetch(url) };
}

test('the health route is unavailable when a database no longer answers or the server is closing', async (t) => {
  const db = new DatabaseSync(':memory:');
  const { api, ask } = await bareApi(t, db, () => true);
  assert.equal((await ask()).status, 200);
  api.closeStreams();
  const closing = await ask();
  assert.equal(closing.status, 503);
  assert.deepEqual(await closing.json(), { status: 'unavailable' });

  const other = new DatabaseSync(':memory:');
  const second = await bareApi(t, other, () => true);
  other.close();
  assert.equal((await second.ask()).status, 503);

  const refusing = await bareApi(t, new DatabaseSync(':memory:'), () => {
    throw new Error('database is not open');
  });
  const unavailable = await refusing.ask();
  assert.equal(unavailable.status, 503, 'an invite database that no longer answers');
  assert.equal(await unavailable.text(), '{"status":"unavailable"}');
});

test('the health route leaks nothing about the server in either answer', async (t) => {
  const h = await startHarness(t);
  const ok = await h.api('/healthz', { token: null });
  const text = await ok.text();
  assert.equal(text, '{"status":"ok"}');
  assert.deepEqual(
    [...ok.headers.keys()].filter((name) => /version|server|powered/iu.test(name)),
    [],
  );
});
