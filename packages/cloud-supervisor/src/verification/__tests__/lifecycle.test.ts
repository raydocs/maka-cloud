import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gate, MINUTE, tmpDb } from '../../__tests__/harness.js';
import { openDatabase } from '../../db.js';
import { Store } from '../../store.js';
import {
  FakeHost,
  claimIdsOf,
  codingFiles,
  finishLater,
  finishTask,
  itemsOf,
  manifestOf,
  researchFiles,
  researchManifest,
  verifyRig,
  world,
} from './harness.js';

const supported = (request: Parameters<typeof claimIdsOf>[0]) => ({
  output: {
    verdicts: claimIdsOf(request).map((claimId) => ({
      claimId,
      verdict: 'supported',
      reason: 'ok',
    })),
  },
  usage: { inputTokens: 100, outputTokens: 10 },
});

test('at most the configured number of checks run at once; the rest start as slots free up', async () => {
  const w = world({ concurrency: 2 });
  for (const id of ['a', 'b', 'c']) codingFiles(w, id);
  const holds: Gate[] = [];
  const entered: Gate[] = [new Gate(), new Gate(), new Gate()];
  let calls = 0;
  w.openai.script = async (request) => {
    const index = calls++;
    holds[index] = new Gate();
    entered[index]?.resolve();
    await holds[index]?.promise;
    return supported(request);
  };
  const r = await verifyRig(w);
  for (const id of ['a', 'b', 'c']) finishLater(r, id);
  await entered[0]?.promise;
  await entered[1]?.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, 'the third waits for a slot');
  assert.equal(r.supervisor.stats().verifications, 2);
  holds[0]?.resolve();
  await entered[2]?.promise;
  assert.equal(calls, 3);
  holds[1]?.resolve();
  holds[2]?.resolve();
  await r.supervisor.settled();
  assert.equal(w.openai.maxInflight, 2);
  assert.equal(itemsOf(r, 'finished').length, 3);
  assert.equal(r.supervisor.stats().verifications, 0);
  await r.stop();
});

test('stop during the model call aborts it, releases the slot, and the next start finishes the check once', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const w = world();
  codingFiles(w, 't1');
  const entered = new Gate();
  let sawAbort = false;
  w.openai.script = (_request, signal) => {
    entered.resolve();
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('stopped'));
      }),
    );
  };
  const first = await verifyRig(w, { host, dbPath });
  finishLater(first, 't1');
  await entered.promise;
  await first.stop();
  assert.equal(sawAbort, true);
  assert.deepEqual(first.supervisor.stats(), {
    inflight: 0,
    feedSubscriptions: 0,
    timers: 0,
    verifications: 0,
  });

  w.openai.script = async (request) => supported(request);
  const second = await verifyRig(w, { host, dbPath, clock: first.clock });
  await second.supervisor.settled();
  assert.equal(itemsOf(second, 'finished').length, 1);
  assert.equal(itemsOf(second, 'verification_failed').length, 0);
  assert.equal(w.openai.requests.length, 2, 'the stopped request and the finished one');
  await second.stop();
});

test('stop while evidence is being read, or a source fetched, aborts them', async () => {
  const w = world();
  researchFiles(w, 't1');
  const reading = new Gate();
  let readAborted = false;
  w.evidence.onRead = (_task, _name, signal) => {
    reading.resolve();
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => {
        readAborted = true;
        resolve();
      }),
    );
  };
  const a = await verifyRig(w);
  finishLater(a, 't1', researchManifest(), { runner: 'codex' });
  await reading.promise;
  await a.stop();
  assert.equal(readAborted, true);
  assert.equal(a.supervisor.stats().verifications, 0);
  assert.equal(w.evidence.reads.length, 1, 'no further artifact is read once stopped');

  const w2 = world();
  researchFiles(w2, 't1');
  const fetching = new Gate();
  let fetchAborted = false;
  w2.fetcher.fetchText = (_url: string, signal?: AbortSignal) => {
    fetching.resolve();
    return new Promise((resolve) =>
      signal?.addEventListener('abort', () => {
        fetchAborted = true;
        resolve({ ok: false, reason: 'aborted', detail: 'stopped' });
      }),
    );
  };
  const b = await verifyRig(w2);
  finishLater(b, 't1', researchManifest(), { runner: 'codex' });
  await fetching.promise;
  await b.stop();
  assert.equal(fetchAborted, true);
  assert.equal(b.supervisor.stats().verifications, 0);
});

test('a check that outlives its deadline is aborted, releases its slot, and is retried', async () => {
  const w = world({ deadlineMs: 15, maxAttempts: 2, backoffMs: 1000 });
  codingFiles(w, 't1');
  let aborted = 0;
  w.openai.script = (_request, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => {
        aborted += 1;
        reject(new Error('deadline'));
      }),
    );
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  assert.equal(aborted, 1);
  assert.equal(r.supervisor.stats().verifications, 0);
  assert.equal(itemsOf(r, 'verification_failed').length, 0, 'the first attempt is retried quietly');
  r.clock.advance(2000);
  await r.supervisor.tick();
  await r.supervisor.settled();
  assert.equal(aborted, 2);
  const [item] = itemsOf(r, 'verification_failed');
  assert.match(item?.ask ?? '', /could not be completed/);
  assert.equal(r.supervisor.stats().verifications, 0);
  await r.stop();
});

test('a model that throws, and an evidence source that throws, each end with the slot free', async () => {
  const w = world({ maxAttempts: 1 });
  codingFiles(w, 'a');
  codingFiles(w, 'b');
  w.openai.script = async () => {
    throw new Error('boom');
  };
  w.evidence.set('b', 'change.patch', { throws: new Error('storage down') });
  const r = await verifyRig(w);
  await finishTask(r, 'a');
  await finishTask(r, 'b');
  assert.equal(itemsOf(r, 'verification_failed').length, 2);
  assert.equal(r.supervisor.stats().verifications, 0);
  await r.stop();
});

test('a pending retry survives a restart and runs when it is due, once', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const w = world({ maxAttempts: 3, backoffMs: 60_000 });
  codingFiles(w, 't1');
  w.evidence.set('t1', 'change.patch', { fail: 'unavailable' });
  const first = await verifyRig(w, { host, dbPath });
  await finishTask(first, 't1');
  await first.stop();

  codingFiles(w, 't1');
  const second = await verifyRig(w, { host, dbPath, clock: first.clock });
  await second.supervisor.tick();
  assert.equal(w.openai.requests.length, 0, 'not yet due');
  second.clock.advance(61_000);
  await second.supervisor.tick();
  await second.supervisor.settled();
  assert.equal(w.openai.requests.length, 1);
  assert.equal(itemsOf(second, 'finished').length, 1);
  await second.supervisor.tick();
  assert.equal(w.openai.requests.length, 1);
  await second.stop();
});

test('with no verification option, a finished task is shown as finished at once, as before', async () => {
  const { rig } = await import('../../__tests__/harness.js');
  const r = await rig();
  await finishTask(r, 't1', manifestOf());
  const [finished] = itemsOf(r, 'finished');
  assert.doesNotMatch(finished?.ask ?? '', /independently/);
  assert.equal(r.supervisor.stats().verifications, 0);
  await r.stop();
});

test('stop does not wait for a model client that ignores the abort; the attempt is charged at its reservation and runs again at the next start', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const w = world();
  codingFiles(w, 't1');
  const entered = new Gate();
  const release = new Gate();
  w.openai.script = async (request) => {
    entered.resolve();
    await release.promise; // a model client that never looks at the signal
    return supported(request);
  };
  const first = await verifyRig(w, { host, dbPath });
  finishLater(first, 't1');
  await entered.promise;
  await first.stop();
  const [[key, bound]] = [...w.budget.reserved.entries()];
  assert.equal(w.budget.settled.get(key ?? ''), bound, 'charged at the reservation');
  release.resolve(); // the late answer finds nothing to write to
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    host.warnings.filter((message) => message.includes('failed unexpectedly')).length,
    0,
  );

  w.openai.script = async (request) => supported(request);
  const second = await verifyRig(w, { host, dbPath, clock: first.clock });
  await second.supervisor.settled();
  assert.equal(
    w.openai.requests.length,
    2,
    'the late answer was not recorded, so the check ran again',
  );
  assert.equal(itemsOf(second, 'finished').length, 1);
  assert.equal(
    second.supervisor.verifierSpentToday(),
    (bound ?? 0) + (100 * 1 + 10 * 5) / 1_000_000,
  );
  await second.stop();
});

test('a task has one verification: claiming it again does nothing, whatever its kind', () => {
  const store = new Store(openDatabase(':memory:'));
  const task = { taskId: 't1', conversationId: 'cnv_1' };
  assert.equal(store.enqueueVerification(task, 'coding', 1), true);
  assert.equal(store.enqueueVerification(task, 'research', 2), false);
  assert.equal(store.enqueueVerification(task, 'none', 3), false);
  assert.equal(store.verification('t1')?.kind, 'coding');
  assert.equal(store.claimDueVerifications(10, 5).length, 1);
  assert.equal(
    store.claimDueVerifications(10, 5).length,
    0,
    'a running check is not claimed again',
  );
  store.db.close();
});

void MINUTE;
