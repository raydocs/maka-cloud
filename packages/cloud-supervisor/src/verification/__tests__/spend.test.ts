import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONVERSATION, Gate, HOUR, tmpDb } from '../../__tests__/harness.js';
import { openDatabase } from '../../db.js';
import {
  Barrier,
  FakeBudget,
  FakeHost,
  allSupported,
  claimIdsOf,
  codingFiles,
  finishLater,
  finishTask,
  firstItem,
  itemsOf,
  verifyRig,
  world,
} from './harness.js';

/** Runs one clean check and returns what it reserved: the bound of a request of this size. */
async function boundOfOne(): Promise<number> {
  const w = world();
  codingFiles(w, 't1');
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  const [bound] = [...w.budget.reserved.values()];
  await r.stop();
  assert.ok(bound && bound > 0);
  return bound;
}

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

test('the model check reserves an upper bound first and settles to the cost the model reported', async () => {
  const w = world();
  codingFiles(w, 't1');
  w.openai.script = async (request) => ({
    output: {
      verdicts: claimIdsOf(request).map((claimId) => ({
        claimId,
        verdict: 'supported',
        reason: 'ok',
      })),
    },
    usage: usage(400, 50),
  });
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  const [[key, bound]] = [...w.budget.reserved.entries()];
  assert.match(key ?? '', /^ver_[0-9a-f]+:0:1$/);
  const actual = (400 * 1 + 50 * 5) / 1_000_000;
  assert.ok(actual < (bound ?? 0), 'the bound is above the real cost');
  assert.equal(w.budget.settled.get(key ?? ''), actual);
  assert.equal(
    r.supervisor.verifierSpentToday(),
    actual,
    'the day is charged what was spent, not the bound',
  );
  await r.stop();
});

test('a conversation out of budget gets no model call, an honest could-not-check, and no daily charge', async () => {
  const w = world();
  codingFiles(w, 't1');
  w.budget.refuse = true;
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  assert.equal(w.openai.requests.length, 0);
  assert.equal(itemsOf(r, 'finished').length, 0, 'never a silent pass');
  const [item] = itemsOf(r, 'verification_failed');
  assert.match(item?.ask ?? '', /budget is used up, so the model check did not run/);
  assert.match(item?.ask ?? '', /not verified/);
  assert.equal(r.supervisor.verifierSpentToday(), 0, 'the refused reservation was released');
  assert.equal(r.host.interrupts.length, 1);
  await r.stop();
});

test('a failure the evidence shows is still reported when the budget is gone, and spends nothing', async () => {
  const w = world();
  codingFiles(w, 't1', { result: 'failed' });
  w.budget.refuse = true;
  const r = await verifyRig(w, { settings: { verifierDailyCapUsd: 0 } });
  await finishTask(r, 't1');
  assert.match(itemsOf(r, 'verification_failed')[0]?.ask ?? '', /found 1 problem/);
  assert.equal(w.budget.reserveCalls, 0);
  assert.equal(w.openai.requests.length, 0);
  await r.stop();
});

test('a day that is over its cap ends the check as could not check, never calls the model, and never touches the conversation budget', async () => {
  const w = world();
  codingFiles(w, 't1');
  const r = await verifyRig(w, { settings: { verifierDailyCapUsd: 0 } });
  await finishTask(r, 't1');
  assert.equal(w.openai.requests.length, 0);
  assert.equal(w.budget.reserveCalls, 0, 'the cap is checked before the conversation budget');
  const item = await firstItem(r, (i) => i.kind === 'verification_failed');
  assert.match(item.ask, /daily limit for independent checks is used up/);

  // Raising the cap and checking again runs the model.
  r.supervisor.setSettings({ verifierDailyCapUsd: 5 });
  const result = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: 'again',
    optionId: 'again',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(result.ok, true);
  await r.supervisor.settled();
  assert.equal(w.openai.requests.length, 1);
  assert.equal(itemsOf(r, 'finished').length, 1);
  await r.stop();
});

test('the default cap is five dollars and a muted budget item still exists', async () => {
  const w = world();
  const r = await verifyRig(w);
  assert.equal(r.supervisor.getSettings().verifierDailyCapUsd, 5);
  assert.throws(() => r.supervisor.setSettings({ verifierDailyCapUsd: -1 }));
  assert.throws(() => r.supervisor.setSettings({ verifierDailyCapUsd: Number.NaN }));
  await r.stop();
});

test('two checks racing for the last of the cap reserve exactly once', async () => {
  const bound = await boundOfOne();
  const w = world();
  codingFiles(w, 'a');
  codingFiles(w, 'b');
  const barrier = new Barrier(2);
  w.evidence.onRead = async (_task, name) => {
    if (name === 'change.patch') await barrier.wait();
  };
  const hold = new Gate();
  const entered = new Gate();
  w.openai.script = async (request) => {
    entered.resolve();
    await hold.promise;
    return {
      output: {
        verdicts: claimIdsOf(request).map((claimId) => ({
          claimId,
          verdict: 'supported',
          reason: 'ok',
        })),
      },
      usage: usage(100, 10),
    };
  };
  const r = await verifyRig(w, { settings: { verifierDailyCapUsd: bound * 1.5 } });
  finishLater(r, 'a');
  finishLater(r, 'b');
  await entered.promise;
  // Both are past the barrier; one holds the reservation, the other was refused.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(w.budget.reserved.size, 1);
  hold.resolve();
  await r.supervisor.settled();
  assert.equal(w.openai.requests.length, 1);
  assert.equal(itemsOf(r, 'finished').length, 1);
  const [refused] = itemsOf(r, 'verification_failed');
  assert.match(refused?.ask ?? '', /daily limit/);
  await r.stop();
});

test('a conversation budget that refuses releases the daily reservation, so the next check can use it', async () => {
  const bound = await boundOfOne();
  const w = world();
  codingFiles(w, 'a');
  codingFiles(w, 'b');
  const r = await verifyRig(w, { settings: { verifierDailyCapUsd: bound * 1.5 } });
  w.budget.refuse = true;
  await finishTask(r, 'a');
  assert.equal(r.supervisor.verifierSpentToday(), 0);
  w.budget.refuse = false;
  await finishTask(r, 'b');
  assert.equal(itemsOf(r, 'finished').length, 1, 'the second check had the whole cap');
  await r.stop();
});

test('a budget port that throws releases the daily reservation and the check is retried', async () => {
  const w = world({ maxAttempts: 2, backoffMs: 1000 });
  codingFiles(w, 't1');
  w.budget.throwOnReserve = new Error('ledger unavailable');
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  assert.equal(r.supervisor.verifierSpentToday(), 0);
  assert.equal(w.openai.requests.length, 0);
  w.budget.throwOnReserve = undefined;
  r.clock.advance(2000);
  await r.supervisor.tick();
  await r.supervisor.settled();
  assert.equal(itemsOf(r, 'finished').length, 1);
  await r.stop();
});

test('a model that fails is charged at its reservation, since what it cost is unknown', async () => {
  const w = world({ maxAttempts: 1 });
  codingFiles(w, 't1');
  w.openai.script = async () => {
    throw new Error('provider error');
  };
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  const [[key, bound]] = [...w.budget.reserved.entries()];
  assert.equal(w.budget.settled.get(key ?? ''), bound);
  assert.equal(r.supervisor.verifierSpentToday(), bound);
  assert.match(itemsOf(r, 'verification_failed')[0]?.ask ?? '', /did not answer/);
  await r.stop();
});

test('a retried attempt is checked against both limits again', async () => {
  const bound = await boundOfOne();
  const w = world({ maxAttempts: 3, backoffMs: 1000 });
  codingFiles(w, 't1');
  let calls = 0;
  w.openai.script = async (request) => {
    calls += 1;
    if (calls === 1) throw new Error('provider error');
    return {
      output: {
        verdicts: claimIdsOf(request).map((claimId) => ({
          claimId,
          verdict: 'supported',
          reason: 'ok',
        })),
      },
      usage: usage(100, 10),
    };
  };
  // Room for one reservation, not for the failed attempt's charge plus another.
  const r = await verifyRig(w, { settings: { verifierDailyCapUsd: bound * 1.5 } });
  await finishTask(r, 't1');
  assert.equal(r.supervisor.verifierSpentToday(), bound);
  r.clock.advance(2000);
  await r.supervisor.tick();
  await r.supervisor.settled();
  assert.equal(calls, 1, 'the second attempt did not reach the model');
  assert.match(itemsOf(r, 'verification_failed')[0]?.ask ?? '', /daily limit/);
  assert.equal(w.budget.reserved.size, 1);

  // And the conversation budget is asked again for every attempt.
  const w2 = world({ maxAttempts: 3, backoffMs: 1000 });
  codingFiles(w2, 't1');
  let calls2 = 0;
  w2.openai.script = async (request) => {
    calls2 += 1;
    if (calls2 === 1) throw new Error('provider error');
    return {
      output: {
        verdicts: claimIdsOf(request).map((claimId) => ({
          claimId,
          verdict: 'supported',
          reason: 'ok',
        })),
      },
      usage: usage(1, 1),
    };
  };
  const r2 = await verifyRig(w2);
  await finishTask(r2, 't1');
  w2.budget.refuse = true;
  r2.clock.advance(2000);
  await r2.supervisor.tick();
  await r2.supervisor.settled();
  assert.equal(w2.budget.reserveCalls, 2);
  assert.equal(calls2, 1);
  assert.match(itemsOf(r2, 'verification_failed')[0]?.ask ?? '', /budget is used up/);
  await r.stop();
  await r2.stop();
});

test('the cap rolls over at the day boundary of the configured time zone, not of UTC', async () => {
  const bound = await boundOfOne();
  const supported = (request: Parameters<typeof claimIdsOf>[0]) => ({
    output: {
      verdicts: claimIdsOf(request).map((claimId) => ({
        claimId,
        verdict: 'supported',
        reason: 'ok',
      })),
    },
    usage: usage(1, 1),
  });
  /** 12:00 UTC is 21:00 the same day in Tokyo. A failed attempt uses most of the cap; then 3h10m pass. */
  const finishedAfterMidnightTokyo = async (timeZone: string) => {
    const w = world({ maxAttempts: 1 });
    codingFiles(w, 'a');
    codingFiles(w, 'b');
    const r = await verifyRig(w, { settings: { timeZone, verifierDailyCapUsd: bound * 1.5 } });
    w.openai.script = async () => {
      throw new Error('provider error');
    };
    await finishTask(r, 'a');
    assert.equal(r.supervisor.verifierSpentToday(), bound);
    w.openai.script = async (request) => supported(request);
    await finishTask(r, 'b');
    const refused = itemsOf(r, 'verification_failed').find((item) => item.taskId === 'b');
    assert.match(
      refused?.ask ?? '',
      /daily limit/,
      `${timeZone}: the second check is over the cap`,
    );
    r.clock.advance(3 * HOUR + 10 * 60_000);
    assert.equal(r.supervisor.getSettings().timeZone, timeZone);
    const item = refused as NonNullable<typeof refused>;
    await r.supervisor.answer({
      itemId: item.itemId,
      answerId: 'again',
      optionId: 'again',
      preconditionHash: item.preconditionHash,
    });
    await r.supervisor.settled();
    const finished = itemsOf(r, 'finished').filter((entry) => entry.taskId === 'b').length;
    await r.stop();
    return finished;
  };
  assert.equal(
    await finishedAfterMidnightTokyo('Asia/Tokyo'),
    1,
    'a new local day has its own cap',
  );
  assert.equal(
    await finishedAfterMidnightTokyo('UTC'),
    0,
    'the same UTC day is still over the cap',
  );
});

test('a restart between reserving and settling charges the stopped attempt once, at its reservation', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const w = world();
  codingFiles(w, 't1');
  const entered = new Gate();
  w.openai.script = (_request, signal) => {
    entered.resolve();
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('stopped'))),
    );
  };
  // The ledger is unreachable while the process goes down, so the settlement cannot be recorded.
  w.budget.throwOnSettle = new Error('ledger unavailable');
  const first = await verifyRig(w, { host, dbPath });
  finishLater(first, 't1');
  await entered.promise;
  const [[key, bound]] = [...w.budget.reserved.entries()];
  await first.stop();
  assert.equal(w.budget.settled.size, 0);

  // The next process finds the open reservation and settles it once, at the bound.
  const budget = new FakeBudget();
  budget.reserved.set(key ?? '', bound ?? 0);
  const w2 = { ...w, budget, options: { ...w.options, budget } };
  w2.openai.script = async (request) => ({
    output: {
      verdicts: claimIdsOf(request).map((claimId) => ({
        claimId,
        verdict: 'supported',
        reason: 'ok',
      })),
    },
    usage: usage(100, 10),
  });
  const second = await verifyRig(w2, { host, dbPath, clock: first.clock });
  await second.supervisor.tick();
  await second.supervisor.settled();
  assert.deepEqual(
    budget.settleCalls.filter(([k]) => k === key),
    [[key, bound]],
  );
  assert.equal(budget.settled.get(key ?? ''), bound);
  const rerun = [...budget.reserved.keys()].filter((k) => k !== key);
  assert.equal(rerun.length, 1);
  assert.match(rerun[0] ?? '', /:0:2$/, 'the re-run is attempt 2 under its own key');
  const expected = (bound ?? 0) + (100 * 1 + 10 * 5) / 1_000_000;
  assert.ok(Math.abs(second.supervisor.verifierSpentToday() - expected) < 1e-12);
  assert.equal(itemsOf(second, 'finished').length, 1);
  await second.stop();

  // A third start finds nothing open and settles nothing more.
  const third = await verifyRig(w2, { host, dbPath, clock: first.clock });
  await third.supervisor.tick();
  assert.deepEqual(budget.settleCalls.filter(([k]) => k === key).length, 1);
  await third.stop();
});

test('a reservation that was never armed made no request, so a restart releases it', async () => {
  const dbPath = tmpDb();
  const w = world();
  const first = await verifyRig(w, { dbPath });
  await first.stop();
  const day = new Date(first.clock.t).toISOString().slice(0, 10);
  const db = openDatabase(dbPath);
  db.prepare(
    "INSERT INTO verifier_spend (key, day, stage, usd, at) VALUES ('orphan', ?, 'reserve', 3, 0)",
  ).run(day);
  db.close();
  const second = await verifyRig(w, { dbPath, clock: first.clock });
  await second.supervisor.settled();
  assert.equal(
    second.supervisor.verifierSpentToday(),
    0,
    'released at the start, not held for the day',
  );
  assert.deepEqual(w.budget.settleCalls, [['orphan', 0]]);
  await second.stop();
});

test('the spend ledger is append-only', async () => {
  const dbPath = tmpDb();
  const w = world();
  codingFiles(w, 't1');
  const r = await verifyRig(w, { dbPath });
  await finishTask(r, 't1');
  await r.stop();
  const db = openDatabase(dbPath);
  try {
    assert.throws(() => db.exec('UPDATE verifier_spend SET usd = 0'), /append-only/);
    assert.throws(() => db.exec('DELETE FROM verifier_spend'), /append-only/);
    const rows = db.prepare('SELECT stage FROM verifier_spend ORDER BY id').all() as Array<{
      stage: string;
    }>;
    assert.deepEqual(
      rows.map((row) => row.stage),
      ['reserve', 'armed', 'settle'],
    );
  } finally {
    db.close();
  }
});

test('dense text is bounded by its UTF-8 bytes, so the reservation covers a tokenizer that spends a token per byte', async () => {
  const w = world();
  // 20000 CJK characters are 60000 bytes; half a token per character would be 10000 tokens.
  codingFiles(w, 't1', { patch: `+${'漢'.repeat(20_000)}\n` });
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  const request = w.openai.requests[0];
  assert.ok(request);
  const bytes = Buffer.byteLength(request.instructions) + Buffer.byteLength(request.prompt);
  assert.ok(bytes > 60_000, `the request is dense: ${bytes} bytes`);
  const [bound] = [...w.budget.reserved.values()];
  const floor = (bytes * 1 + request.maxOutputTokens * 5) / 1_000_000;
  assert.ok((bound ?? 0) >= floor, `reserved ${bound}, a token per byte is ${floor}`);
  await r.stop();
});

test('a price or limit that gives no safe bound refuses the model check: no call, nothing reserved, nothing charged', async () => {
  for (const price of [
    { inputPerMTokUsd: Number.NaN, outputPerMTokUsd: 5 },
    { inputPerMTokUsd: 1, outputPerMTokUsd: Number.POSITIVE_INFINITY },
    { inputPerMTokUsd: -1, outputPerMTokUsd: 5 },
  ]) {
    const w = world();
    codingFiles(w, 't1');
    (w.openai as { price: typeof price }).price = price;
    const r = await verifyRig(w);
    await finishTask(r, 't1');
    const label = JSON.stringify(price);
    assert.equal(w.openai.requests.length, 0, label);
    assert.equal(w.budget.reserveCalls, 0, label);
    assert.equal(r.supervisor.verifierSpentToday(), 0, label);
    assert.equal(itemsOf(r, 'finished').length, 0, label);
    assert.match(itemsOf(r, 'verification_failed')[0]?.ask ?? '', /could not be bounded/, label);
    await r.stop();
  }

  const w = world();
  codingFiles(w, 't1');
  (w.openai as { maxOutputTokens: number }).maxOutputTokens = Number.NaN;
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  assert.equal(w.openai.requests.length, 0);
  assert.equal(w.budget.reserveCalls, 0);
  assert.match(itemsOf(r, 'verification_failed')[0]?.ask ?? '', /could not be bounded/);
  await r.stop();
});

test('a metered model reserves its own request through both limits and is charged only what it settled', async () => {
  const w = world();
  codingFiles(w, 't1');
  w.openai.metered = true;
  w.openai.script = async (request, _signal, charge) => {
    assert.ok(charge, 'a metered model is given the charge');
    assert.equal(charge.conversationId, CONVERSATION, 'the charge names whose spend it is');
    assert.equal(charge.reserve(0.02), undefined);
    charge.settle(0.005);
    return { ...allSupported(request), usage: usage(9_999_999, 9_999_999) };
  };
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  const [[key, reserved]] = [...w.budget.reserved.entries()];
  assert.equal(reserved, 0.02, 'the reservation is the model’s own, not the supervisor’s estimate');
  assert.deepEqual(w.budget.settleCalls, [[key, 0.005]], 'settled once, by the model');
  assert.equal(r.supervisor.verifierSpentToday(), 0.005);
  assert.equal(itemsOf(r, 'finished').length, 1);
  await r.stop();
});

test('a metered model refused by the conversation budget ends the check as a budget matter', async () => {
  const w = world();
  codingFiles(w, 't1');
  w.budget.refuse = true;
  w.openai.metered = true;
  w.openai.script = async (_request, _signal, charge) => {
    if (charge?.reserve(0.02) !== undefined) throw new Error('refused');
    throw new Error('unreachable');
  };
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  const [item] = itemsOf(r, 'verification_failed');
  assert.match(item?.ask ?? '', /budget is used up, so the model check did not run/);
  assert.equal(r.supervisor.verifierSpentToday(), 0, 'the refused reservation was released');
  assert.equal(w.budget.settleCalls.length, 0);
  await r.stop();
});

test('a metered model that fails after settling is not charged again at a bound', async () => {
  const w = world({ maxAttempts: 1 });
  codingFiles(w, 't1');
  w.openai.metered = true;
  w.openai.script = async (_request, _signal, charge) => {
    charge?.reserve(0.02);
    charge?.settle(0);
    throw new Error('provider error');
  };
  const r = await verifyRig(w);
  await finishTask(r, 't1');
  const [[key]] = [...w.budget.reserved.entries()];
  assert.deepEqual(w.budget.settleCalls, [[key, 0]]);
  assert.equal(r.supervisor.verifierSpentToday(), 0);
  assert.match(itemsOf(r, 'verification_failed')[0]?.ask ?? '', /did not answer/);
  await r.stop();
});
