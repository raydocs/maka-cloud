import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createSafeFetch,
  httpsTransport,
  publicHttpsUrl,
  type ResolvedAddress,
  type Resolver,
  type SafeFetchRequest,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../safe-fetch.js';

const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const PAGE: SafeFetchRequest = {
  accept: ['text/html'],
  maxBytes: 1024,
  timeoutMs: 5000,
};

/** A response whose body the test controls, and which counts how often it was released. */
function reply(
  status: number,
  headers: Record<string, string>,
  chunks: Uint8Array[] | AsyncIterable<Uint8Array> = [],
): TransportResponse & { destroyed: number } {
  const out = {
    status,
    headers,
    destroyed: 0,
    destroy() {
      out.destroyed += 1;
    },
    body: Array.isArray(chunks)
      ? (async function* () {
          yield* chunks;
        })()
      : chunks,
  };
  return out;
}

const html = (text: string, extra: Record<string, string> = {}) =>
  reply(200, { 'content-type': 'text/html; charset=utf-8', ...extra }, [Buffer.from(text)]);

function harness(
  answer: (request: TransportRequest, n: number) => Promise<TransportResponse> | TransportResponse,
  resolver?: Resolver,
) {
  const requests: TransportRequest[] = [];
  const looked: string[] = [];
  const responses: TransportResponse[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    const response = await answer(request, requests.length);
    responses.push(response);
    return response;
  };
  const resolve: Resolver =
    resolver ??
    (async (host) => {
      looked.push(host);
      return [PUBLIC];
    });
  return { fetch: createSafeFetch({ resolve, transport }), requests, looked, responses };
}

const released = (responses: TransportResponse[]) =>
  responses.every((r) => (r as { destroyed?: number }).destroyed! >= 1);

test('a page is fetched from the checked address with nothing of ours attached', async () => {
  const h = harness(() => html('<title>Hi</title>'));
  const result = await h.fetch('https://pages.example/a?b=1', PAGE);
  assert.deepEqual(
    result.ok && { url: result.url, type: result.contentType, body: result.body.toString() },
    { url: 'https://pages.example/a?b=1', type: 'text/html', body: '<title>Hi</title>' },
  );
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0]?.address, PUBLIC);
  assert.deepEqual(h.looked, ['pages.example']);
  const names = Object.keys(h.requests[0]?.headers ?? {});
  for (const forbidden of ['cookie', 'authorization', 'referer', 'origin', 'proxy-authorization']) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
  assert.equal(h.requests[0]?.headers['accept-encoding'], 'identity');
  assert.ok(released(h.responses));
});

test('a URL that is not a plain public https URL is refused before any lookup', async () => {
  const h = harness(() => html('x'));
  const bad = [
    'http://pages.example/',
    'ftp://pages.example/',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'https://user:pw@pages.example/',
    'https://user@pages.example/',
    'https://pages.example:8443/',
    'https://pages.example:80/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f.0.0.1/',
    'https://017700000001/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://8.8.8.8/',
    'https://localhost/',
    'https://intranet/',
    'https://metadata.google.internal/',
    'https://printer.local/',
    'https://app.localhost/',
    'https://1.2.3/',
    `https://pages.example/${'a'.repeat(2100)}`,
    'not a url',
    '',
  ];
  for (const url of bad) {
    assert.deepEqual(await h.fetch(url, PAGE), { ok: false, reason: 'bad_url' }, url.slice(0, 60));
  }
  assert.equal(h.looked.length, 0);
  assert.equal(h.requests.length, 0);
});

test('a name with a trailing dot or capitals is the same public name', () => {
  assert.equal(publicHttpsUrl('https://Pages.Example./x')?.hostname, 'pages.example.');
  assert.equal(publicHttpsUrl('https://xn--bcher-kva.example/')?.hostname, 'xn--bcher-kva.example');
});

test('a name that resolves to a private address, alone or among public ones, is never connected to', async () => {
  const answers: ResolvedAddress[][] = [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: '::ffff:10.0.0.5', family: 6 }],
    [PUBLIC, { address: '10.0.0.5', family: 4 }],
    [{ address: '10.0.0.5', family: 4 }, PUBLIC],
    [],
  ];
  for (const answer of answers) {
    const h = harness(
      () => html('x'),
      async () => answer,
    );
    assert.deepEqual(await h.fetch('https://pages.example/', PAGE), {
      ok: false,
      reason: 'blocked_address',
    });
    assert.equal(h.requests.length, 0);
  }
});

test('the socket goes to the address that was checked, however the name answers next time', async () => {
  let asked = 0;
  const h = harness(
    () => html('ok'),
    async () => (asked++ === 0 ? [PUBLIC] : [{ address: '127.0.0.1', family: 4 }]),
  );
  const result = await h.fetch('https://rebind.example/', PAGE);
  assert.equal(result.ok, true);
  assert.equal(asked, 1);
  assert.equal(h.requests[0]?.address.address, PUBLIC.address);
});

test('a lookup that fails is a refusal without the network error text', async () => {
  const h = harness(
    () => html('x'),
    async () => {
      throw new Error('getaddrinfo ENOTFOUND secret-internal-name 10.1.2.3');
    },
  );
  assert.deepEqual(await h.fetch('https://pages.example/', PAGE), {
    ok: false,
    reason: 'resolve_failed',
  });
});

test('a redirect is checked like a first request, hop by hop', async () => {
  const targets: Record<string, string> = {
    'http://pages.example/': 'bad_redirect',
    'https://127.0.0.1/admin': 'bad_redirect',
    'https://[::1]/': 'bad_redirect',
    'https://user:pw@pages.example/': 'bad_redirect',
    'https://pages.example:8443/': 'bad_redirect',
    'https://intranet/': 'bad_redirect',
    'javascript:alert(1)': 'bad_redirect',
    'https://internal.example/': 'blocked_address',
  };
  for (const [location, reason] of Object.entries(targets)) {
    const h = harness(
      () => reply(302, { location }),
      async (host) =>
        host === 'internal.example' ? [{ address: '10.0.0.5', family: 4 }] : [PUBLIC],
    );
    assert.deepEqual(
      await h.fetch('https://pages.example/', PAGE),
      { ok: false, reason },
      location,
    );
    assert.equal(h.requests.length, 1, location);
    assert.ok(released(h.responses), location);
  }
});

test('a relative redirect is followed, at most three times, and every hop is released', async () => {
  const h = harness((request, n) =>
    n <= 3 ? reply(301, { location: `/hop${n}` }) : html(`done at ${request.url.pathname}`),
  );
  const result = await h.fetch('https://pages.example/start', PAGE);
  assert.equal(result.ok && result.body.toString(), 'done at /hop3');
  assert.equal(result.ok && result.url, 'https://pages.example/hop3');
  assert.equal(h.requests.length, 4);
  assert.ok(released(h.responses));

  const endless = harness((_request, n) => reply(302, { location: `/hop${n}` }));
  assert.deepEqual(await endless.fetch('https://pages.example/', PAGE), {
    ok: false,
    reason: 'too_many_redirects',
  });
  assert.equal(endless.requests.length, 4);
  assert.ok(released(endless.responses));
});

test('a redirect without a place to go, and a 304, are refused', async () => {
  const none = harness(() => reply(302, {}));
  assert.deepEqual(await none.fetch('https://pages.example/', PAGE), {
    ok: false,
    reason: 'bad_redirect',
  });
  const notModified = harness(() => reply(304, {}));
  assert.deepEqual(await notModified.fetch('https://pages.example/', PAGE), {
    ok: false,
    reason: 'bad_status',
  });
});

test('only a plain 200 of an accepted type, without compression, is read', async () => {
  for (const status of [201, 204, 206, 400, 403, 404, 500]) {
    const h = harness(() => reply(status, { 'content-type': 'text/html' }, [Buffer.from('x')]));
    assert.deepEqual(
      await h.fetch('https://pages.example/', PAGE),
      { ok: false, reason: 'bad_status' },
      String(status),
    );
    assert.ok(released(h.responses));
  }
  for (const type of [
    undefined,
    '',
    'application/json',
    'image/png',
    'text/htmlx',
    'application/octet-stream',
  ]) {
    const h = harness(() =>
      reply(200, type === undefined ? {} : { 'content-type': type }, [Buffer.from('x')]),
    );
    assert.deepEqual(
      await h.fetch('https://pages.example/', PAGE),
      { ok: false, reason: 'bad_type' },
      String(type),
    );
    assert.ok(released(h.responses));
  }
  const gz = harness(() => html('x', { 'content-encoding': 'gzip' }));
  assert.deepEqual(await gz.fetch('https://pages.example/', PAGE), {
    ok: false,
    reason: 'bad_type',
  });
  const family = harness(() =>
    reply(200, { 'content-type': 'IMAGE/PNG; q=1' }, [Buffer.from('x')]),
  );
  const image = await family.fetch('https://pages.example/i', {
    ...PAGE,
    accept: ['image/png', 'image/jpeg'],
  });
  assert.equal(image.ok && image.contentType, 'image/png');
  const prefix = harness(() => reply(200, { 'content-type': 'image/webp' }, [Buffer.from('x')]));
  assert.equal(
    (await prefix.fetch('https://pages.example/i', { ...PAGE, accept: ['image/'] })).ok,
    true,
  );
});

test('a response over the cap is refused whole, declared or not, and the connection is released', async () => {
  const declared = harness(() => html('x', { 'content-length': '5000' }));
  assert.deepEqual(await declared.fetch('https://pages.example/', PAGE), {
    ok: false,
    reason: 'too_large',
  });
  assert.ok(released(declared.responses));

  let pulled = 0;
  const endless = harness(() =>
    reply(
      200,
      { 'content-type': 'text/html' },
      (async function* () {
        for (;;) {
          pulled += 1;
          yield Buffer.alloc(400);
        }
      })(),
    ),
  );
  assert.deepEqual(await endless.fetch('https://pages.example/', PAGE), {
    ok: false,
    reason: 'too_large',
  });
  assert.equal(pulled, 3);
  assert.ok(released(endless.responses));

  const exact = harness(() =>
    reply(200, { 'content-type': 'text/html', 'content-length': '1024' }, [Buffer.alloc(1024)]),
  );
  const ok = await exact.fetch('https://pages.example/', PAGE);
  assert.equal(ok.ok && ok.body.length, 1024);
});

test('a request that never answers ends at the deadline and is released', async () => {
  const h = harness(() => new Promise<TransportResponse>(() => undefined));
  assert.deepEqual(await h.fetch('https://pages.example/', { ...PAGE, timeoutMs: 5 }), {
    ok: false,
    reason: 'timeout',
  });
  const slowLookup = harness(
    () => html('x'),
    () => new Promise<ResolvedAddress[]>(() => undefined),
  );
  assert.deepEqual(await slowLookup.fetch('https://pages.example/', { ...PAGE, timeoutMs: 5 }), {
    ok: false,
    reason: 'timeout',
  });
  assert.equal(slowLookup.requests.length, 0);
});

test('a body that stalls ends at the deadline and is released', async () => {
  const h = harness(() =>
    reply(
      200,
      { 'content-type': 'text/html' },
      (async function* () {
        yield Buffer.from('partial');
        await new Promise(() => undefined);
      })(),
    ),
  );
  assert.deepEqual(await h.fetch('https://pages.example/', { ...PAGE, timeoutMs: 5 }), {
    ok: false,
    reason: 'timeout',
  });
  assert.ok(released(h.responses));
});

test('a response that arrives after the deadline is released, not left open', async () => {
  let late: ((response: TransportResponse) => void) | undefined;
  const h = harness(() => new Promise<TransportResponse>((resolve) => (late = resolve)));
  const result = await h.fetch('https://pages.example/', { ...PAGE, timeoutMs: 5 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  const straggler = reply(200, { 'content-type': 'text/html' }, [Buffer.from('x')]);
  late?.(straggler);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(straggler.destroyed, 1);
});

test('the caller can cancel before, during the request and during the body', async () => {
  const before = harness(() => html('x'));
  const gone = new AbortController();
  gone.abort();
  assert.deepEqual(await before.fetch('https://pages.example/', { ...PAGE, signal: gone.signal }), {
    ok: false,
    reason: 'aborted',
  });
  assert.equal(before.requests.length, 0);

  const during = new AbortController();
  let asked: (() => void) | undefined;
  const midRequest = harness(
    () => new Promise<TransportResponse>(() => undefined),
    async () => {
      asked?.();
      return [PUBLIC];
    },
  );
  asked = () => queueMicrotask(() => during.abort());
  assert.deepEqual(
    await midRequest.fetch('https://pages.example/', { ...PAGE, signal: during.signal }),
    {
      ok: false,
      reason: 'aborted',
    },
  );

  const inBody = new AbortController();
  const body = harness(() =>
    reply(
      200,
      { 'content-type': 'text/html' },
      (async function* () {
        yield Buffer.from('a');
        inBody.abort();
        await new Promise(() => undefined);
      })(),
    ),
  );
  assert.deepEqual(await body.fetch('https://pages.example/', { ...PAGE, signal: inBody.signal }), {
    ok: false,
    reason: 'aborted',
  });
  assert.ok(released(body.responses));
});

test('a network error is a refusal that says nothing of the network', async () => {
  const h = harness(() => {
    throw new Error('connect ECONNREFUSED 10.9.9.9:443 internal-secret');
  });
  const result = await h.fetch('https://pages.example/', PAGE);
  assert.deepEqual(result, { ok: false, reason: 'network' });
  assert.ok(!JSON.stringify(result).includes('10.9.9.9'));
});

test('a body that fails halfway is a refusal and is released', async () => {
  const h = harness(() =>
    reply(
      200,
      { 'content-type': 'text/html' },
      (async function* () {
        yield Buffer.from('a');
        throw new Error('socket hang up');
      })(),
    ),
  );
  assert.deepEqual(await h.fetch('https://pages.example/', PAGE), { ok: false, reason: 'network' });
  assert.ok(released(h.responses));
});

// The real transport, against a local TLS server. The URL gate and the address check stay as they
// are in production; only the connect target (the test server's port) is moved by the wrapper.

function certificate(host: string): { key: Buffer; cert: Buffer; dir: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'safe-fetch-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-subj',
        `/CN=${host}`,
        '-addext',
        `subjectAltName=DNS:${host}`,
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(dir, 'key.pem')),
      cert: readFileSync(join(dir, 'cert.pem')),
      dir,
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('the real transport connects to the checked address and verifies the certificate for the URL host', async (t) => {
  const pems = certificate('pages.example');
  if (!pems) return t.skip('openssl is not available');
  const seen: { host?: string; cookie?: string; encoding?: string }[] = [];
  const server = createServer({ key: pems.key, cert: pems.cert }, (req, res) => {
    seen.push({
      host: req.headers.host,
      cookie: req.headers.cookie,
      encoding: req.headers['accept-encoding'],
    });
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>pinned</title>');
  });
  const port = await listen(server);
  t.after(() => {
    server.close();
    rmSync(pems.dir, { recursive: true, force: true });
  });
  const real = httpsTransport({ ca: pems.cert });
  const toTestPort: Transport = (request) =>
    real({
      ...request,
      url: new URL(`https://pages.example:${port}${request.url.pathname}${request.url.search}`),
    });
  let resolvedTo = '';
  const fetchPage = createSafeFetch({
    // The name answers with a loopback address; the test says that is allowed, the way production never does.
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    isPublic: (address) => {
      resolvedTo = address;
      return true;
    },
    transport: toTestPort,
  });
  const result = await fetchPage('https://pages.example/moved', PAGE);
  assert.equal(result.ok && result.body.toString(), '<title>pinned</title>');
  assert.equal(resolvedTo, '127.0.0.1');
  assert.equal(seen.length, 2);
  assert.ok(
    seen.every(
      (entry) =>
        entry.host === `pages.example:${port}` &&
        entry.cookie === undefined &&
        entry.encoding === 'identity',
    ),
  );

  // A certificate for a different name is not trusted, even from the right address.
  const wrongName = createSafeFetch({
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    isPublic: () => true,
    transport: (request) => real({ ...request, url: new URL(`https://other.example:${port}/`) }),
  });
  assert.deepEqual(await wrongName('https://other.example/', PAGE), {
    ok: false,
    reason: 'network',
  });

  // Production's own check refuses the same server, and nothing connects.
  const before = seen.length;
  const refused = createSafeFetch({
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    transport: toTestPort,
  });
  assert.deepEqual(await refused('https://pages.example/', PAGE), {
    ok: false,
    reason: 'blocked_address',
  });
  assert.equal(seen.length, before);
});

test('the real transport does not trust a certificate it was not given', async (t) => {
  const pems = certificate('pages.example');
  if (!pems) return t.skip('openssl is not available');
  const server = createServer({ key: pems.key, cert: pems.cert }, (_req, res) => res.end('x'));
  const port = await listen(server);
  t.after(() => {
    server.close();
    rmSync(pems.dir, { recursive: true, force: true });
  });
  const real = httpsTransport();
  const fetchPage = createSafeFetch({
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    isPublic: () => true,
    transport: (request) => real({ ...request, url: new URL(`https://pages.example:${port}/`) }),
  });
  assert.deepEqual(await fetchPage('https://pages.example/', PAGE), {
    ok: false,
    reason: 'network',
  });
});
