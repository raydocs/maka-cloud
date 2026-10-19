import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BudgetPort, Gateway, type GatewayOptions } from '../index.js';
import { costUsd, worstCaseUsd } from '../pricing.js';
import {
  anthropicEnd,
  anthropicStart,
  anthropicStream,
  ControlledBody,
  FakeUpstream,
  json,
  openAiStream,
  sse,
  text,
} from './fake-upstream.js';

const MASTER = 'sk-master-anthropic-0123456789';
const OPENAI_MASTER = 'sk-master-openai-0123456789';
const OPUS = {
  vendor: 'anthropic',
  model: 'claude-opus-5-5',
  inputPerMTokUsd: 4,
  outputPerMTokUsd: 20,
  cacheReadPerMTokUsd: 0.2,
  maxOutputTokens: 128_000,
} as const;
const CODEX = {
  vendor: 'openai',
  model: 'codex-test',
  inputPerMTokUsd: 1,
  outputPerMTokUsd: 10,
  cacheReadPerMTokUsd: 0.1,
  maxOutputTokens: 50_000,
} as const;

function rig(options: Partial<GatewayOptions> = {}) {
  const upstream = new FakeUpstream();
  const warnings: unknown[] = [];
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: MASTER }, openai: { apiKey: OPENAI_MASTER } },
    models: [CODEX],
    limits: { requestOverheadTokens: 0, imageTokens: 1_000 },
    fetch: upstream.fetch,
    onWarning: (message, detail) => warnings.push({ message, detail }),
    ...options,
  });
  return { gateway, upstream, warnings };
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 1_000,
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
    ...over,
  };
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** The reservation the gateway makes for an Anthropic body with no overhead and no cache hint. */
function worst(value: Record<string, unknown>): number {
  return worstCaseUsd(OPUS, {
    inputTokens: bytes(value),
    outputTokens: value.max_tokens as number,
    inputMultiplier: 1.25,
  });
}

function post(
  client: { fetch: typeof fetch },
  value: unknown,
  options: { path?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  return client.fetch(`http://in-process${options.path ?? '/v1/messages'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'placeholder',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(value),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function recordingPort(limitUsd: number) {
  const held = new Map<string, number>();
  const settled: Array<[string, number]> = [];
  let spent = 0;
  const port: BudgetPort = {
    reserve(key, usd) {
      let heldUsd = 0;
      for (const value of held.values()) heldUsd += value;
      if (spent + heldUsd + usd > limitUsd) return { ok: false, budget: true, reason: 'over' };
      held.set(key, usd);
      return { ok: true };
    },
    settle(key, usd) {
      held.delete(key);
      spent += usd;
      settled.push([key, usd]);
    },
  };
  return { port, held, settled, spent: () => spent };
}

test('the vendor gets the master key and never the caller’s; the caller never sees it', async () => {
  const { gateway, upstream } = rig();
  const grant = gateway.issue({ vendor: 'anthropic', subject: 'task-1', budget: { limitUsd: 1 } });
  upstream.next(() => anthropicStream(10, 5));
  const authenticated = gateway.authenticate(grant.token);
  assert.ok(authenticated);
  const response = await gateway.handle(
    authenticated.grant,
    'messages',
    new Headers({
      'x-api-key': grant.token,
      authorization: `Bearer ${grant.token}`,
      cookie: 'c=d',
      'anthropic-beta': 'b1',
    }),
    new TextEncoder().encode(JSON.stringify(body())),
  );
  const out = await text(response);
  const seen = upstream.requests[0];
  assert.ok(seen);
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.headers.get('x-api-key'), MASTER);
  assert.equal(seen.headers.get('authorization'), null);
  assert.equal(seen.headers.get('cookie'), null);
  assert.equal(seen.headers.get('anthropic-beta'), 'b1');
  assert.ok(![...seen.headers.values()].some((value) => value.includes(grant.token)));
  assert.equal(response.headers.get('set-cookie'), null, 'only the allowlisted headers come back');
  assert.equal(response.headers.get('request-id'), 'req_1');
  assert.ok(!out.includes(MASTER));
});

test('a request whose worst case does not fit what is left is refused and never sent', async () => {
  const { gateway, upstream } = rig();
  const request = body({ max_tokens: 100_000 }); // $2 of output alone
  const client = gateway.inProcess({ vendor: 'openai', subject: 'x', budget: { limitUsd: 0.1 } });
  const openai = await post(
    client,
    { model: 'codex-test', input: 'hi', max_output_tokens: 50_000 },
    { path: '/responses' },
  );
  assert.equal(openai.status, 429);
  assert.match(await text(openai), /insufficient_quota/u);
  const claude = gateway.inProcess({ vendor: 'anthropic', subject: 'x', budget: { limitUsd: 1 } });
  // The byte bound does not fit, so the request is counted first; the count cannot shrink the output.
  upstream.next(() => json({ input_tokens: 10 }));
  const response = await post(claude, request);
  assert.equal(response.status, 402);
  const reply = JSON.parse(await text(response)) as { error: { type: string; message: string } };
  assert.equal(reply.error.type, 'billing_error');
  assert.doesNotMatch(reply.error.message, /claude|anthropic|openai/iu);
  assert.equal(upstream.requests.length, 1, 'only the free count was sent');
  assert.match(upstream.requests[0]?.url ?? '', /count_tokens$/u);
  assert.equal(claude.spend().exhausted, true);
});

test('dense text is reserved by its bytes, above a two-characters-per-token estimate', () => {
  const dense = '測'.repeat(30_000);
  const value = body({ messages: [{ role: 'user', content: dense }] });
  const reserved = worst(value);
  const charsBound = worstCaseUsd(OPUS, {
    inputTokens: Math.ceil(JSON.stringify(value).length / 2),
    outputTokens: 1_000,
    inputMultiplier: 1.25,
  });
  // A dense script can be one token per character: 30,000 tokens at the cache-write rate.
  const realistic = costUsd(OPUS, {
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 30_000,
    cacheWrite1h: 0,
    output: 1_000,
  });
  assert.ok(reserved >= realistic, 'the byte bound covers one token per character');
  assert.ok(charsBound < realistic, 'the old estimate did not');
});

test('a request settles at the usage the vendor reports, and the budget gets the difference back', async () => {
  const { gateway, upstream } = rig();
  const ledger = recordingPort(1);
  const client = gateway.inProcess({ vendor: 'anthropic', subject: 'run-1', budget: ledger.port });
  upstream.next(
    () =>
      new Response(
        sse([
          anthropicStart({
            input_tokens: 100,
            cache_read_input_tokens: 1_000,
            cache_creation_input_tokens: 200,
            cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
            output_tokens: 1,
          }),
          ...anthropicEnd({ output_tokens: 300 }),
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const response = await post(client, body());
  await text(response);
  const expected = (100 * 4 + 1_000 * 0.2 + 200 * 4 * 1.25 + 300 * 20) / 1e6;
  assert.equal(ledger.settled.length, 1);
  assert.ok(Math.abs((ledger.settled[0]?.[1] ?? 0) - expected) < 1e-12);
  assert.equal(ledger.held.size, 0);
  assert.ok(Math.abs(client.spend().spentUsd - expected) < 1e-9);
  assert.equal(gateway.inFlight, 0);
});

test('Codex spend is known at the end of each request, not at the end of the turn', async () => {
  const { gateway, upstream } = rig();
  const grant = gateway.issue({ vendor: 'openai', subject: 'task-c', budget: { limitUsd: 5 } });
  const seen: number[] = [];
  grant.onSpend((state) => seen.push(state.spentUsd));
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  for (const output of [100, 200]) {
    upstream.next(() => openAiStream(1_000, 400, output));
    const response = await gateway.handle(
      found.grant,
      'responses',
      new Headers({ authorization: `Bearer ${grant.token}` }),
      new TextEncoder().encode(JSON.stringify({ model: 'codex-test', input: 'go', stream: true })),
    );
    await text(response);
  }
  const first = (600 * 1 + 400 * 0.1 + 100 * 10) / 1e6;
  const second = first + (600 * 1 + 400 * 0.1 + 200 * 10) / 1e6;
  assert.deepEqual(
    seen.map((usd) => Math.round(usd * 1e9)),
    [first, second].map((usd) => Math.round(usd * 1e9)),
  );
  assert.equal(
    upstream.requests[0]?.body.max_output_tokens,
    50_000,
    'the model cap is set when absent',
  );
  assert.equal(upstream.requests[0]?.headers.get('authorization'), `Bearer ${OPENAI_MASTER}`);
});

test('requests in flight together cannot reserve more than the budget', async () => {
  const { gateway, upstream } = rig();
  const value = body();
  const limit = worst(value) * 1.5; // room for one, not two
  const client = gateway.inProcess({
    vendor: 'anthropic',
    subject: 'x',
    budget: { limitUsd: limit },
  });
  let first: ControlledBody | undefined;
  upstream.next((request) => {
    first = new ControlledBody(request.signal);
    return new Response(first.stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const one = await post(client, value);
  // The first is still streaming and holds its reservation; the byte bound of the second does not
  // fit, and neither does its count.
  upstream.next(() => json({ input_tokens: 50 }));
  const two = await post(client, value);
  assert.equal(two.status, 402);
  first?.push(
    sse([
      anthropicStart({ input_tokens: 5, output_tokens: 1 }),
      ...anthropicEnd({ output_tokens: 5 }),
    ]),
  );
  first?.end();
  await text(one);
  upstream.next(() => anthropicStream(5, 5));
  const three = await post(client, value);
  assert.equal(three.status, 200, 'once the first settled low, there is room again');
  await text(three);
});

test('grants in one tree pool share its limit', async () => {
  const { gateway, upstream } = rig();
  const value = body();
  const limit = worst(value) * 1.5;
  const a = gateway.inProcess({
    vendor: 'anthropic',
    subject: 'a',
    budget: { limitUsd: limit, poolId: 'root-1' },
  });
  const b = gateway.inProcess({
    vendor: 'anthropic',
    subject: 'b',
    budget: { limitUsd: limit, poolId: 'root-1' },
  });
  const other = gateway.inProcess({
    vendor: 'anthropic',
    subject: 'c',
    budget: { limitUsd: limit, poolId: 'root-2' },
  });
  let held: ControlledBody | undefined;
  upstream.next((request) => {
    held = new ControlledBody(request.signal);
    return new Response(held.stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const first = await post(a, value);
  upstream.next(() => json({ input_tokens: 50 }));
  assert.equal(
    (await post(b, value)).status,
    402,
    'the sibling cannot spend what the tree already holds',
  );
  upstream.next(() => anthropicStream(5, 5));
  const unrelated = await post(other, value);
  assert.equal(unrelated.status, 200, 'another tree has its own pool');
  await text(unrelated);
  held?.end();
  await text(first);
});

test('revoking cuts an open stream mid-way and refuses the token from then on', async () => {
  const { gateway, upstream } = rig();
  const grant = gateway.issue({
    vendor: 'anthropic',
    subject: 'task-r',
    taskId: 'task-r',
    budget: { limitUsd: 1 },
  });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  let open: ControlledBody | undefined;
  upstream.next((request) => {
    open = new ControlledBody(request.signal);
    open.push(sse([anthropicStart({ input_tokens: 40, output_tokens: 1 })]));
    return new Response(open.stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const value = body();
  const response = await gateway.handle(
    found.grant,
    'messages',
    new Headers(),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const firstChunk = await reader.read();
  assert.match(new TextDecoder().decode(firstChunk.value), /message_start/u);

  gateway.revokeForTask('task-r');
  await open?.aborted;
  let rest = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    rest += new TextDecoder().decode(next.value);
  }
  assert.match(rest, /event: error/u);
  assert.match(rest, /revoked/u);
  assert.equal(gateway.authenticate(grant.token), undefined);
  // The input was reported, the output is unknown: input plus the whole output bound.
  assert.ok(Math.abs(grant.spend().spentUsd - (40 * 4 + 1_000 * 20) / 1e6) < 1e-12);
  assert.equal(gateway.inFlight, 0);
  assert.equal(gateway.openGrants, 0);
});

test('a stream whose reported input passes its reservation is cut at message_start', async () => {
  const { gateway, upstream, warnings } = rig();
  const client = gateway.inProcess({
    vendor: 'anthropic',
    subject: 'run-x',
    budget: { limitUsd: 10 },
  });
  let open: ControlledBody | undefined;
  upstream.next((request) => {
    open = new ControlledBody(request.signal);
    // Far more input than the body's bytes: the bound was wrong.
    open.push(sse([anthropicStart({ input_tokens: 500_000, output_tokens: 1 })]));
    return new Response(open.stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const out = await text(await post(client, body()));
  await open?.aborted;
  assert.match(out, /event: error/u);
  assert.match(out, /larger than its reservation/u);
  assert.ok(client.spend().spentUsd >= (500_000 * 4) / 1e6, 'the overrun is charged in full');
  assert.equal(warnings.length, 1);
});

test('requests whose cost the body does not show are refused before anything is sent', async () => {
  const { gateway, upstream } = rig();
  const claude = gateway.inProcess({ vendor: 'anthropic', subject: 'x', budget: { limitUsd: 10 } });
  const codex = gateway.inProcess({ vendor: 'openai', subject: 'x', budget: { limitUsd: 10 } });
  const refusedClaude = [
    body({ speed: 'fast' }),
    body({ inference_geo: 'us' }),
    body({ tools: [{ type: 'web_search_20260209', name: 'web_search' }] }),
    body({ mcp_servers: [] }),
    body({ context_management: { edits: [{ type: 'compact_20260112' }] } }),
    body({ service_tier: 'auto' }),
    body({ model: 'some-unpriced-model' }),
    body({ max_tokens: 500_000 }),
  ];
  for (const value of refusedClaude) {
    const response = await post(claude, value);
    assert.equal(response.status, 400, JSON.stringify(value));
  }
  const refusedCodex = [
    { model: 'codex-test', input: 'x', previous_response_id: 'resp_0' },
    { model: 'codex-test', input: 'x', conversation: 'conv_1' },
    { model: 'codex-test', input: 'x', tools: [{ type: 'web_search' }] },
    {
      model: 'codex-test',
      input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'f' }] }],
    },
    { model: 'codex-test', input: 'x', service_tier: 'priority' },
  ];
  for (const value of refusedCodex) {
    const response = await post(codex, value, { path: '/responses' });
    assert.equal(response.status, 400, JSON.stringify(value));
  }
  assert.equal(upstream.requests.length, 0);
});

test('a document is counted before it is reserved, and a failed count refuses it', async () => {
  const { gateway, upstream } = rig();
  const client = gateway.inProcess({ vendor: 'anthropic', subject: 'x', budget: { limitUsd: 10 } });
  const value = body({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
          },
          { type: 'text', text: 'summarize' },
        ],
      },
    ],
  });
  upstream.next(() => json({ input_tokens: 3_000 }));
  upstream.next(() => anthropicStream(3_000, 10));
  const ok = await post(client, value);
  assert.equal(ok.status, 200);
  await text(ok);
  const count = upstream.requests[0];
  assert.match(count?.url ?? '', /count_tokens$/u);
  assert.deepEqual(Object.keys(count?.body ?? {}).sort(), ['messages', 'model']);
  assert.equal(count?.headers.get('x-api-key'), MASTER);

  upstream.next(() => json({ type: 'error', error: { type: 'invalid_request_error' } }, 400));
  const refused = await post(client, value);
  assert.equal(refused.status, 400);
  assert.equal(upstream.requests.length, 3, 'nothing was sent after the failed count');
});

test('each way a request ends releases its slot and settles once', async (t) => {
  const cases: Array<{
    name: string;
    script: (upstream: FakeUpstream) => void;
    charge: (worst: number) => number;
  }> = [
    {
      name: 'complete stream',
      script: (u) => u.next(() => anthropicStream(5, 5)),
      charge: () => (5 * 4 + 5 * 20) / 1e6,
    },
    {
      name: 'error status',
      script: (u) =>
        u.next(() => json({ type: 'error', error: { type: 'overloaded_error' } }, 529)),
      charge: () => 0,
    },
    {
      name: 'stream without usage',
      script: (u) =>
        u.next(
          () =>
            new Response('event: ping\ndata: {}\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            }),
        ),
      charge: (worstUsd) => worstUsd,
    },
    {
      name: 'connection refused',
      script: (u) =>
        u.next(() => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        }),
      charge: () => 0,
    },
    {
      name: 'connection lost after sending',
      script: (u) =>
        u.next(() => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        }),
      charge: (worstUsd) => worstUsd,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { gateway, upstream } = rig();
      const ledger = recordingPort(10);
      const client = gateway.inProcess({ vendor: 'anthropic', subject: 'x', budget: ledger.port });
      entry.script(upstream);
      const value = body();
      const response = await post(client, value);
      await text(response).catch(() => '');
      assert.equal(gateway.inFlight, 0);
      assert.equal(ledger.settled.length, 1);
      assert.ok(Math.abs((ledger.settled[0]?.[1] ?? -1) - entry.charge(worst(value))) < 1e-12);
      assert.equal(ledger.held.size, 0);
    });
  }

  await t.test('caller cancels mid-stream', async () => {
    const { gateway, upstream } = rig();
    const ledger = recordingPort(10);
    const client = gateway.inProcess({ vendor: 'anthropic', subject: 'x', budget: ledger.port });
    let open: ControlledBody | undefined;
    upstream.next((request) => {
      open = new ControlledBody(request.signal);
      open.push(sse([anthropicStart({ input_tokens: 7, output_tokens: 1 })]));
      return new Response(open.stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const abort = new AbortController();
    const response = await post(client, body(), { signal: abort.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await open?.aborted;
    assert.equal(gateway.inFlight, 0);
    assert.deepEqual(
      ledger.settled.map(([, usd]) => usd),
      [(7 * 4 + 1_000 * 20) / 1e6],
    );
  });

  await t.test('revoked while the request is being counted', async () => {
    const { gateway, upstream } = rig();
    const ledger = recordingPort(10);
    const client = gateway.inProcess({ vendor: 'anthropic', subject: 'x', budget: ledger.port });
    let release: (() => void) | undefined;
    upstream.next(
      (request) =>
        new Promise<Response>((resolve, reject) => {
          release = () => resolve(json({ input_tokens: 1 }));
          request.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const pending = post(
      client,
      body({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
          },
        ],
      }),
    );
    await upstream.received(1);
    client.revoke();
    const response = await pending;
    assert.equal(response.status, 503);
    assert.equal(gateway.inFlight, 0);
    assert.equal(ledger.settled.length, 0, 'nothing was reserved, so nothing settles');
    release?.();
  });
});

test('a grant has a bounded number of requests in flight', async () => {
  const { gateway, upstream } = rig({
    limits: { requestOverheadTokens: 0, imageTokens: 1, maxInflightPerGrant: 1 },
  });
  const client = gateway.inProcess({ vendor: 'anthropic', subject: 'x', budget: { limitUsd: 10 } });
  let open: ControlledBody | undefined;
  upstream.next((request) => {
    open = new ControlledBody(request.signal);
    return new Response(open.stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const first = await post(client, body());
  const second = await post(client, body());
  assert.equal(second.status, 429);
  open?.end();
  await text(first);
});

test('warnings never carry a body, a token or a key', async () => {
  const { gateway, upstream, warnings } = rig();
  const grant = gateway.issue({ vendor: 'anthropic', subject: 'task-w', budget: { limitUsd: 10 } });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  const secretText = 'SECRET-PROMPT-TEXT';
  upstream.next(() => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  });
  await gateway.handle(
    found.grant,
    'messages',
    new Headers({ 'x-api-key': grant.token }),
    new TextEncoder().encode(
      JSON.stringify(body({ messages: [{ role: 'user', content: secretText }] })),
    ),
  );
  upstream.next((request) => {
    const open = new ControlledBody(request.signal);
    open.push(sse([anthropicStart({ input_tokens: 9_000_000, output_tokens: 1 })]));
    return new Response(open.stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  await text(
    await gateway.handle(
      found.grant,
      'messages',
      new Headers(),
      new TextEncoder().encode(
        JSON.stringify(body({ messages: [{ role: 'user', content: secretText }] })),
      ),
    ),
  );
  assert.ok(warnings.length >= 2);
  const logged = JSON.stringify(warnings);
  for (const secret of [grant.token, MASTER, secretText]) assert.ok(!logged.includes(secret));
});

test('a closed gateway revokes every grant and issues none', () => {
  const { gateway } = rig();
  const grant = gateway.issue({ vendor: 'anthropic', subject: 'x', budget: { limitUsd: 1 } });
  gateway.close();
  assert.equal(gateway.authenticate(grant.token), undefined);
  assert.throws(() =>
    gateway.issue({ vendor: 'anthropic', subject: 'y', budget: { limitUsd: 1 } }),
  );
});

test('a grant needs a positive budget and a configured vendor', () => {
  const { gateway } = rig({ upstreams: { anthropic: { apiKey: MASTER } } });
  assert.throws(() =>
    gateway.issue({ vendor: 'anthropic', subject: 'x', budget: { limitUsd: 0 } }),
  );
  assert.throws(() => gateway.issue({ vendor: 'openai', subject: 'x', budget: { limitUsd: 1 } }));
});
