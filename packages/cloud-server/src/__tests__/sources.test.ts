import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, type Harness, newConversation, startHarness } from './harness.js';
import type { SafeFetch } from '../previews.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);
const PAGE =
  '<head><title>The docs</title><meta property="og:image" content="https://cdn.example/card.png"></head>';

/** A fetcher that answers from a table, remembers every URL it was asked for, and can be held. */
function fetcher() {
  const asked: string[] = [];
  const hold: { gate?: Promise<void> } = {};
  const fetch: SafeFetch = async (url) => {
    asked.push(url);
    if (hold.gate) await hold.gate;
    if (url === 'https://cdn.example/card.png') {
      return { ok: true, url, contentType: 'image/png', body: PNG };
    }
    if (url.startsWith('https://docs.example/')) {
      return { ok: true, url, contentType: 'text/html', body: Buffer.from(PAGE) };
    }
    return { ok: false, reason: 'network' };
  };
  return { fetch, asked, hold };
}

async function setup(
  t: TestContext,
  http: Partial<Harness['options']['http']> = {},
  previews: { maxInFlight?: number } = {},
) {
  const f = fetcher();
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler, previews: { fetch: f.fetch, ...previews }, http });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const finished = async (artifacts?: string[]) => {
    const before = h.fake.runs.length;
    const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'work' });
    await eventually(() => h.fake.runs.length > before, 'run');
    await h.fake.runFor(task.taskId).complete({
      summary: 'done',
      done: ['x'],
      notDone: [],
      confidence: 'high',
      knownIssues: [],
      ...(artifacts === undefined ? {} : { artifacts }),
    });
    await h.server.orchestrator.wait(session, task.taskId, 2000);
    return task.taskId;
  };
  return { h, f, finished };
}

const source = (h: Harness, taskId: string, rest = '', token?: string | null) =>
  h.api(`/v1/tasks/${taskId}/sources${rest}`, token === undefined ? {} : { token });

test('the owner lists the pages the task opened, then reads a page’s title and its image through the server', async (t) => {
  const { h, f, finished } = await setup(t);
  const taskId = await finished();
  assert.equal(
    h.server.recordOpenedPages(taskId, [
      { url: 'https://docs.example/start', label: 'docs' },
      { url: 'https://alt.example/b', label: 'alternative' },
    ]),
    2,
  );
  const listing = await source(h, taskId);
  assert.equal(listing.status, 200);
  assert.deepEqual(await listing.json(), {
    sources: [
      { index: 0, url: 'https://docs.example/start', site: 'docs.example', label: 'docs' },
      { index: 1, url: 'https://alt.example/b', site: 'alt.example', label: 'alternative' },
    ],
    total: 2,
  });
  assert.deepEqual(f.asked, [], 'listing fetches nothing');

  const preview = await source(h, taskId, '/0/preview');
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { site: 'docs.example', title: 'The docs', image: true });
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');

  const image = await source(h, taskId, '/0/image');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/u);
  assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  // One fetch of the page and one of its image served all three requests.
  assert.deepEqual(f.asked, ['https://docs.example/start', 'https://cdn.example/card.png']);

  // A page that cannot be read is a card without a preview, and has no image.
  assert.deepEqual(await (await source(h, taskId, '/1/preview')).json(), {
    site: 'alt.example',
    image: false,
  });
  assert.equal((await source(h, taskId, '/1/image')).status, 404);
});

test('only pages the log holds are ever fetched: not a manifest link, not a URL in the path', async (t) => {
  const { h, f, finished } = await setup(t);
  const taskId = await finished(['https://evil.example/exfil?data=secret', 'report.md']);
  h.server.recordOpenedPages(taskId, [{ url: 'https://docs.example/start' }]);
  assert.deepEqual(
    ((await (await source(h, taskId)).json()) as { sources: unknown[] }).sources.length,
    1,
  );
  for (const rest of [
    '/https%3A%2F%2Fevil.example%2F/preview',
    '/https://evil.example/preview',
    '/-1/preview',
    '/1000/preview',
    '/1/preview',
    '/0/other',
    '/0',
    '/00000/preview',
  ]) {
    assert.equal((await source(h, taskId, rest)).status, 404, rest);
  }
  assert.deepEqual(f.asked, []);
  await source(h, taskId, '/0/preview');
  assert.deepEqual(
    (f.asked as string[]).filter((url) => url.includes('evil')),
    [],
  );
});

test('another invite, a missing task and a missing token see the same 404 or 401', async (t) => {
  const { h, f, finished } = await setup(t);
  const taskId = await finished();
  h.server.recordOpenedPages(taskId, [{ url: 'https://docs.example/start' }]);
  const other = h.server.invites.create('other').token;
  for (const rest of ['', '/0/preview', '/0/image']) {
    const own = await source(h, taskId, rest, other);
    const missing = await source(h, 'tsk_nope', rest, other);
    assert.equal(own.status, 404, rest);
    assert.equal(missing.status, 404, rest);
    assert.deepEqual(await own.json(), await missing.json());
    assert.equal((await source(h, taskId, rest, null)).status, 401, rest);
    assert.equal((await source(h, taskId, rest, 'wrong')).status, 401, rest);
  }
  assert.deepEqual(f.asked, [], 'a stranger cannot make the server fetch anything');
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await h.api(`/v1/tasks/${taskId}/sources`, { method });
    assert.equal(res.status, 405, method);
  }
});

test('pages are recorded for a task that exists, by trusted code only', async (t) => {
  const { h, finished } = await setup(t);
  assert.equal(h.server.recordOpenedPages('tsk_unknown', [{ url: 'https://docs.example/' }]), 0);
  const taskId = await finished();
  // The public API has no way to write the log.
  for (const method of ['POST', 'PUT']) {
    const res = await h.api(`/v1/tasks/${taskId}/sources`, {
      method,
      body: JSON.stringify({ url: 'https://docs.example/' }),
    });
    assert.equal(res.status, 405);
  }
  assert.deepEqual(await (await source(h, taskId)).json(), { sources: [], total: 0 });
});

test('previews are rate limited per invite and answer 429 with a retry hint when the server is busy', async (t) => {
  const { h, f, finished } = await setup(t, { previewsPerMinute: 2 });
  const taskId = await finished();
  h.server.recordOpenedPages(taskId, [{ url: 'https://docs.example/start' }]);
  assert.equal((await source(h, taskId, '/0/preview')).status, 200);
  assert.equal((await source(h, taskId, '/0/preview')).status, 200);
  const limited = await source(h, taskId, '/0/preview');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(f.asked.length, 2, 'the cache served the second');
});

test('an invite revoked while its page is being fetched gets no answer', async (t) => {
  const { h, f, finished } = await setup(t);
  const taskId = await finished();
  h.server.recordOpenedPages(taskId, [{ url: 'https://docs.example/start' }]);
  let release: () => void = () => undefined;
  f.hold.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = source(h, taskId, '/0/image');
  await eventually(() => f.asked.length === 1, 'the fetch to start');
  h.server.invites.revoke(h.inviteId);
  release();
  const res = await pending;
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('when the server is already fetching as much as it allows, a new page waits for another request', async (t) => {
  const { h, f, finished } = await setup(t, {}, { maxInFlight: 1 });
  const taskId = await finished();
  h.server.recordOpenedPages(taskId, [
    { url: 'https://docs.example/one' },
    { url: 'https://docs.example/two' },
  ]);
  let release: () => void = () => undefined;
  f.hold.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = source(h, taskId, '/0/preview');
  await eventually(() => f.asked.length === 1, 'the first fetch to start');
  const busy = await source(h, taskId, '/1/preview');
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '2');
  release();
  assert.equal((await first).status, 200);
  f.hold.gate = undefined;
  assert.equal((await source(h, taskId, '/1/preview')).status, 200);
});
