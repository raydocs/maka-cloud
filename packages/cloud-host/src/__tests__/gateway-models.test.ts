import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gateway } from '@maka-cloud/gateway';
import type { CheckCharge } from '@maka-cloud/supervisor';
import { gatewayPrices } from '../gateway.js';
import {
  createGatewaySummaryModel,
  createGatewayVerifierModel,
  dailyLimit,
} from '../inbox/models.js';

const CHECK = {
  vendor: 'openai' as const,
  model: 'check-test',
  inputPerMTokUsd: 2,
  outputPerMTokUsd: 8,
  maxInputChars: 20_000,
  maxOutputTokens: 1_000,
};

/** A vendor the gateway sends to: it answers with the reply and usage of each vendor's API. */
function upstream() {
  const seen: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    const key = request.headers.get('x-api-key') ?? request.headers.get('authorization');
    seen.push({ url: request.url, key, body });
    const reply = '{"verdicts":[],"order":["a"],"summary":"One thing needs you."}';
    const answer = request.url.endsWith('/responses')
      ? {
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          model: body.model,
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: reply, annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1_000,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 100,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 1_100,
          },
        }
      : {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1_000, output_tokens: 100 },
        };
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { seen, send };
}

function rig() {
  const vendor = upstream();
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: 'sk-master-a' }, openai: { apiKey: 'sk-master-o' } },
    models: gatewayPrices([], [CHECK]),
    fetch: vendor.send,
  });
  return { gateway, vendor };
}

function recordingCharge(refuse?: 'daily_cap' | 'conversation_budget') {
  const log = { reserved: [] as number[], settled: [] as number[] };
  const charge: CheckCharge = {
    reserve: (usd) => {
      log.reserved.push(usd);
      return refuse;
    },
    settle: (usd) => void log.settled.push(usd),
  };
  return { charge, log };
}

const REQUEST = { instructions: 'Check the claims.', prompt: 'CLAIMS ...', maxOutputTokens: 500 };

test('a check goes through the gateway: reserved on the exact request first, settled at the reported usage, vendor key added on the host', async () => {
  const { gateway, vendor } = rig();
  const model = createGatewayVerifierModel(CHECK, gateway);
  assert.equal(model.metered, true);
  const { charge, log } = recordingCharge();
  const reply = await model.verify(REQUEST, new AbortController().signal, charge);
  assert.deepEqual(reply.output, {
    verdicts: [],
    order: ['a'],
    summary: 'One thing needs you.',
  });
  assert.equal(vendor.seen.length, 1);
  assert.match(vendor.seen[0]?.url ?? '', /\/responses$/u);
  assert.equal(vendor.seen[0]?.key, 'Bearer sk-master-o');
  assert.equal(log.reserved.length, 1);
  const worst = log.reserved[0] ?? 0;
  const spent = (1_000 * 2 + 100 * 8) / 1e6;
  assert.ok(worst >= (500 * 8) / 1e6, 'the output cap is reserved in full');
  assert.ok(Math.abs((log.settled[0] ?? 0) - spent) < 1e-12, `${log.settled}`);
  assert.equal(gateway.openGrants, 0, 'the grant ended with the request');
});

test('a check whose budget refuses is never sent', async () => {
  const { gateway, vendor } = rig();
  const model = createGatewayVerifierModel(CHECK, gateway);
  const { charge, log } = recordingCharge('daily_cap');
  await assert.rejects(model.verify(REQUEST, new AbortController().signal, charge));
  assert.equal(vendor.seen.length, 0);
  assert.equal(log.reserved.length, 1);
  assert.deepEqual(log.settled, []);
  await assert.rejects(
    model.verify(REQUEST, new AbortController().signal),
    'without a charge nothing is sent',
  );
  assert.equal(vendor.seen.length, 0);
  assert.equal(gateway.openGrants, 0);
});

test('the digest summary goes through the gateway on its own daily limit', async () => {
  const { gateway, vendor } = rig();
  let now = Date.parse('2026-10-19T10:00:00Z');
  // Haiku at $0.1 / $0.5: a summary reserves about $0.001 and settles at $0.00015, so a $0.002
  // day takes a handful before the next reservation no longer fits.
  const limit = dailyLimit(0.002, () => now);
  const summary = createGatewaySummaryModel('claude-haiku-5-5', gateway, limit);
  const items = { items: [{ id: 'a', kind: 'question', ask: 'x', ageMs: 1 }] } as never;
  assert.deepEqual(await summary.summarize(items, new AbortController().signal), {
    order: ['a'],
    summary: 'One thing needs you.',
  });
  assert.equal(vendor.seen[0]?.key, 'sk-master-a');
  let sent = 1;
  while (sent < 20) {
    try {
      await summary.summarize(items, new AbortController().signal);
      sent += 1;
    } catch {
      break;
    }
  }
  // The gateway may ask the free count endpoint before it refuses; only messages are billed.
  const messages = () => vendor.seen.filter((request) => request.url.endsWith('/v1/messages'));
  assert.ok(sent < 20, 'the day’s limit stops the summaries');
  assert.equal(messages().length, sent, 'a refused summary is not sent');
  now += 24 * 60 * 60 * 1000;
  await summary.summarize(items, new AbortController().signal);
  assert.equal(messages().length, sent + 1, 'a new day has its own limit');
});

test('check models the configuration does not price are priced from their pool entry', () => {
  const configured = [
    {
      vendor: 'openai' as const,
      model: 'check-test',
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 9,
      maxOutputTokens: 9,
    },
  ];
  assert.deepEqual(gatewayPrices(configured, [CHECK]), configured);
  const builtIn = { ...CHECK, vendor: 'anthropic' as const, model: 'claude-haiku-5-5' };
  assert.deepEqual(gatewayPrices([], [builtIn]), [], 'a built-in price is kept');
  assert.deepEqual(gatewayPrices([], [CHECK]), [
    {
      vendor: 'openai',
      model: 'check-test',
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 8,
      maxOutputTokens: 1_000,
    },
  ]);
});
