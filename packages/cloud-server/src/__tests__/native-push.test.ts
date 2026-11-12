import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { CloudServerOptions, SupervisorParts } from '../cloud-server.js';
import type { ExpoMessage, ExpoReceipt, ExpoTicket, ExpoTransport } from '../native-push.js';
import { recordingHandler } from './conductor.js';
import { eventually, type Harness, postJson, startHarness } from './harness.js';
import type { InboxService } from '../inbox.js';

const idle: InboxService = {
  list: async () => ({ items: [], next: null }),
  answer: async () => ({ ok: false, reason: 'not_found' }),
  setMute: () => ({ ok: false }),
  settings: () => ({}),
  updateSettings: () => ({ ok: false }),
  digest: async () => ({}),
  stop: async () => undefined,
};

let counter = 0;
const newToken = () => `ExponentPushToken[device${String(++counter).padStart(6, '0')}abc]`;

function fakeExpo() {
  const sent: ExpoMessage[] = [];
  const asked: string[][] = [];
  const state: {
    ticket: (message: ExpoMessage) => ExpoTicket;
    receipt: (id: string) => ExpoReceipt | undefined;
    fail: boolean;
  } = {
    ticket: (message) => ({ status: 'ok', id: `ticket-${message.to}-${sent.length}` }),
    receipt: () => undefined,
    fail: false,
  };
  const transport: ExpoTransport = {
    async send(messages) {
      if (state.fail) throw new Error('down');
      sent.push(...messages);
      return messages.map((message) => state.ticket(message));
    },
    async receipts(ids) {
      asked.push(ids);
      const out: Record<string, ExpoReceipt> = {};
      for (const id of ids) {
        const receipt = state.receipt(id);
        if (receipt) out[id] = receipt;
      }
      return out;
    },
  };
  return { transport, sent, asked, state };
}

async function setup(
  t: TestContext,
  native: Partial<NonNullable<CloudServerOptions['nativePush']>> | false = {},
) {
  const { handler, seen } = recordingHandler();
  const expo = fakeExpo();
  let parts: SupervisorParts | undefined;
  const h = await startHarness(t, {
    handler,
    ...(native === false
      ? {}
      : { nativePush: { transport: expo.transport, retryDelayMs: 1, ...native } }),
    supervisor: (given) => {
      parts = given;
      return idle;
    },
  });
  /** A conversation of the invite behind `token`, and a task in it that ends. */
  const conversationOf = async (token = h.token) => {
    const res = await postJson(h, '/v1/conversations', {}, token);
    const { conversationId } = (await res.json()) as { conversationId: string };
    await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'go' }, token);
    await eventually(() => seen.has(conversationId), 'handler call');
    const session = h.server.orchestrator.authenticate(
      seen.get(conversationId)?.rotateToken() ?? '',
    );
    assert.ok(session);
    const finish = async (brief = 'secret plan for the launch') => {
      const before = h.fake.runs.length;
      const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief });
      await eventually(() => h.fake.runs.length > before, 'run');
      await h.fake.runFor(task.taskId).complete();
      await h.server.orchestrator.wait(session, task.taskId, 2000);
      return task.taskId;
    };
    return { conversationId, finish };
  };
  return { h, expo, parts: parts as SupervisorParts, conversationOf, seen };
}

const register = (h: Harness, token: string, as?: string, platform = 'ios') =>
  postJson(h, '/v1/push/devices', { token, platform }, as);
const unregister = (h: Harness, token: string, as?: string) =>
  h.api('/v1/push/devices', {
    method: 'DELETE',
    body: JSON.stringify({ token }),
    ...(as === undefined ? {} : { token: as }),
  });
const accountOf = async (h: Harness, token = h.token) =>
  ((await (await h.api('/v1/me', { token })).json()) as { accountTag: string }).accountTag;
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('while native push is off its route is 404 and nothing reaches the Expo push service', async (t) => {
  const expoCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('exp.host')) expoCalls.push(url);
    return realFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { h, parts, conversationOf } = await setup(t, false);
  assert.equal((await register(h, newToken())).status, 404);
  assert.equal((await unregister(h, newToken())).status, 404);
  const { conversationId, finish } = await conversationOf();
  await finish();
  parts.notifyDevices([{ itemId: 'item-1', conversationId, kind: 'approval' }]);
  await settle();
  assert.deepEqual(expoCalls, []);
});

test('a device token is checked, kept once, capped per invite, and removed only by its invite', async (t) => {
  const { h } = await setup(t);
  const other = h.server.invites.create('other');
  assert.equal((await register(h, 'not-a-token')).status, 400);
  assert.equal((await register(h, 'ExponentPushToken[x]', undefined, 'web')).status, 400);
  assert.equal((await register(h, 'ExponentPushToken[short]')).status, 400);
  const token = newToken();
  const created = await register(h, token);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { accountTag: await accountOf(h) });
  assert.equal((await register(h, token, undefined, 'android')).status, 200);
  assert.equal((await unregister(h, token, other.token)).status, 404);
  assert.equal((await unregister(h, token)).status, 204);
  assert.equal((await unregister(h, token)).status, 404);
  for (let i = 0; i < 10; i += 1) assert.equal((await register(h, newToken())).status, 201);
  assert.equal((await register(h, newToken())).status, 429);
  assert.equal((await register(h, newToken(), other.token)).status, 201);
});

test('a finished task tells the device with fixed words and ids, never what the task was about', async (t) => {
  const { h, expo, conversationOf } = await setup(t);
  const token = newToken();
  await register(h, token);
  const { conversationId, finish } = await conversationOf();
  const taskId = await finish('secret plan for the launch');
  await eventually(() => expo.sent.length === 1, 'one message');
  assert.deepEqual(expo.sent[0], {
    to: token,
    title: '后台任务已完成',
    body: '打开 Maka 查看结果。',
    data: {
      type: 'task.finished',
      accountTag: await accountOf(h),
      conversationId,
      taskId,
      state: 'succeeded',
    },
    categoryId: 'finished',
    sound: 'default',
    priority: 'default',
    ttl: 86400,
  });
  assert.ok(!JSON.stringify(expo.sent).includes('secret'));
});

test('an item that needs the person is pushed once with its id; items that do not need them are not', async (t) => {
  const { h, expo, parts, conversationOf } = await setup(t);
  const token = newToken();
  await register(h, token);
  const { conversationId } = await conversationOf();
  parts.notifyDevices([
    { itemId: 'item-approval', conversationId, kind: 'approval' },
    { itemId: 'item-done', conversationId, kind: 'finished' },
    { itemId: 'item-idea', conversationId, kind: 'suggestion' },
  ]);
  parts.notifyDevices([{ itemId: 'item-decision', conversationId, kind: 'decision' }]);
  // The supervisor asking again for the same item sends nothing more.
  parts.notifyDevices([{ itemId: 'item-approval', conversationId, kind: 'approval' }]);
  await eventually(() => expo.sent.length === 2, 'two messages');
  await settle();
  assert.equal(expo.sent.length, 2);
  const [approval, decision] = expo.sent;
  assert.deepEqual(approval, {
    to: token,
    title: '有一项决定在等你',
    body: '打开 Maka 作答。',
    data: {
      type: 'inbox.needed',
      accountTag: await accountOf(h),
      conversationId,
      itemId: 'item-approval',
      kind: 'approval',
    },
    categoryId: 'approval',
    sound: 'default',
    priority: 'high',
    ttl: 86400,
  });
  assert.equal(decision?.data.itemId, 'item-decision');
  assert.equal(decision?.categoryId, 'decision');
});

test("each invite's devices hear only about its own conversations, and a revoked invite hears nothing", async (t) => {
  const { h, expo, parts, conversationOf } = await setup(t);
  const second = h.server.invites.create('second');
  const gone = h.server.invites.create('gone');
  const mine = newToken();
  const theirs = newToken();
  const goneToken = newToken();
  await register(h, mine);
  await register(h, theirs, second.token);
  await register(h, goneToken, gone.token);
  const a = await conversationOf();
  const b = await conversationOf(second.token);
  const c = await conversationOf(gone.token);
  h.server.invites.revoke(gone.inviteId);
  const aTask = await a.finish();
  const bTask = await b.finish();
  parts.notifyDevices([
    { itemId: 'a-item', conversationId: a.conversationId, kind: 'decision' },
    { itemId: 'b-item', conversationId: b.conversationId, kind: 'approval' },
    { itemId: 'c-item', conversationId: c.conversationId, kind: 'approval' },
  ]);
  await eventually(() => expo.sent.length === 4, 'four messages');
  await settle();
  const to = (token: string) =>
    expo.sent.filter((m) => m.to === token).map((m) => m.data.taskId ?? m.data.itemId);
  assert.deepEqual(to(mine).sort(), [aTask, 'a-item'].sort());
  assert.deepEqual(to(theirs).sort(), [bTask, 'b-item'].sort());
  assert.deepEqual(to(goneToken), []);
  assert.notEqual(
    expo.sent.find((m) => m.to === mine)?.data.accountTag,
    expo.sent.find((m) => m.to === theirs)?.data.accountTag,
  );
});

test('a device that moves to another invite hears nothing of the old invite, before or after', async (t) => {
  const { h, expo, parts, conversationOf } = await setup(t);
  const second = h.server.invites.create('second');
  const token = newToken();
  await register(h, token);
  const a = await conversationOf();
  const b = await conversationOf(second.token);
  assert.equal((await register(h, token, second.token)).status, 200);
  await a.finish();
  parts.notifyDevices([
    { itemId: 'old-owner', conversationId: a.conversationId, kind: 'decision' },
  ]);
  parts.notifyDevices([
    { itemId: 'new-owner', conversationId: b.conversationId, kind: 'decision' },
  ]);
  await eventually(() => expo.sent.length === 1, 'one message');
  await settle();
  assert.equal(expo.sent.length, 1);
  assert.equal(expo.sent[0]?.data.itemId, 'new-owner');
  assert.equal((await unregister(h, token)).status, 404);
});

test('a device the service says is gone, in the ticket or the later receipt, is forgotten', async (t) => {
  const { h, expo, parts, conversationOf } = await setup(t, { receiptDelayMs: 0 });
  const goneNow = newToken();
  const goneLater = newToken();
  const kept = newToken();
  for (const token of [goneNow, goneLater, kept]) await register(h, token);
  expo.state.ticket = (message) =>
    message.to === goneNow
      ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
      : { status: 'ok', id: `ticket:${message.to}` };
  expo.state.receipt = (id) =>
    id === `ticket:${goneLater}`
      ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
      : { status: 'ok' };
  const { conversationId } = await conversationOf();
  parts.notifyDevices([{ itemId: 'first', conversationId, kind: 'decision' }]);
  await eventually(() => expo.asked.flat().includes(`ticket:${goneLater}`), 'receipts read');
  await settle();
  // Removing them now finds nothing: both were forgotten already.
  assert.equal((await unregister(h, goneLater)).status, 404);
  assert.equal((await unregister(h, goneNow)).status, 404);
  const before = expo.sent.length;
  parts.notifyDevices([{ itemId: 'second', conversationId, kind: 'decision' }]);
  await eventually(() => expo.sent.length === before + 1, 'one more message');
  await settle();
  assert.deepEqual(
    expo.sent.slice(before).map((m) => m.to),
    [kept],
  );
});

test('a service that is down is retried, then given up; a restart sends nothing twice', async (t) => {
  const { h, expo, parts, conversationOf } = await setup(t, { maxAttempts: 2 });
  const token = newToken();
  await register(h, token);
  const { conversationId } = await conversationOf();
  expo.state.fail = true;
  parts.notifyDevices([{ itemId: 'lost', conversationId, kind: 'decision' }]);
  await settle();
  expo.state.fail = false;
  parts.notifyDevices([{ itemId: 'kept', conversationId, kind: 'decision' }]);
  await eventually(() => expo.sent.length === 1, 'one message');
  assert.equal(expo.sent[0]?.data.itemId, 'kept');
  await h.restart({ nativePush: { transport: expo.transport, retryDelayMs: 1 } });
  await settle();
  assert.equal(expo.sent.length, 1);
});
