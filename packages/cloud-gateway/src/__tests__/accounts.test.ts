import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type AccountLimits,
  type BudgetPort,
  Gateway,
  type SpendAccounts,
  SqliteSpendJournal,
} from '../index.js';
import { worstCaseUsd } from '../pricing.js';
import {
  anthropicEnd,
  anthropicStart,
  anthropicStream,
  ControlledBody,
  FakeUpstream,
  json,
  sse,
} from './fake-upstream.js';

const OPUS = {
  vendor: 'anthropic',
  model: 'claude-opus-5-5',
  inputPerMTokUsd: 4,
  outputPerMTokUsd: 20,
  cacheReadPerMTokUsd: 0.2,
  maxOutputTokens: 128_000,
} as const;

const request = {
  model: 'claude-opus-5-5',
  max_tokens: 1_000,
  stream: true,
  messages: [{ role: 'user', content: 'hello' }],
};
const encoded = new TextEncoder().encode(JSON.stringify(request));
const reservation = worstCaseUsd(OPUS, {
  inputTokens: encoded.byteLength,
  outputTokens: 1_000,
  inputMultiplier: 1.25,
});

async function journalPath(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-accounts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'spend.db');
}

interface Caps {
  limits?: Record<string, AccountLimits>;
  fallback?: AccountLimits;
  serverDailyUsd?: number;
  paused?: { on: boolean };
  now?: () => number;
}

const BIG = { dailyUsd: 1_000, monthlyUsd: 10_000 };

function ledgerOn(journal: SqliteSpendJournal, caps: Caps = {}): SpendAccounts {
  return journal.accountLedger({
    limitsOf: (inviteId) => caps.limits?.[inviteId] ?? caps.fallback,
    serverDailyUsd: () => caps.serverDailyUsd ?? 10_000,
    paused: () => caps.paused?.on === true,
    ...(caps.now === undefined ? {} : { now: caps.now }),
  });
}

function rig(t: TestContext, accounts: SpendAccounts | undefined, journal?: SqliteSpendJournal) {
  const upstream = new FakeUpstream();
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: 'sk-master-0123456789' } },
    limits: { requestOverheadTokens: 0 },
    fetch: upstream.fetch,
    ...(accounts === undefined ? {} : { accounts }),
    ...(journal === undefined ? {} : { journal }),
  });
  t.after(() => gateway.close());
  return { gateway, upstream };
}

function grantFor(gateway: Gateway, name: string, inviteId: string, limitUsd = 1_000) {
  const grant = gateway.issue({
    vendor: 'anthropic',
    subject: name,
    taskId: name,
    budget: { limitUsd },
    account: { inviteId },
  });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  return { grant, ref: found.grant };
}

function send(gateway: Gateway, ref: unknown): Promise<Response> {
  return gateway.handle(ref, 'messages', new Headers(), encoded);
}

/**
 * A request an Anthropic account cap refuses. The gateway first counts the request, in case its
 * exact size fits where the byte bound did not, and refuses when the count does not fit either.
 */
async function refused(
  gateway: Gateway,
  upstream: FakeUpstream,
  ref: unknown,
): Promise<{ status: number; text: string }> {
  upstream.next(() => json({ input_tokens: encoded.byteLength }));
  const response = await send(gateway, ref);
  return { status: response.status, text: await response.text() };
}

/** Requests that reached the model (not the free token counts). */
function sent(upstream: FakeUpstream): number {
  return upstream.requests.filter((seen) => !seen.url.endsWith('/count_tokens')).length;
}

/** A request that stays in flight until `end()`; resolves once the gateway has sent it. */
async function hold(gateway: Gateway, upstream: FakeUpstream, ref: unknown) {
  let body: ControlledBody | undefined;
  upstream.next((seen) => {
    body = new ControlledBody(seen.signal);
    body.push(sse([anthropicStart({ input_tokens: 40, output_tokens: 1 })]));
    return new Response(body.stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await send(gateway, ref);
  assert.equal(response.status, 200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  return {
    async end(): Promise<void> {
      // Ends the way a real stream does, so the request settles at what it cost.
      body?.push(sse(anthropicEnd({ output_tokens: 10 })));
      body?.end();
      while (!(await reader.read()).done) {
        // drain, so the request settles
      }
    },
  };
}

test('concurrent tasks of one invite cannot together pass its daily cap', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const caps = { fallback: { dailyUsd: reservation * 1.5, monthlyUsd: 1_000 } };
  const { gateway, upstream } = rig(t, ledgerOn(journal, caps));
  const first = grantFor(gateway, 'tsk_one', 'inv_a');
  const second = grantFor(gateway, 'tsk_two', 'inv_a');

  const open = await hold(gateway, upstream, first.ref);
  // The first request holds its worst case, so the second task's does not fit beside it.
  const second402 = await refused(gateway, upstream, second.ref);
  assert.equal(second402.status, 402);
  assert.match(second402.text, /daily limit/u);
  assert.equal(sent(upstream), 1, 'the refused request was never sent');

  // Once the first settles at what it cost, the hold shrinks and another task can spend.
  upstream.next(() => anthropicStream(100, 10));
  await open.end();
  const third = grantFor(gateway, 'tsk_three', 'inv_a');
  const passed = await send(gateway, third.ref);
  assert.equal(passed.status, 200, await passed.clone().text());
  await passed.text();
});

test("one invite's spend never counts against another's", async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const caps = {
    limits: {
      inv_a: { dailyUsd: reservation * 1.5, monthlyUsd: 1_000 },
      inv_b: { dailyUsd: reservation * 1.5, monthlyUsd: 1_000 },
    },
  };
  const { gateway, upstream } = rig(t, ledgerOn(journal, caps));
  const a = grantFor(gateway, 'tsk_a', 'inv_a');
  const b = grantFor(gateway, 'tsk_b', 'inv_b');
  const a2 = grantFor(gateway, 'tsk_a2', 'inv_a');

  const openA = await hold(gateway, upstream, a.ref);
  assert.equal((await refused(gateway, upstream, a2.ref)).status, 402, 'inv_a is at its cap');
  // inv_b has the same cap and none of inv_a's spend.
  const openB = await hold(gateway, upstream, b.ref);
  await openA.end();
  await openB.end();
});

test("a refused request releases the grant's own hold and ends the grant's spending", async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const caps = { fallback: { dailyUsd: reservation * 1.5, monthlyUsd: 1_000 } };
  const { gateway, upstream } = rig(t, ledgerOn(journal, caps));
  const other = grantFor(gateway, 'tsk_other', 'inv_a');
  const open = await hold(gateway, upstream, other.ref);

  const calls: string[] = [];
  const own: BudgetPort = {
    reserve: (key, usd) => {
      calls.push(`reserve ${usd > 0}`);
      return { ok: true };
    },
    settle: (_key, usd) => {
      calls.push(`settle ${usd}`);
    },
  };
  const grant = gateway.issue({
    vendor: 'anthropic',
    subject: 'tsk_capped',
    taskId: 'tsk_capped',
    budget: own,
    account: { inviteId: 'inv_a' },
  });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  const states: Array<{ exhausted: boolean; exhaustedReason?: string }> = [];
  grant.onSpend((state) => states.push(state));
  assert.equal((await refused(gateway, upstream, found.grant)).status, 402);
  assert.deepEqual(calls, ['reserve true', 'settle 0'], "the task's own hold was released");
  assert.equal(states.at(-1)?.exhausted, true);
  assert.match(states.at(-1)?.exhaustedReason ?? '', /daily limit/u);

  // Even a request that would now fit is refused: the cap ended this grant's spending.
  await open.end();
  const calls1 = calls.length;
  assert.equal((await refused(gateway, upstream, found.grant)).status, 402);
  assert.equal(calls.length, calls1, 'the capped grant does not even reach its own budget');
  assert.equal(sent(upstream), 1);
});

test('a grant with no account gets no model access once the gateway has accounts', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const { gateway, upstream } = rig(t, ledgerOn(journal, { fallback: BIG }));
  assert.throws(
    () =>
      gateway.issue({
        vendor: 'anthropic',
        subject: 'tsk_orphan',
        taskId: 'tsk_orphan',
        budget: { limitUsd: 1 },
      }),
    /no owning account/u,
  );
  assert.throws(
    () => gateway.inProcess({ vendor: 'anthropic', subject: 'x', budget: { limitUsd: 1 } }),
    /no owning account/u,
  );
  assert.equal(upstream.requests.length, 0);
});

test('an invite with no limits may not spend', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const { gateway, upstream } = rig(t, ledgerOn(journal, { limits: { inv_known: BIG } }));
  const unknown = grantFor(gateway, 'tsk_unknown', 'inv_gone');
  const response = await refused(gateway, upstream, unknown.ref);
  assert.equal(response.status, 402);
  assert.match(response.text, /may not spend/u);
  assert.equal(sent(upstream), 0);
});

test('the server cap counts every invite and the server account', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const ledger = ledgerOn(journal, { fallback: BIG, serverDailyUsd: 1 });
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_a' }, 'k1', 0.4), { ok: true });
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_b' }, 'k2', 0.4), { ok: true });
  const refused = ledger.reserve('server', 'k3', 0.3);
  assert.equal(refused.ok, false);
  assert.deepEqual(!refused.ok && refused.cap, { scope: 'server_daily', limitUsd: 1 });
  ledger.settle('k2', 0.1);
  assert.deepEqual(ledger.reserve('server', 'k4', 0.3), { ok: true });
});

test('the monthly cap holds across days, and a new month starts afresh', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  let now = Date.UTC(2026, 9, 5, 12);
  const ledger = ledgerOn(journal, {
    fallback: { dailyUsd: 10, monthlyUsd: 15 },
    now: () => now,
  });
  const invite = { inviteId: 'inv_a' };
  assert.deepEqual(ledger.reserve(invite, 'd1', 8), { ok: true });
  ledger.settle('d1', 8);
  now = Date.UTC(2026, 9, 6, 12);
  assert.deepEqual(ledger.reserve(invite, 'd2', 6), { ok: true });
  ledger.settle('d2', 6);
  // Day three has room under the daily cap, but only $1 under the month's.
  now = Date.UTC(2026, 9, 7, 12);
  const refused = ledger.reserve(invite, 'd3', 2);
  assert.equal(refused.ok, false);
  assert.deepEqual(!refused.ok && refused.cap, {
    scope: 'invite_monthly',
    inviteId: 'inv_a',
    limitUsd: 15,
  });
  now = Date.UTC(2026, 10, 1, 0, 0, 1);
  assert.deepEqual(ledger.reserve(invite, 'd4', 2), { ok: true });
});

test('a restart keeps the counters, and a hold nobody settled counts in full', async (t) => {
  const path = await journalPath(t);
  const before = new SqliteSpendJournal(path);
  const first = ledgerOn(before, { fallback: { dailyUsd: 10, monthlyUsd: 100 } });
  const invite = { inviteId: 'inv_a' };
  assert.deepEqual(first.reserve(invite, 'settled', 3), { ok: true });
  first.settle('settled', 2);
  assert.deepEqual(first.reserve(invite, 'crashed', 4), { ok: true });
  // The process stops here: the second request was never settled.

  const after = new SqliteSpendJournal(path);
  t.after(() => {
    before.close();
    after.close();
  });
  const second = ledgerOn(after, { fallback: { dailyUsd: 10, monthlyUsd: 100 } });
  // 2 settled + 4 held leaves 4 under the cap of 10.
  assert.equal(second.reserve(invite, 'big', 4.5).ok, false);
  assert.deepEqual(second.reserve(invite, 'fits', 3.9), { ok: true });
  assert.equal(second.reserve(invite, 'again', 0.2).ok, false);
});

test('a request that cost more than its reservation is counted in full', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const ledger = ledgerOn(journal, { fallback: { dailyUsd: 10, monthlyUsd: 100 } });
  const invite = { inviteId: 'inv_a' };
  assert.deepEqual(ledger.reserve(invite, 'k', 1), { ok: true });
  ledger.settle('k', 9.5);
  assert.equal(ledger.reserve(invite, 'next', 1).ok, false);
  // A key settled twice, or never reserved, adds nothing.
  ledger.settle('k', 0);
  ledger.settle('never', 50);
  assert.deepEqual(ledger.reserve(invite, 'small', 0.5), { ok: true });
});

test('a paused ledger refuses every reservation as unavailable, and resume allows again', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const paused = { on: true };
  const ledger = ledgerOn(journal, { fallback: BIG, paused });
  const refused = ledger.reserve({ inviteId: 'inv_a' }, 'k', 0.01);
  assert.deepEqual(refused, { ok: false, unavailable: true, reason: 'spending is paused' });
  assert.equal(ledger.reserve('server', 'k2', 0.01).ok, false);
  paused.on = false;
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_a' }, 'k3', 0.01), { ok: true });
  // The refused ones left no hold behind: the same key can be reserved.
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_a' }, 'k', 0.01), { ok: true });
});

test('a request with no valid cost is refused and held nowhere', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const ledger = ledgerOn(journal, { fallback: BIG });
  for (const usd of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(ledger.reserve({ inviteId: 'inv_a' }, 'k', usd).ok, false);
  }
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_a' }, 'k', 1), { ok: true });
});

test('a cap the ledger cannot read refuses instead of passing', async (t) => {
  const journal = new SqliteSpendJournal(await journalPath(t));
  t.after(() => journal.close());
  const unreadable = journal.accountLedger({
    limitsOf: () => ({ dailyUsd: Number.NaN, monthlyUsd: 1 }),
    serverDailyUsd: () => 10,
  });
  assert.equal(unreadable.reserve({ inviteId: 'inv_a' }, 'k', 0.01).ok, false);
  const noServerCap = journal.accountLedger({
    limitsOf: () => BIG,
    serverDailyUsd: () => Number.NaN,
  });
  assert.equal(noServerCap.reserve({ inviteId: 'inv_a' }, 'k2', 0.01).ok, false);
});

test("a ledger that throws refuses the request and releases the grant's hold", async (t) => {
  const broken: SpendAccounts = {
    reserve: () => {
      throw new Error('disk full');
    },
    settle: () => undefined,
  };
  const { gateway, upstream } = rig(t, broken);
  const calls: string[] = [];
  const grant = gateway.issue({
    vendor: 'anthropic',
    subject: 'tsk_broken',
    taskId: 'tsk_broken',
    budget: {
      reserve: () => {
        calls.push('reserve');
        return { ok: true };
      },
      settle: (_key, usd) => {
        calls.push(`settle ${usd}`);
      },
    },
    account: { inviteId: 'inv_a' },
  });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  const response = await send(gateway, found.grant);
  assert.equal(response.status, 503);
  assert.deepEqual(calls, ['reserve', 'settle 0']);
  assert.equal(upstream.requests.length, 0);
});
