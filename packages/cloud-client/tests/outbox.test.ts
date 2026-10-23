import { expect, test } from 'vitest';
import { CloudClient } from '../src/client';
import { connectionAction, connectionNeedsBanner, connectionText } from '../src/connection';
import { ConversationFeed, type SendFailure, sendFailureText } from '../src/conversation';
import {
  adoptPendingSend,
  OUTBOX_KEEP_MS,
  outboxScope,
  storageOutbox,
  webStorageOutbox,
} from '../src/outbox';
import { storagePendingSends } from '../src/pending';

/** A Web Storage stand-in that outlives the feeds made over it, like localStorage over a reload. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
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
function server(
  answer: Answer = () => Response.json({ messageId: 'srv' }, { status: 202 }),
  /** What the stream replays when it opens: the person's earlier messages, without client ids. */
  history: string[] = [],
) {
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
          history.forEach((text, index) => {
            const data = {
              conversationId: 'c1',
              messageId: `old${index}`,
              role: 'user',
              text,
              at: 0,
            };
            push(`id: ${index + 1}\nevent: message.posted\ndata: ${JSON.stringify(data)}\n\n`);
          });
          nextId = Math.max(nextId, history.length);
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
  const first = new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage, 'me'));
  expect(await first.send('Fix the login loop')).toBe(false);
  expect(first.getSnapshot().outgoing[0]?.status).toEqual({
    state: 'failed',
    reason: 'offline',
    retryable: true,
  });
  expect(storage.map.size).toBe(1);
  // The app is killed and opened again: a new feed over the same storage.
  const reloaded = new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage, 'me'));
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
  void new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage, 'me')).send(
    'Pay the invoice',
  );
  await until(() => api.posts.length === 1, 'the post');
  const reloaded = new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage, 'me'));
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
  await new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage, 'me')).send(
    'Book the flight',
  );
  const id = api.posts[0]?.clientMessageId;
  const reloaded = new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage, 'me'));
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
    webStorageOutbox(storage, 'me'),
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

test('the outbox: a late remove of an older message never clears a newer one; junk records go, old ones stay for the conversation to show', async () => {
  const storage = memoryStorage();
  const outbox = storageOutbox(
    {
      get: (k) => storage.getItem(k),
      // A slow store: every write waits a little, so calls overlap unless they run in order.
      set: (k, v) => new Promise<void>((r) => setTimeout(() => r(storage.setItem(k, v)), 5)),
      remove: (k) => storage.removeItem(k),
    },
    'me',
  );
  const entry = (id: string, at = 1_000_000) => ({ id, conversationId: 'c1', text: id, at });
  await Promise.all([outbox.put(entry('a')), outbox.put(entry('b')), outbox.remove('c1', 'a')]);
  expect((await outbox.list('c1')).map((e) => e.id)).toEqual(['b']);
  await outbox.remove('c1', 'a');
  expect((await outbox.list('c1')).map((e) => e.id)).toEqual(['b']);
  // However old, a message is not the store's to drop: the conversation shows it first.
  await outbox.put(entry('old', 0));
  expect((await outbox.list('c1')).map((e) => e.id)).toEqual(['old', 'b']);
  // A store without a key listing keeps an index: junk in it, or in a record, is dropped.
  storage.setItem('maka.outbox.me.c2', '["x"]');
  storage.setItem('maka.outbox.me.c2.x', '{"id":"has spaces","conversationId":"c2","text":"t"}');
  expect(await outbox.list('c2')).toEqual([]);
  expect(storage.map.has('maka.outbox.me.c2.x')).toBe(false);
  storage.setItem('maka.outbox.me.c3', 'not json');
  expect(await outbox.list('c3')).toEqual([]);
});

test('two tabs over the same storage never lose each other’s messages', async () => {
  const shared = memoryStorage();
  // The second tab's own view of the same storage: no queue is shared, so their calls interleave.
  const otherTab = {
    ...shared,
    setItem: (k: string, v: string) => shared.setItem(k, v),
    getItem: (k: string) => shared.getItem(k),
    removeItem: (k: string) => shared.removeItem(k),
    key: (i: number) => shared.key(i),
    get length() {
      return shared.map.size;
    },
  };
  const tabA = webStorageOutbox(shared, 'me');
  const tabB = webStorageOutbox(otherTab, 'me');
  const entry = (id: string) => ({ id, conversationId: 'c1', text: id, at: Date.now() });
  await Promise.all([tabA.put(entry('a')), tabB.put(entry('b'))]);
  expect((await tabA.list('c1')).map((e) => e.id).sort()).toEqual(['a', 'b']);
  await Promise.all([tabA.remove('c1', 'a'), tabB.put(entry('c'))]);
  expect((await tabB.list('c1')).map((e) => e.id).sort()).toEqual(['b', 'c']);
  expect((await tabA.list('c1')).map((e) => e.id).sort()).toEqual(['b', 'c']);
});

/** A server that names the account each token signs in as (`GET /v1/me`), or has no such route. */
function accounts(owners: Record<string, string> | undefined) {
  return (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith('/v1/me')) return Response.json({}, { status: 404 });
    if (!owners) return Response.json({ error: 'not_found' }, { status: 404 });
    const token = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? '';
    return Response.json({ ownerId: owners[token] });
  }) as typeof fetch;
}

test('each account on each server has its own outbox, and signing in again (a new token) finds it', async () => {
  const shared = memoryStorage();
  const owners = { mks_first: 'inv_ada', mks_again: 'inv_ada', mks_bob: 'inv_bob' };
  const box = (token: string, baseUrl = 'https://a.example', known = owners) =>
    webStorageOutbox(
      shared,
      new CloudClient(token, { baseUrl, fetcher: accounts(known) }).outboxScope(),
    );
  await box('mks_first').put({ id: 'm1', conversationId: 'c1', text: 'private words', at: 1 });
  // Signed out and in again: a new session token, the same account.
  expect((await box('mks_again').list('c1')).map((e) => e.text)).toEqual(['private words']);
  expect(await box('mks_bob').list('c1')).toEqual([]);
  expect(await box('mks_first', 'https://b.example').list('c1')).toEqual([]);
  // Keys carry neither the token nor the account id.
  const keys = [...shared.map.keys()].join();
  for (const secret of ['mks_first', 'mks_again', 'inv_ada']) expect(keys).not.toContain(secret);
  expect(outboxScope('https://a.example', 'owner:inv_ada')).not.toBe(
    outboxScope('https://b.example', 'owner:inv_ada'),
  );
});

test('a store that cannot list its keys (the phone’s secure store) finds the account’s messages after signing in again', async () => {
  const secure = new Map<string, string>();
  const store = {
    get: async (k: string) => secure.get(k) ?? null,
    set: async (k: string, v: string) => void secure.set(k, v),
    remove: async (k: string) => void secure.delete(k),
  };
  const owners = { mks_first: 'inv_ada', mks_again: 'inv_ada' };
  const box = (token: string) =>
    storageOutbox(
      store,
      new CloudClient(token, {
        baseUrl: 'https://a.example',
        fetcher: accounts(owners),
      }).outboxScope(),
    );
  await box('mks_first').put({ id: 'm1', conversationId: 'c1', text: 'kept', at: 1 });
  await box('mks_first').put({ id: 'm2', conversationId: 'c1', text: 'also kept', at: 2 });
  const again = box('mks_again');
  expect((await again.list('c1')).map((e) => e.id)).toEqual(['m1', 'm2']);
  await again.remove('c1', 'm1');
  expect((await box('mks_first').list('c1')).map((e) => e.id)).toEqual(['m2']);
  expect([...secure.keys()].every((key) => /^[A-Za-z0-9._-]+$/u.test(key))).toBe(true);
});

test('before the server names the account, messages are kept under the token and move to the account once it does', async () => {
  const shared = memoryStorage();
  // An older server: no /v1/me, so the token's own scope.
  const old = webStorageOutbox(
    shared,
    new CloudClient('mks_first', {
      baseUrl: 'https://a.example',
      fetcher: accounts(undefined),
    }).outboxScope(),
  );
  await old.put({ id: 'm1', conversationId: 'c1', text: 'kept under the token', at: 1 });
  expect((await old.list('c1')).map((e) => e.id)).toEqual(['m1']);
  // The server now names the account: what the token kept moves to it, so another session finds it.
  const named = { mks_first: 'inv_ada', mks_again: 'inv_ada' };
  const upgraded = webStorageOutbox(
    shared,
    new CloudClient('mks_first', {
      baseUrl: 'https://a.example',
      fetcher: accounts(named),
    }).outboxScope(),
  );
  expect((await upgraded.list('c1')).map((e) => e.id)).toEqual(['m1']);
  const again = webStorageOutbox(
    shared,
    new CloudClient('mks_again', {
      baseUrl: 'https://a.example',
      fetcher: accounts(named),
    }).outboxScope(),
  );
  expect((await again.list('c1')).map((e) => e.id)).toEqual(['m1']);
  // Offline later: the link the outbox kept still finds the account without asking.
  const offline = webStorageOutbox(
    shared,
    new CloudClient('mks_first', {
      baseUrl: 'https://a.example',
      fetcher: (async () => {
        throw new TypeError('offline');
      }) as typeof fetch,
    }).outboxScope(),
  );
  expect((await offline.list('c1')).map((e) => e.id)).toEqual(['m1']);
});

test('an unsent message is kept 30 days from its last try, then shown once as expired before it goes', async () => {
  const storage = memoryStorage();
  let now = 1_000_000;
  const api = server(() => {
    throw new TypeError('offline');
  });
  const client = new CloudClient('t', api.fetcher);
  const open = () =>
    new ConversationFeed(client, 'c1', 0, webStorageOutbox(storage, 'me'), () => now);
  const day = 24 * 60 * 60_000;
  expect(await open().send('Book the flight')).toBe(false);
  // Away for a long weekend, and longer: still there, saying why it failed.
  now += 29 * day;
  let feed = open();
  await until(() => feed.getSnapshot().outgoing.length === 1, 'the kept message');
  expect(feed.getSnapshot().outgoing[0]?.status).toMatchObject({ reason: 'offline' });
  // Tried again (and failed again): kept for another 30 days from now.
  expect(await feed.retry(feed.getSnapshot().outgoing[0]?.id ?? '')).toBe(false);
  now += 29 * day;
  feed = open();
  await until(() => feed.getSnapshot().outgoing.length === 1, 'the kept message');
  expect(feed.getSnapshot().outgoing[0]?.status).toMatchObject({ reason: 'offline' });
  // Past 30 days since its last try: shown this once, words and all, as expired.
  now += OUTBOX_KEEP_MS;
  feed = open();
  await until(() => feed.getSnapshot().outgoing.length === 1, 'the expired message');
  expect(feed.getSnapshot().outgoing[0]).toMatchObject({
    text: 'Book the flight',
    status: { state: 'failed', reason: 'expired', retryable: true },
  });
  await until(() => storage.map.size === 0, 'the device to let it go');
  feed = open();
  await new Promise((r) => setTimeout(r, 20));
  expect(feed.getSnapshot().outgoing).toEqual([]);
  expect(api.posts).toHaveLength(2);
});

test('a send kept the earlier way (sessionStorage) is taken over under its own id, never resent on its own', async () => {
  const session = memoryStorage();
  const local = memoryStorage();
  // What an earlier version left: this conversation's unacknowledged send, and a first message's.
  session.setItem(
    'maka.pending.c1',
    JSON.stringify({ id: 'legacy-1', text: 'Ship it', at: Date.now() }),
  );
  const start = JSON.stringify({ id: 'start-1', text: 'Hi', at: Date.now(), conversationId: 'c9' });
  session.setItem('maka.pending.start', start);
  const api = server();
  const outbox = webStorageOutbox(local, 'me');
  void adoptPendingSend(storagePendingSends(session), outbox, 'c1');
  const feed = new ConversationFeed(new CloudClient('t', api.fetcher), 'c1', 0, outbox);
  await until(() => feed.getSnapshot().outgoing.length === 1, 'the earlier send');
  expect(feed.getSnapshot().outgoing[0]).toMatchObject({
    id: 'legacy-1',
    text: 'Ship it',
    status: { state: 'failed', reason: 'interrupted', retryable: true },
  });
  await until(() => !session.map.has('maka.pending.c1'), 'the old record to go');
  expect(session.map.get('maka.pending.start')).toBe(start);
  expect(api.posts).toHaveLength(0);
  // Sent again by the person: the id the server may already have.
  expect(await feed.retry('legacy-1')).toBe(true);
  expect(api.posts.map((p) => p.clientMessageId)).toEqual(['legacy-1']);
});

test('an older message with the same words, replayed late, never takes the place of an unsent or unconfirmed one', async () => {
  const storage = memoryStorage();
  let offline = true;
  const api = server(() => {
    if (offline) throw new TypeError('offline');
    return Response.json({ messageId: 'srv-new' }, { status: 202 });
  }, ['Yes']);
  const feed = new ConversationFeed(
    new CloudClient('t', api.fetcher),
    'c1',
    0,
    webStorageOutbox(storage, 'me'),
  );
  // Sent before the stream has replayed anything, and it fails.
  expect(await feed.send('Yes')).toBe(false);
  feed.start();
  await until(() => feed.getSnapshot().state.messages.length === 1, 'the replayed older message');
  await new Promise((r) => setTimeout(r, 30));
  expect(feed.getSnapshot().outgoing.map((m) => m.status.state)).toEqual(['failed']);
  expect(storage.map.size).toBe(1);
  // Confirmed with the server's id: only that id, or its own client id, takes it off.
  offline = false;
  expect(await feed.retry(feed.getSnapshot().outgoing[0]?.id ?? '')).toBe(true);
  api.posted('Yes');
  await new Promise((r) => setTimeout(r, 30));
  expect(feed.getSnapshot().outgoing).toHaveLength(1);
  api.posted('Yes', undefined, 'srv-new');
  await until(() => feed.getSnapshot().outgoing.length === 0, 'matched by the server id');
  feed.stop();
});

test('storage that is blocked or full keeps nothing and breaks nothing', async () => {
  const blocked = webStorageOutbox(
    {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      key: () => {
        throw new Error('blocked');
      },
      length: 0,
    },
    'me',
  );
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
