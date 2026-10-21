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
  // The settled call is spend; the one in flight is a call the process died in, charged in full.
  assert.equal(unrecorded[0]?.cutOffCalls, 1);
  assert.ok(Math.abs((unrecorded[0]?.cutOffUsd ?? 0) - reservation) < 1e-9);
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
  assert.deepEqual(next.unrecorded(), [
    { taskId: 'tsk_search', usd: 0.001, cutOffCalls: 1, cutOffUsd: 0.001 },
  ]);
  answer?.();
  await searching;
  assert.deepEqual(next.unrecorded(), [
    { taskId: 'tsk_search', usd: 0.001, cutOffCalls: 0, cutOffUsd: 0 },
  ]);
});

test('a call settled twice is charged once, and a process that was replaced cannot settle what the next one recorded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'journal-settle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spend.db');
  const first = new SqliteSpendJournal(path);
  first.hold('tsk_a', 'k1', 0.5);
  first.hold('tsk_a', 'k2', 0.5);
  first.settle('tsk_a', 'k1', 0.2);
  first.settle('tsk_a', 'k1', 0.2);
  first.settle('tsk_a', 'k1', 0.4);

  // A new process takes over: k2 is a call the first one died in, charged at its reservation.
  const second = new SqliteSpendJournal(path);
  t.after(() => second.close());
  assert.deepEqual(second.unrecorded(), [
    { taskId: 'tsk_a', usd: 0.7, cutOffCalls: 1, cutOffUsd: 0.5 },
  ]);
  second.recorded();
  // The first process, still alive, finishes k2 for less: that does not change what was charged.
  first.settle('tsk_a', 'k2', 0.01);
  first.close();
  assert.deepEqual(second.unrecorded(), []);
  const third = new SqliteSpendJournal(path);
  t.after(() => third.close());
  assert.deepEqual(third.unrecorded(), []);
});

test('spend is kept by the attempt of the task that spent it, and a journal made before attempts moves over', async (t) => {
  const path = await journalPath(t);
  const before = new SqliteSpendJournal(path);
  before.hold('tsk_a', 'k1', 1, 1);
  before.settle('tsk_a', 'k1', 0.75);
  before.hold('tsk_a', 'k2', 2, 2);
  before.settle('tsk_a', 'k2', 1.5);
  before.hold('tsk_a', 'k3', 0.5, 2);
  before.hold('tsk_a', 'k4', 0.25);
  before.settle('tsk_a', 'k4', 0.25);
  const after = new SqliteSpendJournal(path);
  t.after(() => after.close());
  assert.deepEqual(
    after.unrecorded().map(({ taskId, attempt, usd, cutOffCalls }) => ({
      taskId,
      attempt,
      usd,
      cutOffCalls,
    })),
    [
      { taskId: 'tsk_a', attempt: undefined, usd: 0.25, cutOffCalls: 0 },
      { taskId: 'tsk_a', attempt: 1, usd: 0.75, cutOffCalls: 0 },
      { taskId: 'tsk_a', attempt: 2, usd: 2, cutOffCalls: 1 },
    ],
  );
  before.close();
});

test('a journal made before spend was kept by attempt is read as spend of an unknown attempt', async (t) => {
  const path = await journalPath(t);
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE spent (
      epoch TEXT NOT NULL,
      task_id TEXT NOT NULL,
      usd REAL NOT NULL,
      PRIMARY KEY (epoch, task_id)
    );
    INSERT INTO spent (epoch, task_id, usd) VALUES ('dead-process', 'tsk_old', 3.4);
  `);
  old.close();
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  assert.deepEqual(
    journal.unrecorded().map(({ taskId, attempt, usd }) => ({ taskId, attempt, usd })),
    [{ taskId: 'tsk_old', attempt: undefined, usd: 3.4 }],
  );
  journal.hold('tsk_old', 'k', 1, 3);
  journal.settle('tsk_old', 'k', 1);
  const again = new SqliteSpendJournal(path);
  t.after(() => again.close());
  assert.equal(again.unrecorded().length, 2, 'opening it again does not move it twice');
});

test('a grant issued with an attempt writes it down with every reservation', async (t) => {
  const path = await journalPath(t);
  const before = new SqliteSpendJournal(path);
  const { gateway, upstream } = rig(before);
  const grant = gateway.issue({
    vendor: 'anthropic',
    subject: 'tsk_att',
    taskId: 'tsk_att',
    attempt: 4,
    budget: { limitUsd: 1 },
  });
  const found = gateway.authenticate(grant.token);
  assert.ok(found);
  upstream.next(() => anthropicStream(100, 10));
  await (await gateway.handle(found.grant, 'messages', new Headers(), encoded)).text();
  const after = new SqliteSpendJournal(path);
  t.after(() => after.close());
  assert.deepEqual(
    after.unrecorded().map(({ taskId, attempt }) => ({ taskId, attempt })),
    [{ taskId: 'tsk_att', attempt: 4 }],
  );
  gateway.close();
  before.close();
});
