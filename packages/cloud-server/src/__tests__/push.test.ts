import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, type ECDH, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import webpush from 'web-push';
import { openDatabase } from '../db.js';
import { FeedHub } from '../feed.js';
import { PushService, pushAccountTag, pushConfigFromEnv } from '../push.js';
import { createHttpsTransport, isNonPublicAddress, type PushTransport } from '../push-transport.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';
import { type CloudServerOptions, startCloudServer } from '../cloud-server.js';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, type Harness, newConversation, postJson, startHarness } from './harness.js';

async function accountOf(h: Harness): Promise<string> {
  return ((await (await h.api('/v1/me')).json()) as { accountTag: string }).accountTag;
}

const vapid = webpush.generateVAPIDKeys();
const config = { ...vapid, subject: 'mailto:ops@example.com' };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/';

function device() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    endpoint: `${ENDPOINT}${randomBytes(8).toString('hex')}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    },
  };
}
type Device = ReturnType<typeof device>;

/** RFC 8291 (aes128gcm) decryption, to read what a device would read. */
function decrypt(body: Buffer, ecdh: ECDH, auth: Buffer): Record<string, unknown> {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const serverKey = body.subarray(21, 21 + idLength);
  const data = body.subarray(21 + idLength);
  const secret = ecdh.computeSecret(serverKey);
  const derive = (key: Buffer, s: Buffer, info: Buffer, length: number) =>
    Buffer.from(hkdfSync('sha256', key, s, info, length));
  const ikm = derive(
    secret,
    auth,
    Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]),
    32,
  );
  const cek = derive(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = derive(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  assert.equal(plain[end - 1], 2, 'last record delimiter');
  return JSON.parse(plain.subarray(0, end - 1).toString('utf8')) as Record<string, unknown>;
}

interface Call {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
  signal: AbortSignal;
}

function fakeTransport() {
  const calls: Call[] = [];
  const state: { behave: (call: Call) => Promise<{ status: number }> } = {
    behave: async () => ({ status: 201 }),
  };
  const transport: PushTransport = (request, signal) => {
    const call = { ...request, signal };
    calls.push(call);
    return state.behave(call);
  };
  return { transport, calls, state };
}

async function setup(t: TestContext, push: Partial<NonNullable<CloudServerOptions['push']>> = {}) {
  const { handler, seen } = recordingHandler();
  const fake = fakeTransport();
  const h = await startHarness(t, {
    handler,
    push: { ...config, transport: fake.transport, retryDelayMs: 1, ...push },
  });
  const conversationId = await newConversation(h);
  let { session } = await conductorSession(h, seen, conversationId);
  const finish = async (brief = 'work') => {
    const before = h.fake.runs.length;
    const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief });
    await eventually(() => h.fake.runs.length > before, 'run');
    await h.fake.runFor(task.taskId).complete();
    await h.server.orchestrator.wait(session, task.taskId, 2000);
    return task.taskId;
  };
  /** Restarts the server over the same files with new push settings and picks up the conversation again. */
  const restart = async (next: NonNullable<CloudServerOptions['push']>) => {
    await h.restart({ push: next });
    seen.delete(conversationId);
    session = (await conductorSession(h, seen, conversationId)).session;
  };
  return {
    h,
    fake,
    seen,
    conversationId,
    finish,
    restart,
    get session() {
      return session;
    },
  };
}

const subscribe = (h: Harness, d: Device, token?: string | null) =>
  h.api('/v1/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ endpoint: d.endpoint, keys: d.keys }),
    ...(token === undefined ? {} : { token }),
  });

function payloadOf(call: Call, d: Device) {
  return decrypt(call.body, d.ecdh, d.auth);
}

test('the push routes are 404 until push is configured, and need an invite once it is', async (t) => {
  const plain = await startHarness(t);
  assert.equal((await plain.api('/v1/push/key')).status, 404);
  assert.equal((await subscribe(plain, device())).status, 404);

  const { h } = await setup(t);
  assert.equal((await h.api('/v1/push/key', { token: null })).status, 401);
  assert.equal((await subscribe(h, device(), null)).status, 401);
  const key = await h.api('/v1/push/key');
  assert.deepEqual(await key.json(), { publicKey: vapid.publicKey });
});

test('a subscription must point at a known push service and carry real keys', async (t) => {
  const { h } = await setup(t);
  const d = device();
  const bad = async (endpoint: string, keys = d.keys, code = 'invalid_endpoint') => {
    const res = await h.api('/v1/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ endpoint, keys }),
    });
    assert.equal(res.status, 400, endpoint);
    assert.deepEqual(await res.json(), { error: code }, endpoint);
  };
  await bad('http://fcm.googleapis.com/fcm/send/x');
  await bad('https://evil.example.com/fcm/send/x');
  await bad('https://fcm.googleapis.com.evil.example.com/x');
  await bad('https://user:pw@fcm.googleapis.com/x');
  await bad('https://fcm.googleapis.com:8443/x');
  await bad('https://127.0.0.1/x');
  await bad('https://localhost/x');
  await bad('https://169.254.169.254/latest/meta-data');
  await bad(`${ENDPOINT}${'a'.repeat(2100)}`, d.keys, 'invalid_request');
  await bad('not a url');
  await bad(d.endpoint, { p256dh: 'AAAA', auth: d.keys.auth }, 'invalid_keys');
  await bad(d.endpoint, { p256dh: d.keys.p256dh, auth: 'AAAA' }, 'invalid_keys');
  const malformed = await h.api('/v1/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ endpoint: d.endpoint }),
  });
  assert.equal(malformed.status, 400);
});

test('registering twice keeps one subscription, removing needs the same invite, and each invite has a cap', async (t) => {
  const { h } = await setup(t);
  const d = device();
  assert.equal((await subscribe(h, d)).status, 201);
  assert.equal((await subscribe(h, d)).status, 200);
  const other = h.server.invites.create('other');
  const remove = (token: string, endpoint: string) =>
    h.api('/v1/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
      token,
    });
  assert.equal((await remove(other.token, d.endpoint)).status, 404);
  assert.equal((await remove(h.token, d.endpoint)).status, 204);
  assert.equal((await remove(h.token, d.endpoint)).status, 404);
  for (let i = 0; i < 10; i += 1) assert.equal((await subscribe(h, device())).status, 201);
  const over = await subscribe(h, device());
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { error: 'too_many_subscriptions' });
  assert.equal((await subscribe(h, device(), other.token)).status, 201);
});

test('a finished task sends one encrypted, signed message with ids and a state and nothing else', async (t) => {
  const { h, fake, conversationId, finish } = await setup(t);
  const d = device();
  await subscribe(h, d);
  const taskId = await finish('a brief with words nobody should see');
  await eventually(() => fake.calls.length === 1, 'a push');
  const [call] = fake.calls;
  assert.ok(call);
  assert.equal(call.endpoint, d.endpoint);
  assert.match(call.headers.Authorization ?? '', /^vapid /u);
  assert.equal(call.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(Number(call.headers.TTL) > 0);
  assert.ok(!call.body.includes(Buffer.from(taskId)), 'the body is encrypted');
  const accountTag = await accountOf(h);
  assert.match(accountTag, /^[a-f0-9]{32}$/u);
  assert.notEqual(accountTag, h.inviteId);

  assert.deepEqual(payloadOf(call, d), {
    accountTag: await accountOf(h),
    type: 'task.finished',
    conversationId,
    taskId,
    state: 'succeeded',
    lang: 'zh-Hans',
    title: '后台任务已完成',
    body: '打开 Maka 查看结果。',
  });
});

test('failed and cancelled top-level tasks are pushed too, with their state', async (t) => {
  const ctx = await setup(t);
  const { h, fake } = ctx;
  const d = device();
  await subscribe(h, d);
  const orchestrator = h.server.orchestrator;
  const { session } = ctx;
  const start = async () => {
    const before = h.fake.runs.length;
    const task = await orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
    await eventually(() => h.fake.runs.length > before, 'run');
    return task.taskId;
  };
  const failing = await start();
  h.fake.runFor(failing).fail('boom');
  const cancelled = await start();
  await orchestrator.cancel(session, cancelled);
  await eventually(() => fake.calls.length === 2, 'two pushes');
  const states = fake.calls.map((call) => payloadOf(call, d)).map((p) => [p.taskId, p.state]);
  assert.deepEqual(
    states.sort(),
    [
      [cancelled, 'cancelled'],
      [failing, 'failed'],
    ].sort(),
  );
});

test('only top-level tasks push, and only tasks that end after the subscription', async (t) => {
  const ctx = await setup(t);
  const { h, fake, finish } = ctx;
  const { session } = ctx;
  const orchestrator = h.server.orchestrator;
  const early = await finish();
  const d = device();
  await subscribe(h, d);

  const before = h.fake.runs.length;
  const parent = await orchestrator.delegate(session, { runner: 'fake', brief: 'p' });
  const issued = orchestrator.issueSession({ parentTaskId: parent.taskId });
  const executor = orchestrator.authenticate(issued.token);
  assert.ok(executor);
  const child = await orchestrator.delegate(executor, { runner: 'fake', brief: 'c' });
  await eventually(() => h.fake.runs.length === before + 2, 'runs');
  await h.fake.runFor(child.taskId).complete();
  await orchestrator.wait(executor, child.taskId, 2000);
  await h.fake.runFor(parent.taskId).complete();
  await orchestrator.wait(session, parent.taskId, 2000);

  await eventually(() => fake.calls.length >= 1, 'a push');
  // Pushes go out in feed order, so a push for the parent after the child's end proves the child sent none.
  const taskIds = fake.calls.map((call) => payloadOf(call, d).taskId);
  assert.deepEqual(taskIds, [parent.taskId]);
  assert.ok(!taskIds.includes(early));
});

test("a device is told only about its own invite's conversations, and a revoked invite gets nothing", async (t) => {
  const { h, fake, seen, finish } = await setup(t);
  const a = device();
  const a2 = device();
  const other = device();
  const gone = device();
  const second = h.server.invites.create('second');
  await subscribe(h, a);
  await subscribe(h, a2);
  await subscribe(h, other, second.token);
  await subscribe(h, gone, h.server.invites.create('gone').token);
  const goneId = h.server.invites.list().find((invite) => invite.label === 'gone')?.inviteId ?? '';
  h.server.invites.revoke(goneId);
  // The second invite has a conversation and a task of its own.
  const res = await postJson(h, '/v1/conversations', {}, second.token);
  const { conversationId: otherConversation } = (await res.json()) as { conversationId: string };
  await postJson(
    h,
    `/v1/conversations/${otherConversation}/messages`,
    { text: 'go' },
    second.token,
  );
  await eventually(() => seen.has(otherConversation), 'second handler call');
  const otherSession = h.server.orchestrator.authenticate(
    seen.get(otherConversation)?.rotateToken() ?? '',
  );
  assert.ok(otherSession);
  const own = async () => {
    const before = h.fake.runs.length;
    const task = await h.server.orchestrator.delegate(otherSession, { runner: 'fake', brief: 'b' });
    await eventually(() => h.fake.runs.length > before, 'run');
    await h.fake.runFor(task.taskId).complete();
    await h.server.orchestrator.wait(otherSession, task.taskId, 2000);
    return task.taskId;
  };
  const first = await finish();
  const second1 = await own();
  await eventually(() => fake.calls.length >= 3, 'three pushes');
  const forDevice = (d: Device) => fake.calls.filter((call) => call.endpoint === d.endpoint);
  assert.deepEqual(
    [forDevice(a), forDevice(a2), forDevice(other), forDevice(gone)].map((calls) => calls.length),
    [1, 1, 1, 0],
  );
  assert.equal(payloadOf(forDevice(a)[0] as Call, a).taskId, first);
  assert.equal(payloadOf(forDevice(other)[0] as Call, other).taskId, second1);
});

test('what was sent is not sent again after a restart, and what was missed is sent once', async (t) => {
  const first = fakeTransport();
  const ctx = await setup(t, {
    transport: first.transport,
    maxAttempts: 100,
    retryDelayMs: 3_600_000,
  });
  const { h } = ctx;
  const d = device();
  // Ended before the device subscribed: never sent, not even after a restart.
  await ctx.finish();
  await subscribe(h, d);
  first.state.behave = async () => {
    throw new Error('network down');
  };
  const missed = await ctx.finish();
  await eventually(() => first.calls.length === 1, 'a failed attempt');

  const second = fakeTransport();
  await ctx.restart({ ...config, transport: second.transport, retryDelayMs: 1 });
  await eventually(() => second.calls.length === 1, 'the missed push');
  assert.equal(payloadOf(second.calls[0] as Call, d).taskId, missed);

  const third = fakeTransport();
  await ctx.restart({ ...config, transport: third.transport, retryDelayMs: 1 });
  const next = await ctx.finish();
  await eventually(() => third.calls.length >= 1, 'the next push');
  // Pushes go out in order, so nothing earlier than `next` was sent again.
  assert.deepEqual(
    third.calls.map((call) => payloadOf(call, d).taskId),
    [next],
  );
});

test('a gone subscription (404 or 410) is deleted and its device is not asked again', async (t) => {
  const { h, fake, finish } = await setup(t);
  const gone = device();
  const kept = device();
  await subscribe(h, gone);
  await subscribe(h, kept);
  fake.state.behave = async (call) => ({ status: call.endpoint === gone.endpoint ? 410 : 201 });
  await finish();
  await eventually(() => fake.calls.length === 2, 'both asked');
  await finish();
  await eventually(() => fake.calls.length === 3, 'only the kept device asked');
  assert.equal(fake.calls.filter((call) => call.endpoint === gone.endpoint).length, 1);
  const remove = await h.api('/v1/push/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint: gone.endpoint }),
  });
  assert.equal(remove.status, 404);
});

test('a server error is retried up to the attempt limit, a client error is not retried, and the next task is unaffected', async (t) => {
  const { h, fake, finish } = await setup(t, { maxAttempts: 3 });
  const retried = device();
  const refused = device();
  await subscribe(h, retried);
  await subscribe(h, refused);
  let firstTaskId: string | undefined;
  fake.state.behave = async (call) => {
    const d = call.endpoint === retried.endpoint ? retried : refused;
    const id = payloadOf(call, d).taskId as string;
    firstTaskId ??= id;
    if (id !== firstTaskId) return { status: 201 };
    return { status: d === retried ? 503 : 400 };
  };
  await finish();
  const per = (d: Device) => fake.calls.filter((call) => call.endpoint === d.endpoint).length;
  await eventually(() => per(retried) === 3 && per(refused) === 1, 'attempts');
  await finish();
  await eventually(() => per(retried) === 4 && per(refused) === 2, 'the second task');
});

test('a send that never answers is cut off at the timeout and counted as a failure', async (t) => {
  const { h, fake, finish } = await setup(t, { timeoutMs: 20, maxAttempts: 2 });
  await subscribe(h, device());
  fake.state.behave = (call) =>
    new Promise((_, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  await finish();
  await eventually(
    () => fake.calls.length === 2 && fake.calls.every((c) => c.signal.aborted),
    'two timed-out attempts',
  );
});

test('closing the server aborts sends in flight and nothing is sent afterwards', async (t) => {
  const { h, fake, finish } = await setup(t, { maxAttempts: 100 });
  await subscribe(h, device());
  let entered = false;
  fake.state.behave = (call) =>
    new Promise((_, reject) => {
      entered = true;
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  await finish();
  await eventually(() => entered, 'a send in flight');
  const [call] = fake.calls;
  const hung = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('close did not finish')), 2000).unref();
  });
  await Promise.race([h.server.close(), hung]);
  assert.equal(call?.signal.aborted, true);
  assert.equal(fake.calls.length, 1);
});

test('push settings that cannot sign fail at startup without printing the key, and the private key is never stored', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'push-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secret = vapid.privateKey;
  await assert.rejects(
    startCloudServer({
      dbPath: join(dir, 's.sqlite'),
      invitesPath: join(dir, 'i.sqlite'),
      handoffRoot: join(dir, 'h'),
      runners: (await startHarness(t)).options.runners,
      push: { publicKey: vapid.publicKey, privateKey: `${secret}x`, subject: config.subject },
    }),
    (error: unknown) =>
      error instanceof Error && /not valid/u.test(error.message) && !error.message.includes(secret),
  );

  const { h } = await setup(t);
  await subscribe(h, device());
  await h.server.close();
  const files = (await readdir(h.dir)).filter((name) => name.includes('sqlite'));
  for (const name of files) {
    assert.ok(!(await readFile(join(h.dir, name))).includes(Buffer.from(secret)), name);
  }
});

test('push settings come from the environment, all or nothing', () => {
  assert.equal(pushConfigFromEnv({}), undefined);
  assert.deepEqual(
    pushConfigFromEnv({
      CLOUD_PUSH_VAPID_PUBLIC: 'pub',
      CLOUD_PUSH_VAPID_PRIVATE: 'priv',
      CLOUD_PUSH_SUBJECT: 'mailto:a@b.c',
      CLOUD_PUSH_ALLOWED_HOSTS: ' Push.Example.com , *.other.net ,',
    }),
    {
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:a@b.c',
      allowedHosts: ['push.example.com', '*.other.net'],
    },
  );
  assert.throws(
    () => pushConfigFromEnv({ CLOUD_PUSH_VAPID_PUBLIC: 'pub', CLOUD_PUSH_VAPID_PRIVATE: 'sekret' }),
    (error: unknown) =>
      error instanceof Error &&
      /CLOUD_PUSH_SUBJECT/u.test(error.message) &&
      !/sekret/u.test(error.message),
  );
});

test('private, loopback, link-local and unspecified addresses are not public', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    // The same addresses in the spellings that carry an IPv4 address inside an IPv6 one.
    '::ffff:a9fe:a9fe',
    '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::7f00:1',
    '2002:a9fe:a9fe::1',
    '2002:7f00:1::1',
    '::169.254.169.254',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    // Reserved and documentation ranges are no push service either.
    '240.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '2001:db8::1',
    'not-an-ip',
  ]) {
    assert.equal(isNonPublicAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '2607:f8b0:4004:c07::5f']) {
    assert.equal(isNonPublicAddress(address), false, address);
  }
});

test('the real transport refuses to connect to a private address, before any request is sent', async () => {
  const transport = createHttpsTransport();
  try {
    for (const endpoint of ['https://127.0.0.1:9/x', 'https://localhost:9/x']) {
      await assert.rejects(
        transport({ endpoint, headers: {}, body: Buffer.alloc(0) }, AbortSignal.timeout(5000)),
        (error: unknown) => (error as { code?: string }).code === 'EPUSHADDR',
        endpoint,
      );
    }
    const aborted = AbortSignal.abort();
    await assert.rejects(
      transport({ endpoint: 'https://127.0.0.1:9/x', headers: {}, body: Buffer.alloc(0) }, aborted),
    );
  } finally {
    transport.close();
  }
});

// The service on its own, so a pass can be made to fail on purpose.
async function serviceOnly(
  t: TestContext,
  options: { maxAttempts?: number; concurrency?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'push-service-'));
  const db = openDatabase(join(dir, 'server.sqlite'));
  const hub = new FeedHub();
  const store = new SqliteTaskStore(db, hub);
  const fake = fakeTransport();
  const warnings: string[] = [];
  const listeners = new Set<(inviteId: string) => void>();
  const control = {
    failIsActive: false,
    revoked: new Set<string>(),
    revoke(inviteId: string) {
      control.revoked.add(inviteId);
      for (const listener of [...listeners]) listener(inviteId);
    },
  };
  // Three conversations: ses_1 is owned by inv_1, ses_2 by inv_2, ses_3 by nobody.
  const conversations: Array<[string, string, string | null]> = [
    ['ses_1', 'cnv_1', 'inv_1'],
    ['ses_2', 'cnv_2', 'inv_2'],
    ['ses_3', 'cnv_3', null],
  ];
  conversations.forEach(([session, conversation, owner], index) => {
    db.prepare(
      'INSERT INTO conversations (conversation_id, n, title, session_id, created_at, owner) VALUES (?, ?, NULL, ?, 0, ?)',
    ).run(conversation, index + 1, session, owner);
  });
  const service = new PushService(
    db,
    hub,
    {
      active: (inviteId) => {
        if (control.failIsActive) throw new Error('invite store unavailable');
        return !control.revoked.has(inviteId);
      },
      onRevoke: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    {
      config,
      transport: fake.transport,
      retryDelayMs: 1,
      maxAttempts: options.maxAttempts ?? 2,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      onWarning: (message) => warnings.push(message),
    },
  );
  t.after(async () => {
    await service.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let n = 0;
  const finish = async (sessionId = 'ses_1') => {
    n += 1;
    const taskId = `tsk_${n}`;
    await store.append(
      { type: 'task_created', taskId, sessionId, runner: 'fake', mode: 'async' },
      n,
    );
    await store.append(
      {
        type: 'task_succeeded',
        taskId,
        manifest: { summary: 's', done: [], notDone: [], confidence: 'high', knownIssues: [] },
      },
      n,
    );
    return taskId;
  };
  return { service, db, hub, fake, warnings, control, finish };
}

test('a pass that fails is reported, does not stop the service, and is retried on the next commit', async (t) => {
  const { service, hub, fake, warnings, control, finish } = await serviceOnly(t);
  const d = device();
  assert.equal(service.register('inv_1', { endpoint: d.endpoint, ...d.keys }), 'created');
  service.start();
  control.failIsActive = true;
  const taskId = await finish();
  await eventually(() => warnings.length >= 1, 'a warning');
  assert.equal(fake.calls.length, 0);
  control.failIsActive = false;
  hub.notify();
  await eventually(() => fake.calls.length === 1, 'the push after recovery');
  assert.equal(payloadOf(fake.calls[0] as Call, d).taskId, taskId);
});

test('a transport that throws at once counts as a failed attempt, and the message is dropped at the limit', async (t) => {
  const { service, fake, finish } = await serviceOnly(t);
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  service.start();
  fake.state.behave = () => {
    throw new Error('synchronous failure');
  };
  await finish();
  await eventually(() => fake.calls.length === 2, 'two attempts');
  fake.state.behave = async () => ({ status: 201 });
  const next = await finish();
  await eventually(() => fake.calls.length === 3, 'the next task');
  assert.equal(payloadOf(fake.calls[2] as Call, d).taskId, next);
  assert.equal(fake.calls.filter((call) => payloadOf(call, d).taskId === 'tsk_1').length, 2);
});

test('a conversation another invite owns, or nobody owns, never reaches a device', async (t) => {
  const { service, fake, finish } = await serviceOnly(t);
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  service.start();
  await finish('ses_2');
  await finish('ses_3');
  // Feed order makes the last task the proof that the first two were looked at.
  const own = await finish('ses_1');
  await eventually(() => fake.calls.length >= 1, 'the own conversation');
  assert.deepEqual(
    fake.calls.map((call) => payloadOf(call, d).taskId),
    [own],
  );
});

test("a revoke forgets the invite's devices and cuts off a send in flight, and other invites are untouched", async (t) => {
  const { service, db, fake, control, finish } = await serviceOnly(t, { maxAttempts: 1 });
  const d = device();
  const other = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  service.register('inv_2', { endpoint: other.endpoint, ...other.keys });
  service.start();
  let release: () => void = () => undefined;
  fake.state.behave = (call) =>
    call.endpoint === d.endpoint
      ? new Promise((_resolve, reject) => {
          call.signal.addEventListener('abort', () => reject(new Error('aborted')));
          release = () => reject(new Error('never'));
        })
      : Promise.resolve({ status: 201 });
  await finish('ses_1');
  await eventually(() => fake.calls.length === 1, 'the send under way');
  control.revoke('inv_1');
  const held = fake.calls[0] as Call;
  await eventually(() => held.signal.aborted, 'the send is cut off');
  release();
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(count('SELECT COUNT(*) AS n FROM push_subscriptions'), 1);
  // The aborted send leaves nothing behind that could be sent or counted later.
  await finish('ses_2');
  await eventually(() => fake.calls.length === 2, "the other invite's push");
  assert.equal((fake.calls[1] as Call).endpoint, other.endpoint);
  const recorded = db
    .prepare('SELECT COUNT(*) AS n FROM push_deliveries WHERE endpoint = ?')
    .get(d.endpoint) as {
    n: number;
  };
  assert.equal(recorded.n, 0);
  assert.equal(fake.calls.filter((call) => call.endpoint === d.endpoint).length, 1);
});

test('an invite revoked from another process is seen at the next send, which is not made', async (t) => {
  const { service, fake, control, finish } = await serviceOnly(t);
  const d = device();
  const other = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  service.register('inv_2', { endpoint: other.endpoint, ...other.keys });
  service.start();
  // The revoke happened in the command line's process: no listener hears of it.
  control.revoked.add('inv_1');
  await finish('ses_1');
  const own = await finish('ses_2');
  await eventually(() => fake.calls.length >= 1, 'the other invite');
  assert.deepEqual(
    fake.calls.map((call) => call.endpoint),
    [other.endpoint],
  );
  assert.equal(payloadOf(fake.calls[0] as Call, other).taskId, own);
});

test("a device that moves to another invite starts afresh: the new invite gets nothing from before the move, and the old invite's records go", async (t) => {
  const { service, db, fake, finish } = await serviceOnly(t);
  const d = device();
  assert.equal(service.register('inv_1', { endpoint: d.endpoint, ...d.keys }), 'created');
  service.start();
  const first = await finish('ses_1');
  await eventually(() => fake.calls.length === 1, "the old invite's push");
  assert.equal(payloadOf(fake.calls[0] as Call, d).taskId, first);
  // Ended while inv_1 held the device, so it was never inv_2's to send.
  await finish('ses_2');
  assert.equal(service.register('inv_2', { endpoint: d.endpoint, ...d.keys }), 'updated');
  const rows = db
    .prepare('SELECT COUNT(*) AS n FROM push_deliveries WHERE endpoint = ?')
    .get(d.endpoint) as { n: number };
  assert.equal(rows.n, 0);
  const after = await finish('ses_2');
  await eventually(() => fake.calls.length >= 2, "the new invite's push");
  assert.deepEqual(
    fake.calls.slice(1).map((call) => payloadOf(call, d).taskId),
    [after],
  );
  // Registering again as the same invite changes nothing about what is owed.
  assert.equal(service.register('inv_2', { endpoint: d.endpoint, ...d.keys }), 'updated');
  await finish('ses_1');
  const last = await finish('ses_2');
  await eventually(() => fake.calls.length >= 3, 'the next push');
  assert.deepEqual(
    fake.calls.slice(2).map((call) => payloadOf(call, d).taskId),
    [last],
  );
});

test('a send queued for the old invite is not made to the device once it moved', async (t) => {
  const { service, fake, finish } = await serviceOnly(t, { concurrency: 1 });
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  const held = await finish('ses_1');
  const queued = await finish('ses_1');
  let release: () => void = () => undefined;
  fake.state.behave = (call) =>
    new Promise((resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
      release = () => resolve({ status: 201 });
    });
  service.start();
  await eventually(() => fake.calls.length === 1, 'the first send under way');
  assert.equal(payloadOf(fake.calls[0] as Call, d).taskId, held);
  service.register('inv_2', { endpoint: d.endpoint, ...d.keys });
  release();
  fake.state.behave = async () => ({ status: 201 });
  const fresh = await finish('ses_2');
  await eventually(() => fake.calls.length >= 2, "the new invite's push");
  const sent = fake.calls.slice(1).map((call) => payloadOf(call, d).taskId);
  assert.deepEqual(sent, [fresh]);
  assert.ok(!sent.includes(queued));
});

test('a send in flight for the old invite is cut off when the device moves, and the new invite is not charged for it', async (t) => {
  const { service, db, fake, finish } = await serviceOnly(t);
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  fake.state.behave = (call) =>
    new Promise((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  service.start();
  await finish('ses_1');
  await eventually(() => fake.calls.length === 1, 'the send under way');
  const inflight = fake.calls[0] as Call;
  service.register('inv_2', { endpoint: d.endpoint, ...d.keys });
  await eventually(() => inflight.signal.aborted, 'the old invite send is cut off');
  fake.state.behave = async () => ({ status: 201 });
  await finish('ses_2');
  await eventually(() => fake.calls.length === 2, "the new invite's push");
  const rows = db
    .prepare('SELECT COUNT(*) AS n FROM push_deliveries WHERE endpoint = ?')
    .get(d.endpoint) as { n: number };
  assert.equal(rows.n, 1);
});

test("a subscription that is deleted and registered again, by anyone, is a new one: the old one's send in flight is cut off", async (t) => {
  for (const next of ['inv_1', 'inv_2']) {
    const { service, fake, finish } = await serviceOnly(t);
    const d = device();
    service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
    fake.state.behave = (call) =>
      new Promise((_resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    service.start();
    await finish('ses_1');
    await eventually(() => fake.calls.length === 1, `the send under way, then ${next}`);
    const inflight = fake.calls[0] as Call;
    assert.equal(service.remove('inv_1', d.endpoint), true);
    // Deleting is enough to end the send; registering again must not be what does it.
    assert.equal(inflight.signal.aborted, true, 'the delete cuts the send off');
    assert.equal(service.register(next, { endpoint: d.endpoint, ...d.keys }), 'created');
    fake.state.behave = async () => ({ status: 201 });
    const fresh = await finish(next === 'inv_1' ? 'ses_1' : 'ses_2');
    await eventually(() => fake.calls.length === 2, 'the push to the new subscription');
    assert.equal(payloadOf(fake.calls[1] as Call, d).taskId, fresh);
  }
});

test('a send queued for a subscription that was deleted and registered again is not made', async (t) => {
  const { service, fake, finish } = await serviceOnly(t, { concurrency: 1 });
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  const held = await finish('ses_1');
  const queued = await finish('ses_1');
  let release: () => void = () => undefined;
  fake.state.behave = (call) =>
    new Promise((resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
      release = () => resolve({ status: 201 });
    });
  service.start();
  await eventually(() => fake.calls.length === 1, 'the first send under way');
  assert.equal(payloadOf(fake.calls[0] as Call, d).taskId, held);
  service.remove('inv_1', d.endpoint);
  // The same invite, the same browser: still a new subscription, owed nothing from before.
  assert.equal(service.register('inv_1', { endpoint: d.endpoint, ...d.keys }), 'created');
  release();
  fake.state.behave = async () => ({ status: 201 });
  const fresh = await finish('ses_1');
  await eventually(() => fake.calls.length >= 2, 'the new subscription push');
  const sent = fake.calls.slice(1).map((call) => payloadOf(call, d).taskId);
  assert.deepEqual(sent, [fresh]);
  assert.ok(!sent.includes(queued));
});

const DAY_KEY = 'spend:2026-10-20';
const alertRows = (db: ReturnType<typeof openDatabase>, endpoint: string): number =>
  (
    db
      .prepare('SELECT COUNT(*) AS n FROM push_deliveries WHERE endpoint = ? AND task_id = ?')
      .get(endpoint, `alert:${DAY_KEY}`) as { n: number }
  ).n;

test('an alert reaches the devices of the invite it is for and nobody else, with the type and nothing more', async (t) => {
  const { service, fake, db } = await serviceOnly(t);
  const a = device();
  const a2 = device();
  const other = device();
  service.register('inv_1', { endpoint: a.endpoint, ...a.keys });
  service.register('inv_1', { endpoint: a2.endpoint, ...a2.keys });
  service.register('inv_2', { endpoint: other.endpoint, ...other.keys });
  service.start();
  await service.alert('inv_1', DAY_KEY);
  assert.deepEqual(
    fake.calls.map((call) => call.endpoint).sort(),
    [a.endpoint, a2.endpoint].sort(),
  );
  for (const call of fake.calls) {
    const mine = call.endpoint === a.endpoint ? a : a2;
    assert.deepEqual(payloadOf(call, mine), {
      accountTag: pushAccountTag(db, 'inv_1'),
      type: 'spend.alert',
      lang: 'zh-Hans',
      title: '今天的花费偏高',
      body: '打开 Maka 查看明细。',
    });
    assert.match(call.headers.Authorization ?? '', /^vapid /u);
    assert.equal(call.headers.Urgency, 'high');
    assert.ok(!call.body.includes(Buffer.from('spend')), 'the body is encrypted');
  }
  await service.alert('inv_3', DAY_KEY);
  assert.equal(fake.calls.length, 2, 'an invite with no device sends nothing and still resolves');
});

test('a device is told once per alert key: asking again sends nothing, the next key sends again', async (t) => {
  const { service, db, fake } = await serviceOnly(t);
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  service.start();
  await service.alert('inv_1', DAY_KEY);
  await service.alert('inv_1', DAY_KEY);
  await Promise.all([service.alert('inv_1', DAY_KEY), service.alert('inv_1', DAY_KEY)]);
  assert.equal(fake.calls.length, 1);
  assert.equal(alertRows(db, d.endpoint), 1);
  await service.alert('inv_1', 'spend:2026-10-21');
  assert.equal(fake.calls.length, 2, 'a new day is a new alert');
});

test('what was sent is not sent again after a restart, and a device that was missed is told once', async (t) => {
  const first = fakeTransport();
  const ctx = await setup(t, { transport: first.transport });
  const d = device();
  await subscribe(ctx.h, d);
  const owner = ctx.h.server.invites.list()[0]?.inviteId ?? '';
  await ctx.h.server.pushAlert(owner, DAY_KEY);
  assert.equal(first.calls.length, 1);

  const second = fakeTransport();
  await ctx.restart({ ...config, transport: second.transport, retryDelayMs: 1 });
  await ctx.h.server.pushAlert(owner, DAY_KEY);
  assert.equal(second.calls.length, 0, 'the restart does not repeat it');

  // A device that subscribed after the alert is told when the alert is asked for again.
  const late = device();
  await subscribe(ctx.h, late);
  await ctx.h.server.pushAlert(owner, DAY_KEY);
  assert.deepEqual(
    second.calls.map((call) => call.endpoint),
    [late.endpoint],
  );
});

test('a revoked invite gets no alert, whether its devices are forgotten or the revoke is only seen at send time', async (t) => {
  const { service, db, fake, control } = await serviceOnly(t);
  const d = device();
  const e = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  service.register('inv_2', { endpoint: e.endpoint, ...e.keys });
  service.start();
  control.revoked.add('inv_1');
  await service.alert('inv_1', DAY_KEY);
  assert.equal(fake.calls.length, 0);
  assert.equal(alertRows(db, d.endpoint), 1, 'recorded as revoked, so it is not retried');
  control.revoke('inv_2');
  await service.alert('inv_2', DAY_KEY);
  assert.equal(fake.calls.length, 0);
});

test('an alert for the old invite is cut off when its device moves, and the new invite owes nothing for it', async (t) => {
  const { service, db, fake } = await serviceOnly(t);
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  fake.state.behave = (call) =>
    new Promise((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  service.start();
  const asked = service.alert('inv_1', DAY_KEY);
  await eventually(() => fake.calls.length === 1, 'the send under way');
  const inflight = fake.calls[0] as Call;
  service.register('inv_2', { endpoint: d.endpoint, ...d.keys });
  await eventually(() => inflight.signal.aborted, 'the old invite’s send is cut off');
  await asked;
  assert.equal(alertRows(db, d.endpoint), 0, 'nothing is recorded for the device’s new invite');
  fake.state.behave = async () => ({ status: 201 });
  await service.alert('inv_2', DAY_KEY);
  assert.equal(fake.calls.length, 2, 'the new invite is told on its own account');
  assert.equal(alertRows(db, d.endpoint), 1);
});

test('an alert queued for a device that moved or was deleted and registered again is not sent to it', async (t) => {
  const { service, fake } = await serviceOnly(t, { concurrency: 1 });
  const first = device();
  const queued = device();
  service.register('inv_1', { endpoint: first.endpoint, ...first.keys });
  service.register('inv_1', { endpoint: queued.endpoint, ...queued.keys });
  let release: () => void = () => undefined;
  fake.state.behave = (call) =>
    new Promise((resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
      release = () => resolve({ status: 201 });
    });
  service.start();
  const asked = service.alert('inv_1', DAY_KEY);
  await eventually(() => fake.calls.length === 1, 'the first send under way');
  // The second device is queued behind it; it moves to another invite before its turn.
  const [held, waiting] =
    fake.calls[0]?.endpoint === first.endpoint ? [first, queued] : [queued, first];
  service.register('inv_2', { endpoint: waiting.endpoint, ...waiting.keys });
  release();
  fake.state.behave = async () => ({ status: 201 });
  await asked;
  assert.deepEqual(
    fake.calls.map((call) => call.endpoint),
    [held.endpoint],
    'the device that moved was not sent inv_1’s alert',
  );
});

test('an alert queued for a subscription that was deleted and registered again is sent to the new one afresh, once', async (t) => {
  const { service, db, fake } = await serviceOnly(t, { concurrency: 1 });
  const first = device();
  const again = device();
  service.register('inv_1', { endpoint: first.endpoint, ...first.keys });
  service.register('inv_1', { endpoint: again.endpoint, ...again.keys });
  let release: () => void = () => undefined;
  fake.state.behave = (call) =>
    new Promise((resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
      release = () => resolve({ status: 201 });
    });
  service.start();
  const asked = service.alert('inv_1', DAY_KEY);
  await eventually(() => fake.calls.length === 1, 'the first send under way');
  const held = fake.calls[0]?.endpoint;
  const waiting = held === first.endpoint ? again : first;
  // The waiting device is deleted and registered again by the same invite: a new subscription.
  assert.equal(service.remove('inv_1', waiting.endpoint), true);
  assert.equal(
    service.register('inv_1', { endpoint: waiting.endpoint, ...waiting.keys }),
    'created',
  );
  fake.state.behave = async () => ({ status: 201 });
  release();
  await asked;
  const sentTo = fake.calls.map((call) => call.endpoint).sort();
  assert.deepEqual(sentTo, [first.endpoint, again.endpoint].sort(), 'each device is told once');
  assert.equal(alertRows(db, waiting.endpoint), 1);
});

test('a push service that keeps failing leaves the alert owed: it is reported incomplete, never recorded as given up, and sent when the service recovers', async (t) => {
  // The retry timer does not keep a process alive (the server's sockets do); the test holds it.
  const hold = setInterval(() => undefined, 1000);
  t.after(() => clearInterval(hold));
  const { service, db, fake } = await serviceOnly(t, { maxAttempts: 2 });
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  fake.state.behave = async () => ({ status: 503 });
  service.start();
  assert.equal(await service.alert('inv_1', DAY_KEY), false, 'not every device was told');
  assert.equal(fake.calls.length, 2);
  assert.equal(alertRows(db, d.endpoint), 0, 'nothing is recorded: the device is still owed');
  fake.state.behave = async () => ({ status: 201 });
  assert.equal(await service.alert('inv_1', DAY_KEY), true);
  assert.equal(fake.calls.length, 3, 'asked again after the service recovered, it is sent');
  assert.equal(alertRows(db, d.endpoint), 1);
  assert.equal(await service.alert('inv_1', DAY_KEY), true);
  assert.equal(fake.calls.length, 3, 'a told device is not told twice');
});

test('an alert that failed for a while is still owed after the server restarts', async (t) => {
  const hold = setInterval(() => undefined, 1000);
  t.after(() => clearInterval(hold));
  const first = await serviceOnly(t, { maxAttempts: 1 });
  const d = device();
  first.service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  first.fake.state.behave = async () => ({ status: 503 });
  first.service.start();
  assert.equal(await first.service.alert('inv_1', DAY_KEY), false);
  assert.equal(alertRows(first.db, d.endpoint), 0);
  // A restart is a new service on the same database; the owed alert is asked for again.
  const second = new PushService(
    first.db,
    first.hub,
    { active: () => true },
    { config, transport: first.fake.transport, retryDelayMs: 1, maxAttempts: 1 },
  );
  t.after(() => second.close());
  first.fake.state.behave = async () => ({ status: 201 });
  second.start();
  assert.equal(await second.alert('inv_1', DAY_KEY), true);
  assert.equal(alertRows(first.db, d.endpoint), 1);
});

test('one device that keeps failing does not hold back another, and only it is asked again', async (t) => {
  const hold = setInterval(() => undefined, 1000);
  t.after(() => clearInterval(hold));
  const { service, db, fake } = await serviceOnly(t, { maxAttempts: 2 });
  const good = device();
  const bad = device();
  service.register('inv_1', { endpoint: good.endpoint, ...good.keys });
  service.register('inv_1', { endpoint: bad.endpoint, ...bad.keys });
  fake.state.behave = async (call) => ({ status: call.endpoint === bad.endpoint ? 503 : 201 });
  service.start();
  assert.equal(await service.alert('inv_1', DAY_KEY), false);
  assert.equal(alertRows(db, good.endpoint), 1);
  assert.equal(alertRows(db, bad.endpoint), 0);
  const before = fake.calls.length;
  fake.state.behave = async () => ({ status: 201 });
  assert.equal(await service.alert('inv_1', DAY_KEY), true);
  assert.deepEqual(
    fake.calls.slice(before).map((call) => call.endpoint),
    [bad.endpoint],
    'only the device that was not told',
  );
});

test('a refusal that will not change ends the alert for that device, and a failed one does not', async (t) => {
  const hold = setInterval(() => undefined, 1000);
  t.after(() => clearInterval(hold));
  const { service, db, fake } = await serviceOnly(t, { maxAttempts: 2 });
  const refused = device();
  service.register('inv_1', { endpoint: refused.endpoint, ...refused.keys });
  fake.state.behave = async () => ({ status: 400 });
  service.start();
  assert.equal(await service.alert('inv_1', DAY_KEY), true, 'a permanent refusal is done');
  assert.equal(alertRows(db, refused.endpoint), 1);
  assert.equal(fake.calls.length, 1, 'and is not retried');
  assert.equal(await service.alert('inv_1', DAY_KEY), true);
  assert.equal(fake.calls.length, 1);
});

test('a gone subscription is deleted by the alert and the alert still resolves', async (t) => {
  const { service, db, fake } = await serviceOnly(t);
  const gone = device();
  const good = device();
  service.register('inv_1', { endpoint: gone.endpoint, ...gone.keys });
  service.register('inv_1', { endpoint: good.endpoint, ...good.keys });
  fake.state.behave = async (call) => ({ status: call.endpoint === gone.endpoint ? 410 : 201 });
  service.start();
  await service.alert('inv_1', DAY_KEY);
  const remaining = db.prepare('SELECT endpoint FROM push_subscriptions').all() as Array<{
    endpoint: string;
  }>;
  assert.deepEqual(
    remaining.map((row) => row.endpoint),
    [good.endpoint],
  );
});

test('an alert key is a short plain name, and an alert does not disturb task messages', async (t) => {
  const { service, fake, finish, db } = await serviceOnly(t);
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  service.start();
  for (const bad of ['', 'Spend', 'x y', 'a'.repeat(65), '../x', 'spend\nalert']) {
    await assert.rejects(service.alert('inv_1', bad), /Invalid alert key/u, JSON.stringify(bad));
  }
  assert.equal(fake.calls.length, 0);
  await service.alert('inv_1', DAY_KEY);
  const taskId = await finish('ses_1');
  await eventually(() => fake.calls.length === 2, 'the task message');
  assert.deepEqual(payloadOf(fake.calls[1] as Call, d), {
    accountTag: pushAccountTag(db, 'inv_1'),
    type: 'task.finished',
    conversationId: 'cnv_1',
    taskId,
    state: 'succeeded',
    lang: 'zh-Hans',
    title: '后台任务已完成',
    body: '打开 Maka 查看结果。',
  });
});

test('closing the service while an alert is being sent lets whoever asked for it go on', async (t) => {
  const { service, fake } = await serviceOnly(t);
  const d = device();
  service.register('inv_1', { endpoint: d.endpoint, ...d.keys });
  fake.state.behave = (call) =>
    new Promise((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  service.start();
  const asked = service.alert('inv_1', DAY_KEY);
  await eventually(() => fake.calls.length === 1, 'the send under way');
  await service.close();
  await asked;
  await service.alert('inv_1', 'spend:2026-10-21');
  assert.equal(fake.calls.length, 1, 'nothing is sent once closed');
});

test('a person who reads English gets the push words in English; the ids and state are the same', async (t) => {
  const { h, fake, conversationId, finish } = await setup(t);
  const d = device();
  await subscribe(h, d);
  const set = await h.api('/v1/settings', {
    method: 'PATCH',
    body: JSON.stringify({ language: 'en' }),
  });
  assert.equal(set.status, 200);
  const taskId = await finish();
  await eventually(() => fake.calls.length === 1, 'a push');
  assert.deepEqual(payloadOf(fake.calls[0] as Call, d), {
    accountTag: await accountOf(h),
    type: 'task.finished',
    conversationId,
    taskId,
    state: 'succeeded',
    lang: 'en',
    title: 'Your background task has finished',
    body: 'Open Maka to review the result.',
  });
  assert.equal(await h.server.pushAlert(h.inviteId, 'spend:2026-10-22'), true);
  assert.deepEqual(payloadOf(fake.calls[1] as Call, d), {
    accountTag: await accountOf(h),
    type: 'spend.alert',
    lang: 'en',
    title: 'Spending is high today',
    body: 'Open Maka to see where it went.',
  });
});

test('a person who reads Traditional Chinese gets the push words in Traditional Chinese', async (t) => {
  const { h, fake, conversationId, finish } = await setup(t);
  const d = device();
  await subscribe(h, d);
  const set = await h.api('/v1/settings', {
    method: 'PATCH',
    body: JSON.stringify({ language: 'zh-Hant' }),
  });
  assert.equal(set.status, 200);
  const taskId = await finish();
  await eventually(() => fake.calls.length === 1, 'a push');
  assert.deepEqual(payloadOf(fake.calls[0] as Call, d), {
    accountTag: await accountOf(h),
    type: 'task.finished',
    conversationId,
    taskId,
    state: 'succeeded',
    lang: 'zh-Hant',
    title: '背景任務已完成',
    body: '開啟 Maka 查看結果。',
  });
  assert.equal(await h.server.pushAlert(h.inviteId, 'spend:2026-10-22'), true);
  assert.deepEqual(payloadOf(fake.calls[1] as Call, d), {
    accountTag: await accountOf(h),
    type: 'spend.alert',
    lang: 'zh-Hant',
    title: '今天的花費偏高',
    body: '開啟 Maka 查看明細。',
  });
});

test('account tags use a persistent server secret and differ across servers and owners', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'push-account-tag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'server.sqlite');
  let db = openDatabase(file);
  const tag = pushAccountTag(db, 'owner');
  assert.match(tag, /^[a-f0-9]{32}$/u);
  assert.notEqual(tag, pushAccountTag(db, 'other-owner'));
  db.close();
  db = openDatabase(file);
  assert.equal(pushAccountTag(db, 'owner'), tag);
  db.close();
  const other = openDatabase(join(dir, 'other.sqlite'));
  assert.notEqual(pushAccountTag(other, 'owner'), tag);
  other.close();
});
