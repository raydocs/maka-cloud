import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type AccountLimits,
  Gateway,
  type SpendAccounts,
  SqliteSpendJournal,
} from '@maka-cloud/gateway';
import type { CheckCharge } from '@maka-cloud/supervisor';
import { conductorGateway, gatewayPrices } from '../gateway.js';
import { createGatewaySummaryModel, createGatewayVerifierModel } from '../inbox/models.js';
import { startInbox } from '../inbox/setup.js';

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

function rig(accounts?: SpendAccounts) {
  const vendor = upstream();
  const gateway = new Gateway({
    ...(accounts === undefined ? {} : { accounts }),
    upstreams: { anthropic: { apiKey: 'sk-master-a' }, openai: { apiKey: 'sk-master-o' } },
    models: gatewayPrices([], [CHECK]),
    fetch: vendor.send,
  });
  return { gateway, vendor };
}

function recordingCharge(refuse?: 'daily_cap' | 'conversation_budget') {
  const log = { reserved: [] as number[], settled: [] as number[] };
  const charge: CheckCharge = {
    conversationId: 'cnv_a',
    reserve: (usd) => {
      log.reserved.push(usd);
      return refuse;
    },
    settle: (usd) => void log.settled.push(usd),
  };
  return { charge, log };
}

/** Conversation `cnv_a` is invite `inv_a`'s, `cnv_b` is `inv_b`'s, and nobody owns the rest. */
const OWNERS = (conversationId: string) =>
  conversationId === 'cnv_a'
    ? { inviteId: 'inv_a' }
    : conversationId === 'cnv_b'
      ? { inviteId: 'inv_b' }
      : undefined;

const REQUEST = { instructions: 'Check the claims.', prompt: 'CLAIMS ...', maxOutputTokens: 500 };

test('a check goes through the gateway: reserved on the exact request first, settled at the reported usage, vendor key added on the host', async () => {
  const { gateway, vendor } = rig();
  const model = createGatewayVerifierModel(CHECK, gateway, OWNERS);
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
  const model = createGatewayVerifierModel(CHECK, gateway, OWNERS);
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

/** A spend journal on a fresh file; `open` opens it again, as the next process would. */
async function journalFile(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'host-summary-limit-'));
  const opened: SqliteSpendJournal[] = [];
  t.after(async () => {
    for (const journal of opened) journal.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    open: () => {
      const journal = new SqliteSpendJournal(join(dir, 'gateway-spend.db'));
      opened.push(journal);
      return journal;
    },
  };
}

test('the digest summary goes through the gateway on its own daily limit', async (t) => {
  const { gateway, vendor } = rig();
  let now = Date.parse('2026-10-19T10:00:00Z');
  // Haiku at $0.1 / $0.5: a summary reserves about $0.001 and settles at $0.00015, so a $0.002
  // day takes a handful before the next reservation no longer fits.
  const limit = (await journalFile(t)).open().dailyLimit('digest summary', 0.002, () => now);
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

test("a restart does not start the digest summary's day afresh", async (t) => {
  const { gateway, vendor } = rig();
  const now = () => Date.parse('2026-10-19T10:00:00Z');
  const file = await journalFile(t);
  const items = { items: [{ id: 'a', kind: 'question', ask: 'x', ageMs: 1 }] } as never;
  const messages = () => vendor.seen.filter((request) => request.url.endsWith('/v1/messages'));
  const summarizeUntilRefused = async (budget: ReturnType<SqliteSpendJournal['dailyLimit']>) => {
    const summary = createGatewaySummaryModel('claude-haiku-5-5', gateway, budget);
    for (let sent = 0; sent < 20; sent += 1) {
      try {
        await summary.summarize(items, new AbortController().signal);
      } catch {
        return sent;
      }
    }
    return 20;
  };
  const before = await summarizeUntilRefused(file.open().dailyLimit('digest summary', 0.002, now));
  assert.ok(before > 0 && before < 20, 'the day’s limit stops the summaries');
  assert.equal(messages().length, before);
  // The next process reads the same file: the day's spend is still there.
  const after = await summarizeUntilRefused(file.open().dailyLimit('digest summary', 0.002, now));
  assert.equal(after, 0, 'the restarted process cannot spend the day again');
  assert.equal(messages().length, before, 'and sends nothing');
});

test('a summary reservation a crashed process never settled still counts against its day', async (t) => {
  const now = () => Date.parse('2026-10-19T10:00:00Z');
  const file = await journalFile(t);
  const crashed = file.open().dailyLimit('digest summary', 0.5, now);
  assert.deepEqual(crashed.reserve('in-flight', 0.4), { ok: true });
  const next = file.open().dailyLimit('digest summary', 0.5, now);
  assert.equal(next.reserve('second', 0.2).ok, false, 'the open reservation still holds $0.40');
  assert.deepEqual(next.reserve('small', 0.1), { ok: true });
  next.settle('small', 0.01);
  assert.deepEqual(next.reserve('fits', 0.09), { ok: true }, 'a settle frees what it did not use');
  assert.equal(next.reserve('bad', Number.NaN).ok, false);
});

test('without a daily limit that survives a restart, the inbox builds no summary model', async () => {
  const { gateway, vendor } = rig();
  await assert.rejects(
    startInbox(
      {
        dbPath: '/nonexistent/supervisor.db',
        config: { verifierModels: [], summaryModel: 'claude-haiku-5-5', dailyCapUsd: 5 },
        gateway,
      },
      { parts: {}, conductor: {} } as never,
    ),
    /daily limit that survives a restart/u,
  );
  assert.equal(vendor.seen.length, 0);
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

async function ledgerRig(
  t: TestContext,
  limits: Record<string, AccountLimits>,
  serverDailyUsd = 100,
) {
  const journal = (await journalFile(t)).open();
  const accounts = journal.accountLedger({
    limitsOf: (inviteId) => limits[inviteId],
    serverDailyUsd: () => serverDailyUsd,
  });
  return rig(accounts);
}

test("a check counts against the invite that owns the checked conversation, and never another's", async (t) => {
  // What one check reserves and what it settles at, measured on a gateway with no cap.
  const probe = rig();
  const measured = recordingCharge();
  await createGatewayVerifierModel(CHECK, probe.gateway, OWNERS).verify(
    REQUEST,
    new AbortController().signal,
    measured.charge,
  );
  const reserved = measured.log.reserved[0] ?? 0;
  const spent = measured.log.settled[0] ?? 0;
  assert.ok(spent > 0 && reserved > spent);
  // inv_a's day takes one check, not two: after the first settles, a second no longer fits.
  const cap = { dailyUsd: reserved + spent / 2, monthlyUsd: 100 };
  const { gateway, vendor } = await ledgerRig(t, { inv_a: cap, inv_b: cap });
  const model = createGatewayVerifierModel(CHECK, gateway, OWNERS);
  const check = (conversationId: string) =>
    model.verify(REQUEST, new AbortController().signal, {
      ...recordingCharge().charge,
      conversationId,
    });
  await check('cnv_a');
  await assert.rejects(check('cnv_a'), /daily limit/u);
  assert.equal(vendor.seen.length, 1, 'the refused check was never sent');
  await check('cnv_b');
  assert.equal(vendor.seen.length, 2, "inv_b is not charged for inv_a's check");
});

test('a check of a conversation nobody owns is not sent', async (t) => {
  const { gateway, vendor } = await ledgerRig(t, { inv_a: { dailyUsd: 5, monthlyUsd: 50 } });
  const model = createGatewayVerifierModel(CHECK, gateway, OWNERS);
  await assert.rejects(
    model.verify(REQUEST, new AbortController().signal, {
      ...recordingCharge().charge,
      conversationId: 'cnv_unowned',
    }),
    /no owning invite/u,
  );
  assert.equal(vendor.seen.length, 0);
  assert.equal(gateway.openGrants, 0);
});

test("the digest summary counts against the server's cap and no invite's", async (t) => {
  const items = { items: [{ id: 'a', kind: 'question', ask: 'x', ageMs: 1 }] } as never;
  const budget = (await journalFile(t)).open().dailyLimit('digest summary', 100);
  // An invite with a zero cap does not stop the summary: it is nobody's.
  const open = await ledgerRig(t, { inv_a: { dailyUsd: 0, monthlyUsd: 0 } });
  const summary = createGatewaySummaryModel('claude-haiku-5-5', open.gateway, budget);
  await summary.summarize(items, new AbortController().signal);
  assert.equal(open.vendor.seen.length, 1);
  // The server's own cap does.
  const closed = await ledgerRig(t, { inv_a: { dailyUsd: 5, monthlyUsd: 50 } }, 0);
  const refused = createGatewaySummaryModel('claude-haiku-5-5', closed.gateway, budget);
  await assert.rejects(refused.summarize(items, new AbortController().signal));
  assert.equal(
    closed.vendor.seen.filter((request) => request.url.endsWith('/v1/messages')).length,
    0,
  );
});

test("the conductor's requests count against the invite that owns the session's conversation", async (t) => {
  const { gateway, vendor } = await ledgerRig(t, {
    inv_open: { dailyUsd: 5, monthlyUsd: 50 },
    inv_shut: { dailyUsd: 0, monthlyUsd: 0 },
  });
  const owners = new Map([
    ['ses_open', 'inv_open'],
    ['ses_shut', 'inv_shut'],
  ]);
  const gate = conductorGateway(gateway, (sessionId) => owners.get(sessionId));
  const held: string[] = [];
  const charge = {
    reserve: (key: string) => {
      held.push(key);
      return { ok: true } as const;
    },
    settle: (key: string) => {
      held.splice(held.indexOf(key), 1);
    },
  };
  const ask = (sessionId: string) =>
    gate.open(charge, sessionId).fetch('http://in-process/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  const sent = () => vendor.seen.filter((request) => request.url.endsWith('/v1/messages')).length;

  assert.equal((await ask('ses_shut')).status, 402, 'the invite at its cap is refused');
  assert.equal(sent(), 0);
  assert.deepEqual(held, [], "the run ledger's hold was released, not kept");
  const open = await ask('ses_open');
  assert.equal(open.status, 200);
  await open.arrayBuffer();
  assert.equal(sent(), 1);
  // A session no conversation owns can send nothing, and does not reach the ledger.
  await assert.rejects(ask('ses_nobody'), /no owning invite/u);
  assert.equal(sent(), 1);
  assert.deepEqual(held, []);
});
