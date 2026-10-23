import { expect, test } from 'vitest';
import { CloudClient } from '../src/client';
import { connectionAction, connectionNeedsBanner, connectionText } from '../src/connection';
import { ConversationFeed, type SendFailure, sendFailureText } from '../src/conversation';
import { OUTBOX_KEEP_MS, storageOutbox, webStorageOutbox } from '../src/outbox';

/** A Web Storage stand-in that outlives the feeds made over it, like localStorage over a reload. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
};

type Answer = (body: { text: string; clientMessageId: string }) => Response | Promise<Response>;

/**
 * A server with one conversation, `c1`: posts go to `answer`, and `push` sends frames down the open
 * event stream. A post the answer throws on (a lost acknowledgment) still lands, as on a real server.
 */
function server(answer: Answer = () => Response.json({ messageId: 'srv' }, { status: 202 })) {
  const posts: { text: string; clientMessageId: string }[] = [];
  let push: (frame: string) => void = () => {};
  let streams = 0;
  let nextId = 0;
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith('/v1/events')) {
      streams += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (frame) => controller.enqueue(new TextEncoder().encode(frame));
          push(': open\n\n');
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { text: string; clientMessageId: string };
      posts.push(body);
      return answer(body);
    }
    if (path.endsWith('/tasks')) return Response.json({ tasks: [] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return {
    posts,
    fetcher,
    streams: () => streams,
    /** The person's message as the stream carries it; `clientMessageId` only when given. */
    posted(text: string, clientMessageId?: string, messageId = `m${++nextId}`) {
      const data = {
        conversationId: 'c1',
        messageId,
        role: 'user',
        text,
        at: nextId,
        ...(clientMessageId ? { clientMessageId } : {}),
      };
      push(`id: ${++nextId}\nevent: message.posted\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
}

test('a lost acknowledgment leaves the message failed and kept; after a reload it is offered again, never resent on its own', async () => {
  const storage = memoryStorage();
  let lose = true;
  const api = server(() => {
    if (lose) {
      lose = false;
      throw new TypeError('network: the acknowledgment was lost');
    }
    return Response.json({ messageId: 'srv' }, { status: 202 });
  });
  const client = new CloudClient('t', api.fetcher);
  const first = new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage));
  expect(await first.send('Fix the login loop')).toBe(false);
  expect(first.getSnapshot().outgoing[0]?.status).toEqual({
    state: 'failed',
    reason: 'offline',
    retryable: true,
  });
  expect(storage.map.size).toBe(1);
  // The app is killed and opened again: a new feed over the same storage.
  const reloaded = new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage));
  await until(() => reloaded.getSnapshot().outgoing.length === 1, 'the kept message');
  const [back] = reloaded.getSnapshot().outgoing;
  expect(back?.text).toBe('Fix the login loop');
  // It says why its last try failed.
  expect(back?.status).toEqual({ state: 'failed', reason: 'offline', retryable: true });
  expect(api.posts).toHaveLength(1);
  // Sent again by the person, under the same id: the server runs it once.
  expect(await reloaded.retry(back?.id ?? '')).toBe(true);
  expect(api.posts.map((p) => p.clientMessageId)).toEqual([
    api.posts[0]?.clientMessageId,
    api.posts[0]?.clientMessageId,
  ]);
  expect(storage.map.size).toBe(0);
});

test('a message still on its way when the app is killed comes back as interrupted', async () => {
  const storage = memoryStorage();
  // The post never answers: the app is gone before it does.
  const api = server(() => new Promise<Response>(() => {}));
  const client = new CloudClient('t', api.fetcher);
  void new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage)).send('Pay the invoice');
  await until(() => api.posts.length === 1, 'the post');
  const reloaded = new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage));
  await until(() => reloaded.getSnapshot().outgoing.length === 1, 'the kept message');
  expect(reloaded.getSnapshot().outgoing[0]?.status).toEqual({
    state: 'failed',
    reason: 'interrupted',
    retryable: true,
  });
  expect(api.posts).toHaveLength(1);
});

test('a kept message the conversation already shows is dropped when the feed opens', async () => {
  const storage = memoryStorage();
  const api = server(() => {
    throw new TypeError('lost');
  });
  const client = new CloudClient('t', api.fetcher);
  await new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage)).send('Book the flight');
  const id = api.posts[0]?.clientMessageId;
  const reloaded = new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage));
  await until(() => reloaded.getSnapshot().outgoing.length === 1, 'the kept message');
  reloaded.start();
  await until(
    () => api.streams() === 1 && reloaded.getSnapshot().connection.state === 'live',
    'live',
  );
  api.posted('Book the flight', id);
  await until(() => reloaded.getSnapshot().outgoing.length === 0, 'the message to show');
  await until(() => storage.map.size === 0, 'the outbox to clear');
  expect(reloaded.getSnapshot().state.messages.map((m) => m.text)).toEqual(['Book the flight']);
  reloaded.stop();
});

test('a sent message stays until the conversation shows it: by its id, or by its words after the last one', async () => {
  const api = server((body) =>
    body.text === 'by id'
      ? Response.json({ messageId: 'srv-1' }, { status: 202 })
      : Response.json({}, { status: 202 }),
  );
  const feed = new ConversationFeed(new CloudClient('t', api.fetcher), 'c1');
  feed.start();
  await until(() => feed.getSnapshot().connection.state === 'live', 'live');
  api.posted('Try again');
  await until(() => feed.getSnapshot().state.messages.length === 1, 'the older message');
  expect(await feed.send('by id')).toBe(true);
  expect(feed.getSnapshot().outgoing[0]?.status).toEqual({ state: 'sent', messageId: 'srv-1' });
  api.posted('by id', undefined, 'srv-1');
  await until(() => feed.getSnapshot().outgoing.length === 0, 'matched by the server id');
  // A server that names no id: matched by the words, but an older message never stands in.
  expect(await feed.send('Try again')).toBe(true);
  api.posted('unrelated');
  await new Promise((r) => setTimeout(r, 30));
  expect(feed.getSnapshot().outgoing.map((m) => m.text)).toEqual(['Try again']);
  api.posted('Try again');
  await until(() => feed.getSnapshot().outgoing.length === 0, 'matched by the words');
  // A message that names another client id is not this one, whatever its words.
  expect(await feed.send('same words')).toBe(true);
  api.posted('same words', 'someone-elses-id');
  await new Promise((r) => setTimeout(r, 30));
  expect(feed.getSnapshot().outgoing).toHaveLength(1);
  feed.stop();
});

test('an id reused for other words is refused for good: not retryable, not kept, and can be discarded', async () => {
  const storage = memoryStorage();
  const api = server(() => Response.json({ error: 'client_message_id_conflict' }, { status: 409 }));
  const feed = new ConversationFeed(
    new CloudClient('t', api.fetcher),
    'c1',
    0,
    webStorageOutbox(storage),
  );
  expect(await feed.send('cancel the flight')).toBe(false);
  const [refused] = feed.getSnapshot().outgoing;
  expect(refused?.status).toEqual({ state: 'failed', reason: 'conflict', retryable: false });
  expect(storage.map.size).toBe(0);
  expect(await feed.retry(refused?.id ?? '')).toBe(false);
  expect(api.posts).toHaveLength(1);
  feed.discard(refused?.id ?? '');
  expect(feed.getSnapshot().outgoing).toEqual([]);
});

test('a failed post says why, and whether trying again can help', async () => {
  const cases: [Response | Error, SendFailure, boolean][] = [
    [new TypeError('offline'), 'offline', true],
    [new Response('{}', { status: 503 }), 'server', true],
    [new Response('{}', { status: 429 }), 'server', true],
    [Response.json({ error: 'text_too_long' }, { status: 400 }), 'rejected', false],
    [new Response('{}', { status: 401 }), 'signed_out', false],
  ];
  for (const [answer, reason, retryable] of cases) {
    const api = server(() => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const feed = new ConversationFeed(new CloudClient('t', api.fetcher), 'c1');
    expect(await feed.send('hello')).toBe(false);
    const status = feed.getSnapshot().outgoing[0]?.status;
    expect(status).toEqual({ state: 'failed', reason, retryable });
    expect(sendFailureText(reason)).not.toBe('');
  }
});

test('the outbox: a late remove of an older message never clears a newer one; old and junk records go', async () => {
  const storage = memoryStorage();
  let now = 1_000_000;
  const outbox = storageOutbox(
    {
      get: (k) => storage.getItem(k),
      // A slow store: every write waits a little, so calls overlap unless they run in order.
      set: (k, v) => new Promise<void>((r) => setTimeout(() => r(storage.setItem(k, v)), 5)),
      remove: (k) => storage.removeItem(k),
    },
    'maka.outbox.',
    () => now,
  );
  const entry = (id: string, at = now) => ({ id, conversationId: 'c1', text: id, at });
  await Promise.all([outbox.put(entry('a')), outbox.put(entry('b')), outbox.remove('c1', 'a')]);
  expect((await outbox.list('c1')).map((e) => e.id)).toEqual(['b']);
  await outbox.remove('c1', 'a');
  expect((await outbox.list('c1')).map((e) => e.id)).toEqual(['b']);
  now += OUTBOX_KEEP_MS;
  expect(await outbox.list('c1')).toEqual([]);
  storage.setItem(
    'maka.outbox.c2',
    '[{"id":"has spaces","conversationId":"c2","text":"t","at":1}]',
  );
  expect(await outbox.list('c2')).toEqual([]);
  storage.setItem('maka.outbox.c3', 'not json');
  expect(await outbox.list('c3')).toEqual([]);
});

test('storage that is blocked or full keeps nothing and breaks nothing', async () => {
  const blocked = webStorageOutbox({
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  });
  await expect(
    blocked.put({ id: 'a', conversationId: 'c', text: 't', at: Date.now() }),
  ).resolves.toBeUndefined();
  expect(await blocked.list('c')).toEqual([]);
  await expect(blocked.remove('c', 'a')).resolves.toBeUndefined();
  // And a feed over it still sends.
  const api = server();
  const feed = new ConversationFeed(new CloudClient('t', api.fetcher), 'c1', 0, blocked);
  expect(await feed.send('hello')).toBe(true);
});

test('the connection: offline with a time to retry, "Retry now" tries at once, then live', async () => {
  let fail = true;
  let tries = 0;
  const fetcher = (async (url: string | URL) => {
    if (!String(url).startsWith('/v1/events')) return Response.json({ tasks: [] });
    tries += 1;
    if (fail) throw new TypeError('no network');
    return new Response(': open\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const feed = new ConversationFeed(new CloudClient('t', fetcher), 'c1');
  expect(feed.getSnapshot().connection).toEqual({ state: 'connecting' });
  feed.start();
  await until(() => feed.getSnapshot().connection.state === 'offline', 'offline');
  const offline = feed.getSnapshot().connection;
  expect(offline.state === 'offline' && offline.retryAt > 0).toBe(true);
  expect(connectionNeedsBanner(offline)).toBe(true);
  expect(connectionAction(offline)).toBe('retry');
  expect(feed.getSnapshot().status).toBe(connectionText(offline));
  fail = false;
  feed.retryNow();
  await until(() => tries === 2, 'the second try');
  await until(() => feed.getSnapshot().connection.state !== 'offline', 'a new state');
  feed.stop();
});

test('a refused stream says signed out for a device session, invite expired for an invite', async () => {
  const refuse = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  for (const [token, state] of [
    ['mks_device', 'signed_out'],
    ['invite-token', 'invite_expired'],
  ] as const) {
    const feed = new ConversationFeed(new CloudClient(token, refuse), 'c1');
    feed.start();
    await until(() => feed.getSnapshot().connection.state === state, state);
    expect(connectionAction(feed.getSnapshot().connection)).toBe('sign_in');
    feed.stop();
  }
});
