import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gate } from '../../__tests__/harness.js';
import { type FetchOutcome, createSourceFetcher } from '../fetcher.js';
import type { Transport, TransportRequest, TransportResponse } from '../transport.js';

const PUBLIC_A = '93.184.216.34';
const PUBLIC_B = '8.8.8.8';

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array[] | (() => AsyncIterable<Uint8Array>);
}

/** A transport that answers from a table by URL and records what it was asked and what it closed. */
class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  closed = 0;
  opened = 0;
  constructor(private readonly reply: (request: TransportRequest) => Reply | Promise<Reply>) {}
  async get(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const reply = await this.reply(request);
    this.opened += 1;
    let closed = false;
    const body = reply.body ?? 'ok';
    return {
      status: reply.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...reply.headers },
      body:
        typeof body === 'function'
          ? body()
          : (async function* () {
              if (typeof body === 'string') yield new TextEncoder().encode(body);
              else yield* body;
            })(),
      close: () => {
        if (!closed) this.closed += 1;
        closed = true;
      },
    };
  }
}

function setup(
  reply: (request: TransportRequest) => Reply | Promise<Reply>,
  hosts: Record<string, string[]> = {},
  extra: { maxBytes?: number; timeoutMs?: number } = {},
) {
  const transport = new FakeTransport(reply);
  const resolved: string[] = [];
  const fetcher = createSourceFetcher({
    transport,
    resolve: async (host) => {
      resolved.push(host);
      const found = hosts[host];
      if (!found) throw new Error('ENOTFOUND');
      return found;
    },
    ...extra,
  });
  const fetch = (url: string, signal = new AbortController().signal) =>
    fetcher.fetchText(url, signal);
  return { transport, resolved, fetch };
}

function refused(outcome: FetchOutcome, reason: string) {
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(!outcome.ok && outcome.reason, reason);
}

test('fetches an https page and returns its text', async () => {
  const { fetch, transport } = setup(() => ({ body: '<p>Hello</p>' }), {
    'example.com': [PUBLIC_A],
  });
  const outcome = await fetch('https://example.com/a?b=1');
  assert.deepEqual(outcome.ok && [outcome.text, outcome.finalUrl, outcome.contentType], [
    '<p>Hello</p>',
    'https://example.com/a?b=1',
    'text/html',
  ]);
  assert.equal(transport.closed, 1);
});

test('only https on port 443, without credentials, is fetched', async () => {
  const { fetch, transport } = setup(() => ({}), { 'example.com': [PUBLIC_A] });
  for (const url of [
    'http://example.com/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'data:text/html,hi',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https://example.com:8443/',
    'https://example.com:80/',
  ]) {
    refused(await fetch(url), 'blocked');
  }
  refused(await fetch('not a url'), 'bad_url');
  refused(await fetch('https://'), 'bad_url');
  assert.equal(transport.requests.length, 0);
});

test('an address literal that is not public is refused without a connection', async () => {
  const { fetch, transport, resolved } = setup(() => ({}));
  for (const url of [
    'https://127.0.0.1/',
    'https://10.0.0.5/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://192.168.1.1/',
    'https://100.64.0.1/',
    'https://0.0.0.0/',
    'https://[::1]/',
    'https://[fd00::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    // Other spellings of 127.0.0.1 that the URL parser normalizes.
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0x7f.0.0.1/',
    'https://127.1/',
    'https://017700000001/',
  ]) {
    refused(await fetch(url), 'blocked');
  }
  assert.equal(transport.requests.length, 0);
  assert.equal(resolved.length, 0, 'a literal is never resolved');
});

test('a public address literal is fetched at that address', async () => {
  const { fetch, transport } = setup(() => ({}));
  const outcome = await fetch(`https://${PUBLIC_A}/page`);
  assert.equal(outcome.ok, true);
  assert.equal(transport.requests[0]?.address, PUBLIC_A);
});

test('a host name that resolves to a private address is refused, whatever else it resolves to', async () => {
  const hosts = {
    'loop.example': ['127.0.0.1'],
    'meta.example': ['169.254.169.254'],
    'lan.example': ['10.1.2.3'],
    'v6.example': ['::1'],
    'mapped.example': ['::ffff:10.0.0.1'],
    'mixed.example': [PUBLIC_A, '10.0.0.1'],
    'mixed-first.example': ['192.168.0.9', PUBLIC_A],
  };
  const { fetch, transport } = setup(() => ({}), hosts);
  for (const host of Object.keys(hosts)) refused(await fetch(`https://${host}/`), 'blocked');
  assert.equal(transport.requests.length, 0);
});

test('a host that does not resolve, or has no address, is unreachable', async () => {
  const { fetch } = setup(() => ({}), { 'empty.example': [] });
  refused(await fetch('https://nowhere.example/'), 'unreachable');
  refused(await fetch('https://empty.example/'), 'unreachable');
});

test('the host is resolved once per hop and the connection goes to the checked address', async () => {
  const { fetch, transport, resolved } = setup(() => ({}), { 'example.com': [PUBLIC_A, PUBLIC_B] });
  await fetch('https://example.com/');
  assert.deepEqual(resolved, ['example.com']);
  assert.equal(transport.requests[0]?.address, PUBLIC_A);
  assert.equal(transport.requests[0]?.url.hostname, 'example.com');
});

test('no cookie, authorization or other credential header is ever sent', async () => {
  const { fetch, transport } = setup(() => ({}), { 'example.com': [PUBLIC_A] });
  await fetch('https://example.com/');
  const names = Object.keys(transport.requests[0]?.headers ?? {}).map((name) => name.toLowerCase());
  assert.deepEqual(names.sort(), ['accept', 'accept-encoding', 'user-agent']);
});

test('a redirect to a private address is refused, after the first hop was fetched', async () => {
  for (const target of [
    'https://127.0.0.1/admin',
    'https://10.0.0.1/',
    'https://[::1]/',
    'https://lan.example/',
  ]) {
    const { fetch, transport } = setup(
      (request) =>
        request.url.hostname === 'example.com'
          ? { status: 302, headers: { location: target } }
          : {},
      { 'example.com': [PUBLIC_A], 'lan.example': ['10.0.0.1'] },
    );
    refused(await fetch('https://example.com/'), 'blocked');
    assert.equal(transport.requests.length, 1, `${target} is not requested`);
    assert.equal(transport.closed, 1);
  }
});

test('a redirect to http, to a credentialed URL or to another port is refused', async () => {
  for (const target of [
    'http://example.com/',
    'https://u:p@example.com/',
    'https://example.com:8443/',
    'file:///etc/passwd',
  ]) {
    const { fetch, transport } = setup(() => ({ status: 301, headers: { location: target } }), {
      'example.com': [PUBLIC_A],
    });
    refused(await fetch('https://example.com/'), 'blocked');
    assert.equal(transport.requests.length, 1);
  }
});

test('redirects to public hosts are followed, relative ones too, each pinned to its own checked address', async () => {
  const { fetch, transport, resolved } = setup(
    (request) => {
      if (request.url.pathname === '/start')
        return { status: 301, headers: { location: 'https://other.example/next' } };
      if (request.url.pathname === '/next') return { status: 307, headers: { location: '/final' } };
      return { body: 'done' };
    },
    { 'example.com': [PUBLIC_A], 'other.example': [PUBLIC_B] },
  );
  const outcome = await fetch('https://example.com/start');
  assert.deepEqual(outcome.ok && [outcome.text, outcome.finalUrl], [
    'done',
    'https://other.example/final',
  ]);
  assert.deepEqual(resolved, ['example.com', 'other.example', 'other.example']);
  assert.deepEqual(
    transport.requests.map((request) => request.address),
    [PUBLIC_A, PUBLIC_B, PUBLIC_B],
  );
  assert.equal(transport.closed, 3);
});

test('more than three redirects stop the fetch, and a redirect loop does not run forever', async () => {
  const { fetch, transport } = setup(
    () => ({ status: 302, headers: { location: 'https://example.com/again' } }),
    { 'example.com': [PUBLIC_A] },
  );
  refused(await fetch('https://example.com/'), 'too_many_redirects');
  assert.equal(transport.requests.length, 4, 'the first request and three redirects');
  assert.equal(transport.closed, 4);
});

test('a redirect without a usable location is an error, not a fetch', async () => {
  const none = setup(() => ({ status: 302 }), { 'example.com': [PUBLIC_A] });
  refused(await none.fetch('https://example.com/'), 'http_status');
  const bad = setup(() => ({ status: 302, headers: { location: 'https://' } }), {
    'example.com': [PUBLIC_A],
  });
  refused(await bad.fetch('https://example.com/'), 'bad_url');
});

test('an error status is reported, not read', async () => {
  const { fetch, transport } = setup(() => ({ status: 404, body: 'nope' }), {
    'example.com': [PUBLIC_A],
  });
  refused(await fetch('https://example.com/'), 'http_status');
  assert.equal(transport.closed, 1);
});

test('only text is read: other types and encoded bodies are refused', async () => {
  const hosts = { 'example.com': [PUBLIC_A] };
  for (const headers of [
    { 'content-type': 'application/pdf' } as Record<string, string>,
    { 'content-type': 'image/png' },
    { 'content-type': 'application/octet-stream' },
    { 'content-type': 'application/json' },
    { 'content-type': '' },
    { 'content-type': 'text/html', 'content-encoding': 'gzip' },
    { 'content-type': 'text/html', 'content-encoding': 'br' },
  ]) {
    const { fetch, transport } = setup(() => ({ headers }), hosts);
    refused(await fetch('https://example.com/'), 'unsupported_type');
    assert.equal(transport.closed, 1);
  }
  const plain = setup(() => ({ headers: { 'content-type': 'Text/Plain; charset=utf-8' } }), hosts);
  assert.equal((await plain.fetch('https://example.com/')).ok, true);
  const xhtml = setup(() => ({ headers: { 'content-type': 'application/xhtml+xml' } }), hosts);
  assert.equal((await xhtml.fetch('https://example.com/')).ok, true);
});

test('a page declared over the cap is refused before its body is read', async () => {
  let read = false;
  const { fetch, transport } = setup(
    () => ({
      headers: { 'content-length': '5000' },
      body: () =>
        (async function* () {
          read = true;
          yield new Uint8Array(10);
        })(),
    }),
    { 'example.com': [PUBLIC_A] },
    { maxBytes: 1000 },
  );
  refused(await fetch('https://example.com/'), 'too_large');
  assert.equal(read, false);
  assert.equal(transport.closed, 1);
});

test('a body that outgrows the cap while streaming is cut off, whatever it declared', async () => {
  let pulled = 0;
  const { fetch, transport } = setup(
    () => ({
      headers: { 'content-length': '10' },
      body: () =>
        (async function* () {
          while (true) {
            pulled += 1;
            yield new Uint8Array(400);
          }
        })(),
    }),
    { 'example.com': [PUBLIC_A] },
    { maxBytes: 1000 },
  );
  refused(await fetch('https://example.com/'), 'too_large');
  assert.ok(pulled <= 4, `read ${pulled} chunks`);
  assert.equal(transport.closed, 1);
});

test('a body of exactly the cap is read', async () => {
  const { fetch } = setup(
    () => ({ body: 'x'.repeat(1000) }),
    { 'example.com': [PUBLIC_A] },
    { maxBytes: 1000 },
  );
  const outcome = await fetch('https://example.com/');
  assert.equal(outcome.ok && outcome.bytes, 1000);
});

test('a source that never answers times out, and the connection is released', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const { fetch, transport } = setup(
      (request) =>
        new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      { 'example.com': [PUBLIC_A] },
      { timeoutMs: 10 },
    );
    refused(await fetch('https://example.com/'), 'timeout');
    assert.equal(transport.opened, 0);
  } finally {
    clearInterval(keepAlive);
  }
});

test('a transport that ignores the signal still cannot hold the fetch past its deadline', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    let release: (() => void) | undefined;
    const { fetch, transport } = setup(
      () =>
        new Promise<Reply>((resolve) => {
          release = () => resolve({});
        }),
      { 'example.com': [PUBLIC_A] },
      { timeoutMs: 10 },
    );
    refused(await fetch('https://example.com/'), 'timeout');
    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(transport.closed, 1, 'a response that arrives late is closed');
  } finally {
    clearInterval(keepAlive);
  }
});

test('a body that stalls after the headers times out and is closed', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const { fetch, transport } = setup(
      () => ({
        body: () =>
          (async function* () {
            yield new TextEncoder().encode('start');
            await new Promise(() => {});
          })(),
      }),
      { 'example.com': [PUBLIC_A] },
      { timeoutMs: 10 },
    );
    refused(await fetch('https://example.com/'), 'timeout');
    assert.equal(transport.closed, 1);
  } finally {
    clearInterval(keepAlive);
  }
});

test('stopping the check aborts the fetch and releases the connection', async () => {
  const controller = new AbortController();
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { fetch, transport } = setup(
    () => ({
      body: () =>
        (async function* () {
          markStarted();
          await new Promise(() => {});
        })(),
    }),
    { 'example.com': [PUBLIC_A] },
  );
  const pending = fetch('https://example.com/', controller.signal);
  await started;
  controller.abort();
  refused(await pending, 'aborted');
  assert.equal(transport.closed, 1);
  refused(await fetch('https://example.com/', controller.signal), 'aborted');
});

test('a connection failure is unreachable and leaks nothing', async () => {
  const { fetch, transport } = setup(
    () => {
      throw new Error('ECONNREFUSED 93.184.216.34:443');
    },
    { 'example.com': [PUBLIC_A] },
  );
  const outcome = await fetch('https://example.com/');
  refused(outcome, 'unreachable');
  assert.doesNotMatch(
    JSON.stringify(outcome),
    /ECONNREFUSED|93\.184/,
    'internal details do not leak into the result',
  );
  assert.equal(transport.opened, 0);
});

test('an error status keeps its number, so a gone page can be told from a failing server', async () => {
  for (const status of [404, 410, 503]) {
    const { fetch } = setup(() => ({ status, body: 'nope' }), { 'example.com': [PUBLIC_A] });
    const outcome = await fetch('https://example.com/');
    refused(outcome, 'http_status');
    assert.equal(!outcome.ok && outcome.status, status);
  }
  const { fetch } = setup(() => ({ status: 200 }), { 'example.com': [PUBLIC_A] });
  assert.equal('status' in (await fetch('https://example.com/')), false);
});

test('a resolver that never answers ends at the deadline, and at an abort, instead of holding the fetch', {
  timeout: 5000,
}, async () => {
  const entered = new Gate();
  const hung = () => {
    entered.resolve();
    return new Promise<string[]>(() => {});
  };
  const slow = createSourceFetcher({
    transport: new FakeTransport(() => ({})),
    resolve: hung,
    timeoutMs: 20,
  });
  refused(await slow.fetchText('https://example.com/', new AbortController().signal), 'timeout');

  const waiting = createSourceFetcher({
    transport: new FakeTransport(() => ({})),
    resolve: hung,
    timeoutMs: 60_000,
  });
  const controller = new AbortController();
  const pending = waiting.fetchText('https://example.com/', controller.signal);
  await entered.promise;
  controller.abort();
  refused(await pending, 'aborted');
});
