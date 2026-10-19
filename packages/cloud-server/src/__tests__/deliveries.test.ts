import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { ConversationHandler } from '../cloud-server.js';
import { ConversationStore } from '../conversations.js';
import { openDatabase } from '../db.js';
import { MessageDeliveries, type PendingMessage } from '../deliveries.js';
import { FeedHub } from '../feed.js';
import { eventually, newConversation, postJson, startHarness } from './harness.js';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

/** A promise and the functions that settle it: one step of a handshake. */
function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Waits until `ready`, woken by `waiters`; fails after three seconds instead of hanging. */
async function arrival(ready: () => boolean, waiters: Array<() => void>, what: string) {
  const deadline = Date.now() + 3000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 20);
    });
  }
}

/** A handler whose every call waits for the test to settle it. */
function steppedHandler() {
  const calls: Array<{
    message: { conversationId: string; messageId: string; text: string };
    settle: Deferred;
  }> = [];
  const waiters: Array<() => void> = [];
  const handler: ConversationHandler = {
    onUserMessage(message) {
      const settle = deferred();
      calls.push({ message, settle });
      for (const wake of waiters.splice(0)) wake();
      return settle.promise;
    },
  };
  /** Resolves with call number `n` (1-based) once it was made; fails rather than hangs. */
  const call = async (n: number) => {
    await arrival(() => calls.length >= n, waiters, `handler call ${n}`);
    return calls[n - 1] as (typeof calls)[number];
  };
  return { handler, calls, call };
}

test('a message whose delivery fails is retried until the handler acknowledges it', async (t) => {
  const stepped = steppedHandler();
  const h = await startHarness(t, { handler: stepped.handler, delivery: { retryBaseMs: 5 } });
  const conversationId = await newConversation(h);
  const posted = await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'go' });
  assert.equal(posted.status, 202);
  (await stepped.call(1)).settle.reject(new Error('the conductor is restarting'));
  const second = await stepped.call(2);
  assert.equal(second.message.text, 'go');
  assert.equal(h.server.deliveryStats()?.pending, 1, 'still pending while unacknowledged');
  second.settle.resolve();
  await eventually(() => h.server.deliveryStats()?.pending === 0, 'acknowledged');
  assert.deepEqual(h.server.deliveryStats(), { pending: 0, inFlight: 0, timerArmed: false });
  assert.equal(stepped.calls.length, 2);
});

test('a retry with the same client id delivers a message whose first delivery failed', async (t) => {
  const stepped = steppedHandler();
  // The timer would only retry in a minute: the client's retry is what delivers it.
  const h = await startHarness(t, { handler: stepped.handler, delivery: { retryBaseMs: 60_000 } });
  const conversationId = await newConversation(h);
  const path = `/v1/conversations/${conversationId}/messages`;
  const body = { text: 'go', clientMessageId: 'client-1' };
  const first = (await (await postJson(h, path, body)).json()) as { messageId: string };
  (await stepped.call(1)).settle.reject(new Error('the conductor is restarting'));
  await eventually(() => h.server.deliveryStats()?.inFlight === 0, 'failed attempt settled');
  const again = (await (await postJson(h, path, body)).json()) as { messageId: string };
  assert.equal(again.messageId, first.messageId);
  const second = await stepped.call(2);
  assert.equal(second.message.messageId, first.messageId);
  second.settle.resolve();
  await eventually(() => h.server.deliveryStats()?.pending === 0, 'acknowledged');
  // Once delivered, a further retry of the post hands nothing over again.
  await postJson(h, path, body);
  assert.equal(stepped.calls.length, 2);
});

test('a crash between the commit and the delivery loses nothing: the next start delivers it', async (t) => {
  const stepped = steppedHandler();
  const h = await startHarness(t, { handler: stepped.handler });
  const conversationId = await newConversation(h);
  const posted = (await (
    await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'survive me' })
  ).json()) as { messageId: string };
  // The handler took the call and never acknowledged it: the process goes away.
  await stepped.call(1);
  const after = steppedHandler();
  await h.restart({ handler: after.handler });
  const redelivered = await after.call(1);
  assert.deepEqual(redelivered.message, {
    conversationId,
    messageId: posted.messageId,
    text: 'survive me',
  });
  redelivered.settle.resolve();
  await eventually(() => h.server.deliveryStats()?.pending === 0, 'acknowledged');
});

test('messages posted while no handler runs wait for the first server that has one', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'one' });
  await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'two' });
  const later = steppedHandler();
  await h.restart({ handler: later.handler });
  const first = await later.call(1);
  const second = await later.call(2);
  assert.deepEqual(
    [first.message.text, second.message.text],
    ['one', 'two'],
    'in the order they were posted',
  );
  first.settle.resolve();
  second.settle.resolve();
  await eventually(() => h.server.deliveryStats()?.pending === 0, 'acknowledged');
});

/** The delivery loop on its own, over a real database, so each way out can be checked. */
async function rig(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'deliveries-test-'));
  const db = openDatabase(join(dir, 'server.sqlite'));
  let n = 0;
  const conversations = new ConversationStore(db, new FeedHub(), () => ({
    sessionId: `ses_${n++}`,
    token: 'unused',
  }));
  const { conversationId } = conversations.create('inv_a');
  const calls: PendingMessage[] = [];
  const steps: Array<Deferred> = [];
  const warnings: string[] = [];
  const waiters: Array<() => void> = [];
  const deliveries = new MessageDeliveries(
    db,
    (message) => {
      calls.push(message);
      const step = deferred();
      steps.push(step);
      for (const wake of waiters.splice(0)) wake();
      return step.promise;
    },
    (message) => warnings.push(message),
    { retryBaseMs: 5 },
  );
  t.after(async () => {
    deliveries.stop();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const post = (text: string) => {
    const result = conversations.post(conversationId, text);
    if (!result.found) throw new Error('unreachable');
    return result.messageId;
  };
  const step = async (k: number) => {
    await arrival(() => steps.length >= k, waiters, `attempt ${k}`);
    return steps[k - 1] as Deferred;
  };
  return { db, deliveries, post, calls, step, warnings };
}

test('when the handler acknowledges, the delivery holds no attempt and no timer', async (t) => {
  const r = await rig(t);
  r.deliveries.kick(r.post('a'));
  (await r.step(1)).resolve();
  await r.deliveries.settled();
  assert.deepEqual(r.deliveries.stats(), { pending: 0, inFlight: 0, timerArmed: false });
});

test('when the handler fails, a timer retries it, and once acknowledged nothing is held', async (t) => {
  const r = await rig(t);
  r.deliveries.kick(r.post('a'));
  (await r.step(1)).reject(new Error('down'));
  await r.deliveries.settled();
  assert.equal(r.deliveries.stats().timerArmed, true);
  (await r.step(2)).resolve();
  await r.deliveries.settled();
  assert.deepEqual(r.deliveries.stats(), { pending: 0, inFlight: 0, timerArmed: false });
  assert.deepEqual(r.warnings, ['The conversation handler failed']);
});

test('when stopped while a retry waits, the timer is cleared and no attempt follows', async (t) => {
  const r = await rig(t);
  const id = r.post('a');
  r.deliveries.kick(id);
  (await r.step(1)).reject(new Error('down'));
  await r.deliveries.settled();
  assert.equal(r.deliveries.stats().timerArmed, true);
  r.deliveries.stop();
  assert.equal(r.deliveries.stats().timerArmed, false);
  r.deliveries.kick(id);
  assert.equal(r.calls.length, 1, 'a stopped delivery starts nothing');
  assert.equal(r.deliveries.stats().pending, 1, 'and the message stays for the next start');
});

test('when stopped during an attempt that is then acknowledged, it is recorded and nothing is held', async (t) => {
  const r = await rig(t);
  r.deliveries.kick(r.post('a'));
  const attempt = await r.step(1);
  r.deliveries.stop();
  attempt.resolve();
  await r.deliveries.settled();
  assert.deepEqual(r.deliveries.stats(), { pending: 0, inFlight: 0, timerArmed: false });
});

test('when stopped during an attempt that then fails, no retry is set and it stays pending', async (t) => {
  const r = await rig(t);
  r.deliveries.kick(r.post('a'));
  const attempt = await r.step(1);
  r.deliveries.stop();
  attempt.reject(new Error('down'));
  await r.deliveries.settled();
  assert.deepEqual(r.deliveries.stats(), { pending: 1, inFlight: 0, timerArmed: false });
  assert.deepEqual(r.warnings, [], 'a failure while stopping is not reported');
});

test('one attempt per message runs at a time, however often it is asked for', async (t) => {
  const r = await rig(t);
  const id = r.post('a');
  r.deliveries.kick(id);
  r.deliveries.kick(id);
  r.deliveries.start();
  const attempt = await r.step(1);
  assert.equal(r.calls.length, 1);
  attempt.resolve();
  await r.deliveries.settled();
  r.deliveries.kick(id);
  assert.equal(r.calls.length, 1, 'a delivered message is not handed over again');
});
