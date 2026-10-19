import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BudgetPort,
  cleanHit,
  DEFAULT_SEARCH_CALL_USD,
  deepSeekSearch,
  Gateway,
  type GatewayOptions,
  parseSearchRequest,
  type SearchOutcome,
  type SearchProvider,
  type SearchRequest,
  searchUrl,
  serveGateway,
} from '../index.js';

const PRICE = 0.001;

function recordingPort(refuse = false) {
  const log: string[] = [];
  const port: BudgetPort = {
    reserve: (key, usd) => {
      log.push(`reserve ${usd}`);
      return refuse
        ? { ok: false, budget: true, reason: 'the budget is spent' }
        : (void key, { ok: true });
    },
    settle: (_key, usd) => void log.push(`settle ${usd}`),
  };
  return { port, log };
}

/** A provider that answers each call with the next outcome, and logs what it was asked. */
function scripted(...outcomes: Array<SearchOutcome | Error>) {
  const asked: SearchRequest[] = [];
  const provider: SearchProvider = {
    async search(request) {
      asked.push(request);
      const next = outcomes.shift() ?? { ok: true, hits: [], billed: false };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { provider, asked };
}

function rig(
  provider: SearchProvider | undefined,
  refuse = false,
  extra: Partial<GatewayOptions> = {},
) {
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: 'sk-master-a' } },
    ...(provider ? { search: { provider, callUsd: PRICE } } : {}),
    ...extra,
  });
  const { port, log } = recordingPort(refuse);
  const handle = gateway.issue({ vendor: 'anthropic', subject: 't1', taskId: 't1', budget: port });
  const grant = gateway.authenticate(handle.token)?.grant;
  const search = (body: unknown, signal?: AbortSignal) =>
    gateway.search(grant, new TextEncoder().encode(JSON.stringify(body)), signal);
  return { gateway, handle, log, search };
}

const HIT = { title: 'A page', url: 'https://example.com/a', snippet: 'Some text.' };

test('a search reserves its price before the call and settles at it when the provider bills it', async () => {
  const log: string[] = [];
  const provider: SearchProvider = {
    async search(request) {
      log.push(`search ${request.query} ${request.count}`);
      return { ok: true, hits: [HIT], billed: true };
    },
  };
  const gateway = new Gateway({
    upstreams: { openai: { apiKey: 'sk-master-o' } },
    search: { provider, callUsd: PRICE },
  });
  const handle = gateway.issue({
    vendor: 'openai',
    subject: 't1',
    budget: {
      reserve: (_key, usd) => (log.push(`reserve ${usd}`), { ok: true }),
      settle: (_key, usd) => void log.push(`settle ${usd}`),
    },
  });
  const grant = gateway.authenticate(handle.token)?.grant;
  const response = await gateway.search(
    grant,
    new TextEncoder().encode(JSON.stringify({ query: '  solar output 2025 ', count: 3 })),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { results: [HIT] });
  assert.deepEqual(log, [`reserve ${PRICE}`, 'search solar output 2025 3', `settle ${PRICE}`]);
  assert.equal(handle.spend().spentUsd, PRICE);
  assert.equal(gateway.inFlight, 0);
});

test('a call the provider does not bill settles at nothing; one it may have billed settles at the price', async () => {
  const cases: Array<[SearchOutcome | Error, number, number]> = [
    [{ ok: true, hits: [], billed: false }, 200, 0],
    [{ ok: true, hits: [], billed: true }, 200, PRICE],
    [{ ok: false, billed: 'no', retryable: true }, 503, 0],
    [{ ok: false, billed: 'no', retryable: false }, 400, 0],
    [{ ok: false, billed: 'unknown', retryable: true }, 503, PRICE],
    [new Error('the provider broke'), 503, PRICE],
  ];
  for (const [outcome, status, settled] of cases) {
    const { search, log } = rig(scripted(outcome).provider);
    const response = await search({ query: 'q' });
    assert.equal(response.status, status, JSON.stringify(outcome));
    await response.arrayBuffer();
    assert.deepEqual(log, [`reserve ${PRICE}`, `settle ${settled}`], JSON.stringify(outcome));
  }
});

test('a search the budget cannot cover is refused and never sent', async () => {
  const { provider, asked } = scripted({ ok: true, hits: [HIT], billed: true });
  const { search, log, handle } = rig(provider, true);
  const response = await search({ query: 'q' });
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), {
    error: { type: 'budget', message: 'the budget is spent' },
  });
  assert.deepEqual(asked, []);
  assert.deepEqual(log, [`reserve ${PRICE}`]);
  assert.equal(handle.spend().exhausted, true);
});

test('a bad request is refused before anything is reserved', async () => {
  const { provider, asked } = scripted();
  const { search, log, gateway, handle } = rig(provider);
  for (const body of [
    'text',
    { query: '' },
    { query: 'x'.repeat(129) },
    { query: 'q', count: 0 },
    { query: 'q', site: 'x' },
  ]) {
    assert.equal((await search(body)).status, 400, JSON.stringify(body));
  }
  const grant = gateway.authenticate(handle.token)?.grant;
  const big = new Uint8Array(5_000).fill(0x20);
  assert.equal((await gateway.search(grant, big)).status, 413);
  assert.deepEqual(asked, []);
  assert.deepEqual(log, []);
});

test('without a provider, search is refused and nothing is reserved', async () => {
  const { search, log } = rig(undefined);
  const response = await search({ query: 'q' });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /deepseek/iu);
  assert.deepEqual(log, []);
});

test('revoking the grant cuts a search in flight; revoke resolves once it settled', async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider: SearchProvider = {
    search: (_request, signal) =>
      new Promise((resolve) => {
        started();
        signal.addEventListener('abort', () =>
          resolve({ ok: false, billed: 'unknown', retryable: true }),
        );
      }),
  };
  const { search, log, handle, gateway } = rig(provider);
  const pending = search({ query: 'q' });
  await running;
  assert.equal(gateway.inFlight, 1);
  await handle.revoke();
  assert.deepEqual(log, [`reserve ${PRICE}`, `settle ${PRICE}`], 'settled before revoke resolved');
  const response = await pending;
  assert.equal(response.status, 503);
  assert.match(await response.text(), /revoked/u);
  assert.equal((await search({ query: 'q' })).status, 401);
});

test('a search that runs past its timeout is cut and charged', async () => {
  const provider: SearchProvider = {
    search: (_request, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () =>
          resolve({ ok: false, billed: 'unknown', retryable: true }),
        );
      }),
  };
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: 'sk-master-a' } },
    search: { provider, callUsd: PRICE, timeoutMs: 1 },
  });
  const { port, log } = recordingPort();
  const handle = gateway.issue({ vendor: 'anthropic', subject: 't', budget: port });
  const response = await gateway.search(
    gateway.authenticate(handle.token)?.grant,
    new TextEncoder().encode('{"query":"q"}'),
  );
  assert.equal(response.status, 503);
  assert.match(await response.text(), /too long/u);
  assert.deepEqual(log, [`reserve ${PRICE}`, `settle ${PRICE}`]);
});

test('the search route serves a grant of either vendor and refuses a bad key', async () => {
  const { provider, asked } = scripted(
    { ok: true, hits: [HIT], billed: true },
    { ok: true, hits: [HIT], billed: true },
  );
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: 'a' }, openai: { apiKey: 'o' } },
    search: { provider },
  });
  const server = await serveGateway(gateway, { host: '127.0.0.1', port: 0 });
  try {
    const url = searchUrl(`${server.url}/`);
    const call = (token: string, body = '{"query":"q","count":2}') =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      });
    for (const vendor of ['anthropic', 'openai'] as const) {
      const handle = gateway.issue({ vendor, subject: vendor, budget: { limitUsd: 1 } });
      const response = await call(handle.token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { results: [HIT] });
      assert.equal(handle.spend().spentUsd, DEFAULT_SEARCH_CALL_USD);
    }
    assert.equal(asked.length, 2);
    assert.equal((await call('mkg_nope')).status, 401);
    const handle = gateway.issue({ vendor: 'openai', subject: 'x', budget: { limitUsd: 1 } });
    assert.equal(
      (await call(handle.token, JSON.stringify({ query: 'x'.repeat(5_000) }))).status,
      413,
    );
    assert.equal((await fetch(url)).status, 404);
    assert.equal(asked.length, 2);
  } finally {
    await server.close();
  }
});

// -- the DeepSeek backend ------------------------------------------------------------------------

function deepSeekRig(answer: () => Response | Promise<Response>) {
  const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const provider = deepSeekSearch({
    apiKey: 'sk-search-key',
    baseUrl: 'https://search.test/',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        auth: request.headers.get('authorization'),
        body: await request.json(),
      });
      return answer();
    }) as typeof fetch,
  });
  return { provider, seen };
}

const signal = new AbortController().signal;

test('the DeepSeek backend posts the query to its search tool and keeps only clean web results', async () => {
  const { provider, seen } = deepSeekRig(() =>
    Response.json({
      results: [
        {
          title: 'Ti\u0007tle ‮evil',
          url: 'https://example.com/a',
          summary: 'From the summary.',
          date: '2026-01-02',
          site_name: 'Example',
        },
        { title: 'Script', url: 'javascript:alert(1)', snippet: 'x' },
        { title: 'No url' },
        'junk',
        { title: 'Second', url: 'http://example.org/b', snippet: 's'.repeat(3_000) },
        { title: 'Third', url: 'https://example.net/c', snippet: 'over the count' },
      ],
    }),
  );
  const outcome = await provider.search({ query: 'q', count: 2 }, signal);
  assert.deepEqual(seen, [
    {
      url: 'https://search.test/v1/tools/search',
      auth: 'Bearer sk-search-key',
      body: { query: 'q', count: 2 },
    },
  ]);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.billed, true);
  assert.equal(outcome.hits.length, 2);
  assert.deepEqual(outcome.hits[0], {
    title: 'Title evil',
    url: 'https://example.com/a',
    snippet: 'From the summary.',
    published: '2026-01-02',
  });
  assert.equal(outcome.hits[1]?.snippet.length, 2_000);
  assert.ok(outcome.hits[1]?.snippet.endsWith('…'));
});

test('the DeepSeek backend says when a call was billed', async () => {
  const outcomes: Array<[() => Response, Partial<SearchOutcome>]> = [
    [() => Response.json({ results: [] }), { ok: true, billed: false }],
    [() => Response.json({ results: [{ url: 'ftp://x' }] }), { ok: true, billed: true }],
    [() => new Response('{}', { status: 429 }), { ok: false, billed: 'no', retryable: true }],
    [() => new Response('{}', { status: 500 }), { ok: false, billed: 'no', retryable: true }],
    [() => new Response('{}', { status: 400 }), { ok: false, billed: 'no', retryable: false }],
    [() => new Response('{"results": [', { status: 200 }), { ok: false, billed: 'unknown' }],
  ];
  for (const [answer, expected] of outcomes) {
    const outcome = await deepSeekRig(answer).provider.search({ query: 'q', count: 5 }, signal);
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(
        (outcome as Record<string, unknown>)[name],
        value,
        `${name}: ${JSON.stringify(outcome)}`,
      );
    }
  }
});

test('a DeepSeek call that never connected was not billed; one that broke after sending may have been', async () => {
  const failing = (code?: string) =>
    deepSeekSearch({
      apiKey: 'k',
      fetch: (async () => {
        throw Object.assign(new TypeError('fetch failed'), code ? { cause: { code } } : {});
      }) as typeof fetch,
    });
  assert.deepEqual(await failing('ECONNREFUSED').search({ query: 'q', count: 1 }, signal), {
    ok: false,
    billed: 'no',
    retryable: true,
  });
  assert.deepEqual(await failing('ECONNRESET').search({ query: 'q', count: 1 }, signal), {
    ok: false,
    billed: 'unknown',
    retryable: true,
  });
  assert.deepEqual(await failing().search({ query: 'q', count: 1 }, signal), {
    ok: false,
    billed: 'unknown',
    retryable: true,
  });
});

test('a request is a trimmed query and a count capped at the most results', () => {
  assert.deepEqual(parseSearchRequest({ query: ' a ' }), { query: 'a', count: 10 });
  assert.deepEqual(parseSearchRequest({ query: 'a', count: 500 }), { query: 'a', count: 20 });
  assert.equal(typeof parseSearchRequest({ query: 'a', count: 1.5 }), 'string');
  assert.equal(typeof parseSearchRequest([]), 'string');
  assert.equal(cleanHit({ url: 'data:text/html,x' }), undefined);
  assert.equal(cleanHit({ url: 'not a url' }), undefined);
  assert.deepEqual(cleanHit({ url: 'https://a.test/x?y=1', title: 7 }), {
    title: '',
    url: 'https://a.test/x?y=1',
    snippet: '',
  });
});
