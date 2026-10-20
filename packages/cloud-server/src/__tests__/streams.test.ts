import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server, ServerResponse } from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { MemoryStore } from '@maka-cloud/memory';
import { ConversationStore } from '../conversations.js';
import { openDatabase } from '../db.js';
import { FeedHub } from '../feed.js';
import { DEFAULT_HTTP_LIMITS, type HttpLimits, PublicApi } from '../http.js';
import { InviteStore } from '../invites.js';
import { RateLimiter } from '../rate-limit.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';
import { eventually } from './harness.js';

const HEARTBEAT_MS = 7777;
const REVOKE_CHECK_MS = 8888;

/** The public API on its own, without the orchestrator, so a stream's inner workings can be broken on purpose. */
async function startApi(t: TestContext, limits: Partial<HttpLimits> = {}, hub = new FeedHub()) {
  const dir = await mkdtemp(join(tmpdir(), 'streams-test-'));
  const db = openDatabase(join(dir, 'server.sqlite'));
  const invites = new InviteStore(join(dir, 'invites.sqlite'));
  const { token, inviteId } = invites.create('test');
  let n = 0;
  const conversations = new ConversationStore(db, hub, () => ({
    sessionId: `ses_${n++}`,
    token: 'unused',
  }));
  const api = new PublicApi({
    db,
    memory: new MemoryStore(db),
    invites,
    conversations,
    tasks: new SqliteTaskStore(db, hub),
    hub,
    messageLimiter: new RateLimiter(1_000_000),
    controlLimiter: new RateLimiter(1_000_000),
    orchestrator: {
      rootSessionOfTask: () => undefined,
      cancelAs: () => Promise.reject(new Error('unused')),
      pauseAs: () => Promise.reject(new Error('unused')),
      resumeAs: () => Promise.reject(new Error('unused')),
    },
    artifacts: { read: () => Promise.resolve({ ok: false, reason: 'not_found' }) },
    artifactLimiter: new RateLimiter(1_000_000),
    limits: {
      ...DEFAULT_HTTP_LIMITS,
      heartbeatMs: HEARTBEAT_MS,
      revokeCheckMs: REVOKE_CHECK_MS,
      ...limits,
    },
    onMessage: () => undefined,
  });
  const server: Server = createServer((req, res) => {
    void api.handle(req, res);
  });
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    invites.close();
    try {
      db.close();
    } catch {
      // A test closed it already.
    }
    await rm(dir, { recursive: true, force: true });
  });
  return {
    api,
    hub,
    db,
    conversations,
    token,
    inviteId,
    invites,
    port,
    server,
    get connections() {
      return sockets.size;
    },
  };
}

type Api = Awaited<ReturnType<typeof startApi>>;

/** A raw connection, so the test decides when it reads. */
async function rawStream(t: TestContext, api: Api, { paused = false } = {}) {
  const socket = net.connect(api.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  if (paused) socket.pause();
  socket.write(
    `GET /v1/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${api.token}\r\nAccept: text/event-stream\r\n\r\n`,
  );
  return socket;
}

async function streamStatus(api: Api): Promise<number> {
  const abort = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${api.port}/v1/events`, {
      headers: { authorization: `Bearer ${api.token}` },
      signal: abort.signal,
    });
    return res.status;
  } catch {
    return 0;
  } finally {
    abort.abort();
  }
}

const exits: Array<{
  name: string;
  /** Ends the one open stream; `socket` is that stream's connection. */
  end(api: Api, socket: net.Socket): void | Promise<void>;
  options?: { paused?: boolean; limits?: Partial<HttpLimits>; fill?: boolean };
}> = [
  { name: 'the client disconnects', end: (_api, socket) => void socket.destroy() },
  { name: 'the server shuts the stream down', end: (api) => api.api.closeStreams() },
  {
    name: 'reading the feed fails',
    end: (api) => {
      api.db.close();
      api.hub.notify();
    },
  },
  { name: 'the invite is revoked', end: (api) => void api.invites.revoke(api.inviteId) },
  {
    name: 'the client stops reading and the drain times out',
    end: () => undefined,
    options: { paused: true, limits: { drainTimeoutMs: 100 }, fill: true },
  },
];

for (const exit of exits) {
  test(`when ${exit.name}, the stream frees its slots, its feed subscription, its heartbeat and its revoke watch`, async (t) => {
    const timers: NodeJS.Timeout[] = [];
    const watches: NodeJS.Timeout[] = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    mock.method(globalThis, 'setInterval', (handler: () => void, ms?: number, ...rest: []) => {
      const timer = realSet(handler, ms, ...rest);
      if (ms === HEARTBEAT_MS) timers.push(timer);
      if (ms === REVOKE_CHECK_MS) watches.push(timer);
      return timer;
    });
    mock.method(globalThis, 'clearInterval', (timer?: NodeJS.Timeout) => {
      cleared.add(timer);
      realClear(timer);
    });
    t.after(() => mock.restoreAll());

    const api = await startApi(t, { streamsPerInvite: 1, ...exit.options?.limits });
    if (exit.options?.fill) {
      const big = 'x'.repeat(30_000);
      const { conversationId } = api.conversations.create(api.inviteId);
      for (let i = 0; i < 400; i += 1) api.conversations.post(conversationId, `${i} ${big}`);
    }
    const socket = await rawStream(t, api, { paused: exit.options?.paused ?? false });
    await eventually(() => api.api.openStreams === 1, 'stream opened');
    assert.equal(api.hub.listening, 1);
    assert.equal(timers.length, 1, 'one heartbeat timer per stream');
    assert.equal(watches.length, 1, 'one revoke watch while a stream is open');
    assert.equal(api.api.watchingRevokes, true);

    await exit.end(api, socket);
    await eventually(() => api.api.openStreams === 0, 'stream released', 5000);

    assert.equal(api.hub.listening, 0, 'the feed subscription is gone');
    assert.ok(
      timers.every((timer) => cleared.has(timer)),
      'the heartbeat timer was cleared',
    );
    assert.ok(
      watches.every((timer) => cleared.has(timer)),
      'the revoke watch timer was cleared',
    );
    assert.equal(api.api.watchingRevokes, false, 'the revoke listener is gone');
    // The per-invite slot is free again: with a limit of one, the next stream is not turned away
    // (its connection may still be cut at once when the exit was a broken feed, and a revoked
    // invite is turned away at the door).
    assert.notEqual(await streamStatus(api), 429);
  });
}

test('a client that stops reading loses its connection as well as its slot', async (t) => {
  const api = await startApi(t, { drainTimeoutMs: 100 });
  const big = 'x'.repeat(30_000);
  const { conversationId } = api.conversations.create(api.inviteId);
  for (let i = 0; i < 400; i += 1) api.conversations.post(conversationId, `${i} ${big}`);
  await rawStream(t, api, { paused: true });
  await eventually(() => api.api.openStreams === 1, 'stream opened');
  await eventually(() => api.api.openStreams === 0, 'slot released', 5000);
  await eventually(() => api.connections === 0, 'socket dropped');
});

test('a stream that fails while it is being set up gives its slot back and answers 500', async (t) => {
  const hub = new FeedHub();
  const api = await startApi(t, { streamsPerInvite: 1 }, hub);
  const subscribe = hub.subscribe.bind(hub);
  mock.method(hub, 'subscribe', () => {
    throw new Error('subscribe failed');
  });
  assert.equal(await streamStatus(api), 500);
  assert.equal(api.api.openStreams, 0);
  mock.method(hub, 'subscribe', subscribe);
  assert.equal(await streamStatus(api), 200, 'the per-invite slot was released');
});

test('heartbeats wait for the client too: an idle stream whose client stopped taking data is dropped', async (t) => {
  // Every heartbeat reports a full buffer, as on a client that stopped reading,
  // and no 'drain' ever comes.
  const write = ServerResponse.prototype.write;
  mock.method(
    ServerResponse.prototype,
    'write',
    function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
      const accepted = (write as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
      return chunk === ': keep-alive\n\n' ? false : accepted;
    },
  );
  t.after(() => mock.restoreAll());
  const api = await startApi(t, { heartbeatMs: 10, drainTimeoutMs: 50 });
  await rawStream(t, api);
  await eventually(() => api.api.openStreams === 1, 'stream opened');
  await eventually(() => api.api.openStreams === 0, 'idle stalled stream dropped', 2000);
  await eventually(() => api.connections === 0, 'socket dropped');
});
