import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { Gateway, type SpendJournal, SqliteSpendJournal } from '../index.js';
import { worstCaseUsd } from '../pricing.js';
import {
  anthropicStream,
  ControlledBody,
  FakeUpstream,
  sse,
  anthropicStart,
} from './fake-upstream.js';

const OPUS = {
  vendor: 'anthropic',
  model: 'claude-opus-5-5',
  inputPerMTokUsd: 4,
  outputPerMTokUsd: 20,
  cacheReadPerMTokUsd: 0.2,
  maxOutputTokens: 128_000,
} as const;

async function journalPath(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-journal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'spend.db');
}

function rig(journal: SpendJournal) {
  const upstream = new FakeUpstream();
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: 'sk-master-0123456789' } },
    limits: { requestOverheadTokens: 0 },
    fetch: upstream.fetch,
    journal,
  });
  return { gateway, upstream };
}

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

test('a request in flight when the process stops is charged in full to its task by the next one', async (t) => {
  const path = await journalPath(t);
  const before = new SqliteSpendJournal(path);
  const { gateway, upstream } = rig(before);
  const grant = gateway.issue({
    vendor: 'anthropic',
    subject: 'tsk_crash',
    taskId: 'tsk_crash',
    budget: { limitUsd: 1 },
  });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  // One request that settles, then one still streaming when the process "stops".
  upstream.next(() => anthropicStream(100, 10));
  const first = await gateway.handle(found.grant, 'messages', new Headers(), encoded);
  await first.text();
  const settled = grant.spend().spentUsd;
  assert.ok(settled > 0);
  let open: ControlledBody | undefined;
  upstream.next((seen) => {
    open = new ControlledBody(seen.signal);
    open.push(sse([anthropicStart({ input_tokens: 40, output_tokens: 1 })]));
    return new Response(open.stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const second = await gateway.handle(found.grant, 'messages', new Headers(), encoded);
  const reader = (second.body as ReadableStream<Uint8Array>).getReader();
  await reader.read();

  // The next process reads what this one wrote, without this one closing anything.
  const after = new SqliteSpendJournal(path);
  t.after(() => after.close());
  const unrecorded = after.unrecorded();
  assert.equal(unrecorded.length, 1);
  assert.equal(unrecorded[0]?.taskId, 'tsk_crash');
  assert.ok(Math.abs((unrecorded[0]?.usd ?? 0) - (settled + reservation)) < 1e-9);
  after.recorded();
  assert.deepEqual(after.unrecorded(), []);

  gateway.close();
  await open?.aborted;
  before.close();
});

test('a reservation the journal cannot write is released and the request is never sent', async (t) => {
  const failing: SpendJournal = {
    hold: () => {
      throw new Error('disk full');
    },
    settle: () => undefined,
  };
  const { gateway, upstream } = rig(failing);
  t.after(() => gateway.close());
  const grant = gateway.issue({
    vendor: 'anthropic',
    subject: 'tsk_full',
    taskId: 'tsk_full',
    budget: { limitUsd: reservation * 1.5 },
  });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await gateway.handle(found.grant, 'messages', new Headers(), encoded);
    assert.equal(response.status, 503, await response.clone().text());
    assert.match(await response.text(), /could not be recorded/u);
  }
  assert.equal(upstream.requests.length, 0);
  assert.equal(grant.spend().spentUsd, 0, 'the refused reservation was released, not kept');
});

test('a web search is written down the same way', async (t) => {
  const path = await journalPath(t);
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let answer: (() => void) | undefined;
  const gateway = new Gateway({
    upstreams: { anthropic: { apiKey: 'sk-master-0123456789' } },
    search: {
      provider: {
        search: () =>
          new Promise((resolve) => {
            answer = () => resolve({ ok: true, hits: [], billed: true });
          }),
      },
      callUsd: 0.001,
    },
    journal,
  });
  t.after(() => gateway.close());
  const grant = gateway.issue({
    vendor: 'anthropic',
    subject: 'tsk_search',
    taskId: 'tsk_search',
    budget: { limitUsd: 1 },
  });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  const searching = gateway.search(
    found.grant,
    new TextEncoder().encode(JSON.stringify({ query: 'tides' })),
  );
  const next = new SqliteSpendJournal(path);
  t.after(() => next.close());
  assert.deepEqual(next.unrecorded(), [{ taskId: 'tsk_search', usd: 0.001 }]);
  answer?.();
  await searching;
  assert.deepEqual(next.unrecorded(), [{ taskId: 'tsk_search', usd: 0.001 }]);
});
