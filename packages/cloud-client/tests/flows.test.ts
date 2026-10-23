import { expect, test } from 'vitest';
import {
  CloudClient,
  ConversationFeed,
  ConversationStarter,
  HomeFeed,
  type InboxItem,
  openWorkspace,
  randomId,
  type VisitStore,
} from '../src/index';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A client whose server is a function of the path. Nothing leaves the process. */
function served(routes: Record<string, Handler>, options: { onRevoked?: () => void } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    // The longest matching prefix wins, so '/v1/inbox/items/i1/answer' is not '/v1/inbox/items'.
    const key = Object.keys(routes)
      .filter((prefix) => String(url).startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    return key ? routes[key]?.(String(url), init ?? {}) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { client: new CloudClient('fake-invite', { ...options, fetcher }), calls, fetcher };
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
};

const sse = (...frames: string[]) =>
  new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });
const posted = (id: number, text: string) =>
  `id: ${id}\nevent: message.posted\ndata: {"conversationId":"c1","messageId":"m${id}","role":"user","text":"${text}","at":${id}}\n\n`;

test('a conversation feed folds the stream into state and says it is live', async () => {
  const { client } = served({
    '/v1/events': () => sse(posted(1, 'hello'), posted(2, 'again')),
  });
  const feed = new ConversationFeed(client, 'c1');
  const seen: string[] = [];
  feed.subscribe(() => seen.push(feed.getSnapshot().status));
  expect(feed.getSnapshot().status).toBe('Connecting…');
  feed.start();
  await until(() => feed.getSnapshot().state.messages.length === 2, 'two messages');
  expect(feed.getSnapshot().state.messages.map((m) => m.text)).toEqual(['hello', 'again']);
  expect(seen).toContain('Live');
  feed.stop();
});

test('a message that failed to post is retried under the same id; a changed draft is a new one', async () => {
  const bodies: { clientMessageId: string; text: string }[] = [];
  let failNext = true;
  const { client } = served({
    '/v1/events': () => sse(),
    '/v1/conversations/c1/messages': (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      if (failNext) {
        failNext = false;
        return new Response('{}', { status: 500 });
      }
      return Response.json({ messageId: 'm' });
    },
  });
  const feed = new ConversationFeed(client, 'c1');
  expect(await feed.send('  hello  ')).toBe(false);
  expect(feed.getSnapshot().error).not.toBe('');
  expect(await feed.send('hello')).toBe(true);
  expect(feed.getSnapshot().error).toBe('');
  expect(bodies.map((b) => b.text)).toEqual(['hello', 'hello']);
  expect(bodies[1]?.clientMessageId).toBe(bodies[0]?.clientMessageId);
  // After a success the next message has its own id.
  await feed.send('next');
  expect(bodies[2]?.clientMessageId).not.toBe(bodies[0]?.clientMessageId);
  // Edited text after a failure is a different message.
  failNext = true;
  await feed.send('draft');
  feed.draftEdited();
  await feed.send('draft edited');
  expect(bodies[4]?.clientMessageId).not.toBe(bodies[3]?.clientMessageId);
  expect(await feed.send('   ')).toBe(false);
});

test('one action runs at a time: a second tap while one is in flight does nothing', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  const { client } = served({
    '/v1/conversations/c1/messages': async () => {
      posts += 1;
      await gate;
      return Response.json({ messageId: 'm' });
    },
  });
  const feed = new ConversationFeed(client, 'c1');
  const first = feed.send('one');
  await until(() => feed.getSnapshot().busy === 'message', 'busy');
  expect(await feed.send('two')).toBe(false);
  release();
  expect(await first).toBe(true);
  expect(posts).toBe(1);
  expect(feed.getSnapshot().busy).toBe('');
});

test('a runner that cannot pause is remembered, and the error still reaches the caller', async () => {
  const { client } = served({
    '/v1/tasks/t1/pause': () => Response.json({ error: 'pause_unsupported' }, { status: 409 }),
  });
  const feed = new ConversationFeed(client, 'c1');
  await expect(feed.control('t1', 'pause')).rejects.toBeDefined();
  expect(feed.getSnapshot().noPause.has('t1')).toBe(true);
});

const card = (over: Partial<InboxItem> = {}): InboxItem => ({
  itemId: 'i1',
  kind: 'approval',
  conversationId: 'c1',
  taskId: 't1',
  ask: 'Approve the push?',
  options: [{ id: 'yes', label: 'Approve', recommended: true }],
  allowText: false,
  evidence: [],
  state: 'open',
  closeReason: null,
  preconditionHash: 'h1',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const memoryVisits = (initial: Record<string, number> = {}) => {
  const held = { ...initial };
  const store: VisitStore = {
    read: (fingerprint) => held[fingerprint],
    write: (fingerprint, at) => {
      held[fingerprint] = at;
    },
  };
  return { held, store };
};

test('Home fills in as data arrives: a card is answered once, a stale card refreshes instead of acting', async () => {
  const answers: { answerId: string; preconditionHash: string }[] = [];
  const { client } = served({
    '/v1/inbox/items/i1/answer': (_url, init) => {
      answers.push(JSON.parse(String(init.body)));
      return answers.length === 1
        ? Response.json({ item: card({ state: 'closed', version: 2, updatedAt: 2 }) })
        : Response.json({ item: card({ state: 'closed', version: 2 }) }, { status: 409 });
    },
    '/v1/inbox/items': () => Response.json({ items: [card()] }),
    '/v1/projects': () => new Response('{}', { status: 404 }),
    '/v1/conversations/c1/tasks': () => Response.json({ tasks: [] }),
  });
  const { store } = memoryVisits();
  const feed = new HomeFeed(client, store, () => 1_700_000_000_000);
  feed.start([{ conversationId: 'c1', title: null, createdAt: 1 }]);
  await until(() => Object.keys(feed.getSnapshot().items).length === 1, 'the card');
  await until(() => feed.getSnapshot().done !== undefined, 'results');
  await until(() => feed.getSnapshot().since !== undefined, 'the last visit');
  // No duties engine: Projects stay unknown rather than empty.
  expect(feed.getSnapshot().projects).toBeUndefined();
  expect(feed.getSnapshot().since).toBe(1_700_000_000_000 - 86_400_000);

  const open = feed.getSnapshot().items.i1 as InboxItem;
  await feed.answer(open, 'yes');
  expect(feed.getSnapshot().items.i1?.state).toBe('closed');
  expect(answers).toHaveLength(1);
  // The same stale card answered again: the server refuses with the item, the card refreshes, the error is said.
  await feed.answer(open, 'yes');
  expect(feed.getSnapshot().answerError).not.toBe('');
  expect(feed.getSnapshot().busy).toBe(false);
  feed.stop();
});

test('Home tells "nothing waits" from "not read yet" and from "could not be read"', async () => {
  let fail = true;
  const { client } = served({
    '/v1/inbox/items': () =>
      fail ? new Response('{}', { status: 500 }) : Response.json({ items: [] }),
    '/v1/projects': () => new Response('{}', { status: 404 }),
  });
  const feed = new HomeFeed(client, memoryVisits().store, () => 1_700_000_000_000);
  expect(feed.getSnapshot().inboxLoaded).toBe(false);
  feed.start([]);
  await until(() => feed.getSnapshot().inboxFailed, 'the failed read');
  expect(feed.getSnapshot().inboxLoaded).toBe(false);
  fail = false;
  feed.refresh();
  await until(() => feed.getSnapshot().inboxLoaded, 'the empty list');
  expect(feed.getSnapshot().inboxFailed).toBe(false);
  feed.stop();
});

test('Home remembers the visit when the person leaves, under the invite fingerprint, never the token', async () => {
  const { client } = served({
    '/v1/inbox/items': () => Response.json({ items: [] }),
    '/v1/projects': () => Response.json({ projects: [] }),
  });
  const print = await client.fingerprint();
  const { held, store } = memoryVisits({ [print]: 5_000 });
  const feed = new HomeFeed(client, store, () => 9_000);
  feed.start([]);
  await until(() => feed.getSnapshot().since !== undefined, 'the last visit');
  expect(feed.getSnapshot().since).toBe(5_000);
  expect(feed.getSnapshot().projects).toEqual([]);
  feed.stop();
  expect(held[print]).toBe(9_000);
  expect(JSON.stringify(held)).not.toContain('fake-invite');
});

test('a retry of a failed start is one conversation and one message; editing makes a new message', async () => {
  const posts: { clientMessageId: string }[] = [];
  let conversations = 0;
  let failPost = true;
  const { client } = served({
    '/v1/conversations/c-new/messages': (_url, init) => {
      posts.push(JSON.parse(String(init.body)));
      if (failPost) {
        failPost = false;
        return new Response('{}', { status: 500 });
      }
      return Response.json({ messageId: 'm' });
    },
    '/v1/conversations': () => {
      conversations += 1;
      return Response.json({ conversationId: 'c-new' });
    },
  });
  const starter = new ConversationStarter(client, () => 42);
  await expect(starter.start('plan the launch')).rejects.toBeDefined();
  starter.draftEdited();
  const started = await starter.start('plan the launch, please');
  // Named from the sentence it was created with; a retry reuses the conversation and its name.
  expect(started).toEqual({ conversationId: 'c-new', title: 'plan the launch', createdAt: 42 });
  expect(conversations).toBe(1);
  expect(posts[1]?.clientMessageId).not.toBe(posts[0]?.clientMessageId);
});

test('signing in lands on the latest conversation, or on Home for a first visit', async () => {
  const some = served({
    '/v1/conversations': () =>
      Response.json({
        conversations: [
          { conversationId: 'a', title: null, createdAt: 1 },
          { conversationId: 'b', title: null, createdAt: 2 },
        ],
      }),
  });
  const workspace = await openWorkspace('fake', { fetcher: some.fetcher, onRevoked: () => {} });
  expect([workspace.chosen, workspace.landing]).toEqual(['b', 'chat']);
  const none = served({ '/v1/conversations': () => Response.json({ conversations: [] }) });
  const first = await openWorkspace('fake', { fetcher: none.fetcher, onRevoked: () => {} });
  expect([first.chosen, first.landing]).toEqual(['', 'home']);
  // A refused invite is the client's error, said by the caller.
  let revoked = 0;
  const refused = served({ '/v1/conversations': () => new Response('{}', { status: 401 }) });
  await expect(
    openWorkspace('fake', { fetcher: refused.fetcher, onRevoked: () => (revoked += 1) }),
  ).rejects.toBeDefined();
  expect(revoked).toBe(1);
});

test('ids are unique and well-formed with and without crypto.randomUUID', () => {
  const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  expect(randomId()).toMatch(shape);
  const original = globalThis.crypto;
  try {
    for (const fake of [
      { getRandomValues: original.getRandomValues.bind(original) },
      {},
    ] as unknown[]) {
      Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true });
      const ids = new Set(Array.from({ length: 50 }, randomId));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(shape);
    }
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  }
});

test('a message to a running task carries a key so a retry applies once, and a withdrawal is a DELETE on that key', async () => {
  const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
  const { client } = served({
    '/v1/tasks/tsk_1/messages': (url, init) => {
      seen.push({
        url,
        ...(init.method ? { method: init.method } : {}),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const key = url.split('/').at(-1) ?? '';
      return Response.json({
        message: {
          messageId: key === 'messages' ? 'sent' : key,
          state: init.method === 'DELETE' ? 'withdrawn' : 'pending',
        },
      });
    },
  });
  const sent = await client.sendTaskMessage('tsk_1', 'Use the v2 API.', 'm1');
  expect(sent.message.state).toBe('pending');
  const withdrawn = await client.withdrawTaskMessage('tsk_1', 'm1');
  expect(withdrawn.message).toEqual({ messageId: 'm1', state: 'withdrawn' });
  expect(seen).toEqual([
    {
      url: '/v1/tasks/tsk_1/messages',
      method: 'POST',
      body: { text: 'Use the v2 API.', messageId: 'm1' },
    },
    { url: '/v1/tasks/tsk_1/messages/m1', method: 'DELETE' },
  ]);
  // Without a key one is made, and it is in the body: the retry sends the same one.
  await client.sendTaskMessage('tsk_1', 'x');
  expect(typeof (seen[2]?.body as { messageId?: unknown } | undefined)?.messageId).toBe('string');
});

test('the timeline is read from the task’s timeline route', async () => {
  const { client, calls } = served({
    '/v1/tasks/tsk_1/timeline': () =>
      Response.json({
        timeline: { taskId: 'tsk_1', state: 'running', steps: [], turns: [], cost: [] },
      }),
  });
  expect((await client.timeline('tsk_1')).timeline.taskId).toBe('tsk_1');
  expect(calls[0]?.url).toBe('/v1/tasks/tsk_1/timeline');
});

test('a feed stopped and started again replays from the start without doubling anything', async () => {
  const seen: (string | null)[] = [];
  const notice = (id: number) =>
    `id: ${id}\nevent: conductor.notice\ndata: {"conversationId":"c1","noticeId":"n${id}","text":"note ${id}","at":${id}}\n\n`;
  const task = (id: number, event: object) =>
    `id: ${id}\nevent: task.event\ndata: ${JSON.stringify({ conversationId: 'c1', at: id, event })}\n\n`;
  const replay = () =>
    sse(
      posted(1, 'hello'),
      notice(2),
      task(3, { type: 'task_created', taskId: 't1', sessionId: 's', mode: 'async' }),
      task(4, { type: 'task_started', taskId: 't1' }),
      task(5, { type: 'task_progress', taskId: 't1', note: 'step one' }),
      task(6, { type: 'task_progress', taskId: 't1', note: 'step two' }),
    );
  const { client } = served({
    '/v1/events': (_url, init) => {
      seen.push(new Headers(init.headers).get('Last-Event-ID'));
      return replay();
    },
  });
  const feed = new ConversationFeed(client, 'c1');
  feed.start();
  await until(() => feed.getSnapshot().state.tasks.t1?.progress.length === 2, 'the first run');
  feed.stop();
  feed.start();
  await until(() => seen.length === 2, 'the second request');
  await until(() => feed.getSnapshot().state.tasks.t1?.progress.length === 2, 'the second run');
  await new Promise((r) => setTimeout(r, 30));
  // No remembered id is sent (after a restored backup it would be higher than the server's), and
  // the replay changes nothing.
  expect(seen).toEqual([null, null]);
  const { state } = feed.getSnapshot();
  expect(state.messages.map((m) => m.text)).toEqual(['hello', 'note 2']);
  expect(state.tasks.t1?.progress).toEqual(['step one', 'step two']);
  feed.stop();
});

test('Home takes the server’s cards and order, tells the server what was seen, and moves a card through it', async () => {
  const card = (cardId: string, kind: string, rank: number) => ({
    cardId,
    kind,
    ref: { type: 'inbox', id: cardId },
    rank,
    seenAt: null,
    at: rank,
  });
  const seen: unknown[] = [];
  const moves: unknown[] = [];
  const { client } = served({
    '/v1/home/seen': (_url, init) => {
      seen.push(JSON.parse(String(init.body)));
      return Response.json({ seen: [], visitedAt: 1 });
    },
    '/v1/home/order': (_url, init) => {
      moves.push(JSON.parse(String(init.body)));
      return Response.json({
        cards: [card('waiting:b', 'waiting', 0), card('waiting:a', 'waiting', 1)],
      });
    },
    '/v1/home': () =>
      Response.json({ cards: [card('waiting:a', 'waiting', 0), card('waiting:b', 'waiting', 1)] }),
    '/v1/inbox/items': () => Response.json({ items: [] }),
    '/v1/projects': () => new Response('{}', { status: 404 }),
  });
  const feed = new HomeFeed(client, memoryVisits().store, () => 1_700_000_000_000);
  expect(feed.getSnapshot().cards).toBeUndefined();
  feed.start([]);
  await until(() => feed.getSnapshot().cards !== undefined, 'the cards');
  expect(feed.getSnapshot().cards?.map((c) => c.cardId)).toEqual(['waiting:a', 'waiting:b']);

  await feed.moveCard('waiting:b', null);
  expect(moves).toEqual([{ cardId: 'waiting:b', after: null }]);
  expect(feed.getSnapshot().cards?.map((c) => c.cardId)).toEqual(['waiting:b', 'waiting:a']);

  feed.stop();
  await until(() => seen.length === 1, 'the visit');
  expect(seen).toEqual([{ cardIds: ['waiting:b', 'waiting:a'] }]);
});

test('Home tells the server only the cards the screen showed, at most 100, once per visit', async () => {
  const cards = Array.from({ length: 120 }, (_, i) => ({
    cardId: `waiting:i${i}`,
    kind: 'waiting',
    ref: { type: 'inbox', id: `i${i}` },
    rank: i,
    seenAt: null,
    at: i,
  }));
  const seen: Array<{ cardIds: string[] }> = [];
  const { client } = served({
    '/v1/home/seen': (_url, init) => {
      seen.push(JSON.parse(String(init.body)));
      return Response.json({ seen: [], visitedAt: 1 });
    },
    '/v1/home': () => Response.json({ cards }),
    '/v1/inbox/items': () => Response.json({ items: [] }),
    '/v1/projects': () => new Response('{}', { status: 404 }),
  });
  const feed = new HomeFeed(client, memoryVisits().store, () => 1_700_000_000_000);
  feed.start([]);
  await until(() => feed.getSnapshot().cards !== undefined, 'the cards');

  feed.leave(['waiting:i3', 'waiting:i1']);
  // Leaving again (the screen goes away after the app went to the background) tells nothing new.
  feed.leave(['waiting:i3']);
  await until(() => seen.length === 1, 'the visit');
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toEqual([{ cardIds: ['waiting:i3', 'waiting:i1'] }]);

  // Back on Home, it is read again: leaving now is a new visit. Left with every card, the server
  // is told 100 at most.
  const shown = feed.getSnapshot().cards;
  feed.refresh();
  await until(() => feed.getSnapshot().cards !== shown, 'the cards read again');
  feed.stop();
  await until(() => seen.length === 2, 'the second visit');
  expect(seen[1]?.cardIds).toHaveLength(100);
  expect(seen[1]?.cardIds[0]).toBe('waiting:i0');
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toHaveLength(2);
});

test("a failed read of a conversation's tasks keeps what Home last read of them", async () => {
  let down = false;
  const running = {
    taskId: 't1',
    state: 'running',
    createdAt: 1,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
  };
  const { client } = served({
    '/v1/conversations/c1/tasks': () =>
      down ? new Response('{}', { status: 500 }) : Response.json({ tasks: [running] }),
    '/v1/inbox/items': () => Response.json({ items: [] }),
    '/v1/projects': () => new Response('{}', { status: 404 }),
  });
  const feed = new HomeFeed(client, memoryVisits().store, () => 1_700_000_000_000);
  feed.start([{ conversationId: 'c1', title: 'Release', createdAt: 1 }]);
  await until(() => feed.getSnapshot().done?.get('c1')?.length === 1, 'the tasks');
  const first = feed.getSnapshot().done;
  down = true;
  feed.refresh();
  await until(() => feed.getSnapshot().done !== first, 'the second read');
  expect(
    feed
      .getSnapshot()
      .done?.get('c1')
      ?.map((t) => t.taskId),
  ).toEqual(['t1']);
  feed.stop();
});

test('Home without a server Home stays on its own parts and tells the server nothing', async () => {
  const { client, calls } = served({
    '/v1/inbox/items': () => Response.json({ items: [] }),
    '/v1/projects': () => new Response('{}', { status: 404 }),
  });
  const feed = new HomeFeed(client, memoryVisits().store, () => 1_700_000_000_000);
  feed.start([]);
  await until(() => feed.getSnapshot().inboxLoaded, 'the inbox');
  await until(() => client.unsupported.has('home'), 'the answer of /v1/home');
  expect(feed.getSnapshot().cards).toBeUndefined();
  feed.stop();
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.some((c) => c.url.startsWith('/v1/home/seen'))).toBe(false);
});
