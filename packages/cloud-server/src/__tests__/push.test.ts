import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, type ECDH, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import webpush from 'web-push';
import { openDatabase } from '../db.js';
import { FeedHub } from '../feed.js';
import { PushService, pushConfigFromEnv } from '../push.js';
import { createHttpsTransport, isNonPublicAddress, type PushTransport } from '../push-transport.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';
import { type CloudServerOptions, startCloudServer } from '../cloud-server.js';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, type Harness, newConversation, startHarness } from './harness.js';

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
  assert.deepEqual(payloadOf(call, d), {
    type: 'task.finished',
    conversationId,
    taskId,
    state: 'succeeded',
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

test('every device of every invite gets the message once, and a revoked invite gets none', async (t) => {
  const { h, fake, finish } = await setup(t);
  const a = device();
  const b = device();
  const gone = device();
  const second = h.server.invites.create('second');
  await subscribe(h, a);
  await subscribe(h, b, second.token);
  await subscribe(h, gone, h.server.invites.create('gone').token);
  const goneId = h.server.invites.list().find((invite) => invite.label === 'gone')?.inviteId ?? '';
  h.server.invites.revoke(goneId);
  await finish();
  await eventually(() => fake.calls.length >= 2, 'two pushes');
  await finish();
  await eventually(() => fake.calls.length >= 4, 'four pushes');
  const count = (d: Device) => fake.calls.filter((call) => call.endpoint === d.endpoint).length;
  assert.deepEqual([count(a), count(b), count(gone)], [2, 2, 0]);
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
async function serviceOnly(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'push-service-'));
  const db = openDatabase(join(dir, 'server.sqlite'));
  const hub = new FeedHub();
  const store = new SqliteTaskStore(db, hub);
  const fake = fakeTransport();
  const warnings: string[] = [];
  const control = { failIsActive: false };
  const service = new PushService(
    db,
    hub,
    {
      isActive: () => {
        if (control.failIsActive) throw new Error('invite store unavailable');
        return true;
      },
    },
    {
      config,
      transport: fake.transport,
      retryDelayMs: 1,
      maxAttempts: 2,
      onWarning: (message) => warnings.push(message),
    },
  );
  t.after(async () => {
    await service.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let n = 0;
  const finish = async () => {
    n += 1;
    const taskId = `tsk_${n}`;
    await store.append(
      { type: 'task_created', taskId, sessionId: 'ses_1', runner: 'fake', mode: 'async' },
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
  return { service, hub, fake, warnings, control, finish };
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
