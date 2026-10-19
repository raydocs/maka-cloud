import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { Gateway, serveGateway, vendorBaseUrl } from '../index.js';
import {
  anthropicStart,
  anthropicStream,
  ControlledBody,
  FakeUpstream,
  sse,
} from './fake-upstream.js';

async function rig() {
  const upstream = new FakeUpstream();
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: 'sk-master-a' }, openai: { apiKey: 'sk-master-o' } },
    models: [
      {
        vendor: 'openai',
        model: 'codex-test',
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 10,
        maxOutputTokens: 1_000,
      },
    ],
    limits: { requestOverheadTokens: 0, maxBodyBytes: 4_096 },
    fetch: upstream.fetch,
  });
  const server = await serveGateway(gateway, { host: '127.0.0.1', port: 0 });
  return { upstream, gateway, server };
}

const BODY = JSON.stringify({
  model: 'claude-opus-5-5',
  max_tokens: 100,
  stream: true,
  messages: [{ role: 'user', content: 'hi' }],
});

function call(url: string, headers: Record<string, string>, body = BODY): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

test('a sandbox reaches the vendor through its token on its own vendor route only', async () => {
  const { upstream, gateway, server } = await rig();
  try {
    const claude = gateway.issue({ vendor: 'anthropic', subject: 't1', budget: { limitUsd: 1 } });
    upstream.next(() => anthropicStream(3, 4));
    const ok = await call(`${vendorBaseUrl(server.url, 'anthropic')}/v1/messages`, {
      'x-api-key': claude.token,
    });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /message_stop/u);
    assert.equal(upstream.requests[0]?.headers.get('x-api-key'), 'sk-master-a');

    const wrongRoute = await call(`${vendorBaseUrl(server.url, 'openai')}/responses`, {
      authorization: `Bearer ${claude.token}`,
    });
    assert.equal(wrongRoute.status, 401, 'a Claude task token is refused on the OpenAI route');
    const noToken = await call(`${server.url}/anthropic/v1/messages`, {});
    assert.equal(noToken.status, 401);
    const masterKey = await call(`${server.url}/anthropic/v1/messages`, {
      'x-api-key': 'sk-master-a',
    });
    assert.equal(masterKey.status, 401, 'the master key is not a gateway token');
    const elsewhere = await call(`${server.url}/anthropic/v1/models`, {
      'x-api-key': claude.token,
    });
    assert.equal(elsewhere.status, 404);
    const tooLarge = await call(
      `${server.url}/anthropic/v1/messages`,
      { 'x-api-key': claude.token },
      'x'.repeat(5_000),
    );
    assert.equal(tooLarge.status, 413);

    claude.revoke();
    const revoked = await call(`${server.url}/anthropic/v1/messages`, {
      'x-api-key': claude.token,
    });
    assert.equal(revoked.status, 401);
    assert.equal(upstream.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('a sandbox that hangs up mid-stream cuts the request upstream and frees its slot', async () => {
  const { upstream, gateway, server } = await rig();
  try {
    const grant = gateway.issue({ vendor: 'anthropic', subject: 't2', budget: { limitUsd: 1 } });
    let open: ControlledBody | undefined;
    upstream.next((request) => {
      open = new ControlledBody(request.signal);
      open.push(sse([anthropicStart({ input_tokens: 3, output_tokens: 1 })]));
      return new Response(open.stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        `${server.url}/anthropic/v1/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': grant.token },
        },
        (response) => {
          response.once('data', () => {
            // The first event arrived: hang up.
            outgoing.destroy();
            resolve();
          });
        },
      );
      outgoing.on('error', () => undefined);
      outgoing.end(BODY);
      setTimeout(() => reject(new Error('no first event')), 5_000).unref();
    });
    await open?.aborted;
    while (gateway.inFlight > 0) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(grant.spend().spentUsd > 0, 'the cut request is charged');
  } finally {
    await server.close();
  }
});
