import { expect, test } from 'vitest';
import { CloudClient } from '../src/client';
import { ConversationFeed } from '../src/conversation';
import { PENDING_SEND_MS, storagePendingSends } from '../src/pending';
import { ConversationStarter } from '../src/starter';

/** A Web Storage stand-in that outlives the feeds made over it, like sessionStorage over a reload. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** A server that records posts; `lose` drops the acknowledgment of the next post (it still lands). */
function server() {
  const posts: { path: string; id: string; text: string }[] = [];
  let lose = false;
  let created = 0;
  const fetcher = (async (url: string | URL, options?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/v1/conversations') && options?.method !== 'POST') {
      return Response.json({
        conversations: Array.from({ length: created }, (_, i) => ({
          conversationId: `cnv_${i + 1}`,
          title: null,
          createdAt: 0,
        })),
      });
    }
    if (path.endsWith('/v1/conversations') && options?.method === 'POST') {
      created += 1;
      return Response.json({ conversationId: `cnv_${created}` }, { status: 201 });
    }
    if (path.endsWith('/messages')) {
      const body = JSON.parse(String(options?.body)) as { text: string; clientMessageId: string };
      posts.push({ path, id: body.clientMessageId, text: body.text });
      if (lose) {
        lose = false;
        throw new TypeError('network: the acknowledgment was lost');
      }
      return Response.json({ messageId: 'm' }, { status: 202 });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return {
    posts,
    fetcher,
    loseNext: () => {
      lose = true;
    },
    created: () => created,
  };
}

test('the same text sent again after a reload reuses the unacknowledged id; an acknowledged one is cleared', async () => {
  const storage = memoryStorage();
  const api = server();
  const client = new CloudClient('t', api.fetcher);
  api.loseNext();
  const first = new ConversationFeed(client, 'cnv_a', 0, storagePendingSends(storage));
  expect(await first.send('Fix the login loop')).toBe(false);
  // The page reloads: a new feed, the same tab storage.
  const reloaded = new ConversationFeed(client, 'cnv_a', 0, storagePendingSends(storage));
  expect(await reloaded.send('Fix the login loop')).toBe(true);
  expect(api.posts.map((p) => p.id)).toEqual([api.posts[0]?.id, api.posts[0]?.id]);
  expect(storage.map.size).toBe(0);
  // Acknowledged, so the same words again are a new message.
  await reloaded.send('Fix the login loop');
  expect(new Set(api.posts.map((p) => p.id)).size).toBe(2);
});

test('different text, another conversation, or an hour later is a new message', async () => {
  const storage = memoryStorage();
  const api = server();
  const client = new CloudClient('t', api.fetcher);
  let now = 1_000_000;
  const feed = (id: string) =>
    new ConversationFeed(client, id, 0, storagePendingSends(storage), () => now);
  api.loseNext();
  await feed('cnv_a').send('One');
  await feed('cnv_a').send('Two');
  api.loseNext();
  await feed('cnv_a').send('Three');
  await feed('cnv_b').send('Three');
  api.loseNext();
  await feed('cnv_c').send('Four');
  now += PENDING_SEND_MS;
  await feed('cnv_c').send('Four');
  expect(new Set(api.posts.map((p) => p.id)).size).toBe(api.posts.length);
});

test('a first message after a reload reuses its conversation and id: one conversation, one message', async () => {
  const storage = memoryStorage();
  const api = server();
  const client = new CloudClient('t', api.fetcher);
  api.loseNext();
  await expect(
    new ConversationStarter(client, Date.now, storagePendingSends(storage)).start('Weekly report'),
  ).rejects.toThrow();
  const started = await new ConversationStarter(
    client,
    Date.now,
    storagePendingSends(storage),
  ).start('Weekly report');
  expect(api.created()).toBe(1);
  expect(started.conversationId).toBe('cnv_1');
  expect(new Set(api.posts.map((p) => p.id)).size).toBe(1);
  expect(storage.map.size).toBe(0);
});

test('storage that is blocked, full or holds junk keeps nothing and breaks nothing', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  const blocked = storagePendingSends(throwing);
  expect(() => blocked.write('k', { id: 'a', text: 't', at: 1 })).not.toThrow();
  expect(blocked.read('k')).toBeUndefined();
  expect(() => blocked.clear('k')).not.toThrow();
  const junk = memoryStorage();
  junk.setItem('maka.pending.k', '{"id":"has spaces","text":"t","at":1}');
  expect(storagePendingSends(junk).read('k')).toBeUndefined();
  expect(storagePendingSends(undefined).read('k')).toBeUndefined();
});

test('a kept first message from another invite in this tab is not reused', async () => {
  const storage = memoryStorage();
  // Another invite's unacknowledged start, same words, same tab.
  storagePendingSends(storage).write('start', {
    id: 'other-id',
    text: 'Weekly report',
    at: Date.now(),
    conversationId: 'cnv_not_mine',
  });
  const api = server();
  const started = await new ConversationStarter(
    new CloudClient('t', api.fetcher),
    Date.now,
    storagePendingSends(storage),
  ).start('Weekly report');
  expect(started.conversationId).toBe('cnv_1');
  expect(api.posts.map((p) => p.id)).not.toContain('other-id');
});

test('editing away from a failed send in this page makes the same words a new message, kept record included', async () => {
  const storage = memoryStorage();
  const api = server();
  const client = new CloudClient('t', api.fetcher);
  const feed = new ConversationFeed(client, 'cnv_a', 0, storagePendingSends(storage));
  api.loseNext();
  await feed.send('Again');
  feed.draftEdited(); // away
  feed.draftEdited(); // and back to the same words: a deliberate second message
  await feed.send('Again');
  expect(new Set(api.posts.map((p) => p.id)).size).toBe(2);
  // After a reload, typing (draftEdited with no send in memory) does not drop the kept record.
  api.loseNext();
  await feed.send('Once');
  const reloaded = new ConversationFeed(client, 'cnv_a', 0, storagePendingSends(storage));
  reloaded.draftEdited();
  await reloaded.send('Once');
  const once = api.posts.filter((p) => p.text === 'Once').map((p) => p.id);
  expect(new Set(once).size).toBe(1);
});

test('an edit while a first send is in flight makes the next send a new message', async () => {
  const storage = memoryStorage();
  const api = server();
  const client = new CloudClient('t', api.fetcher);
  const starter = new ConversationStarter(client, Date.now, storagePendingSends(storage));
  api.loseNext();
  const first = starter.start('Draft A');
  starter.draftEdited(); // edited to B while A is in flight
  await expect(first).rejects.toThrow();
  await starter.start('Draft B');
  const [a, b] = api.posts;
  expect(a?.id).not.toBe(b?.id);
});

test('a kept send past its hour, or junk, is deleted with its text when the store opens', () => {
  const storage = memoryStorage();
  const now = 10 * PENDING_SEND_MS;
  storage.setItem('maka.pending.old', JSON.stringify({ id: 'a', text: 'secret words', at: 0 }));
  storage.setItem('maka.pending.junk', 'not json');
  storage.setItem('maka.pending.fresh', JSON.stringify({ id: 'b', text: 'kept', at: now - 1 }));
  storage.setItem('other.key', 'untouched');
  const store = storagePendingSends(
    Object.assign(storage, {
      get length() {
        return storage.map.size;
      },
      key: (i: number) => [...storage.map.keys()][i] ?? null,
    }),
    'maka.pending.',
    () => now,
  );
  expect([...storage.map.keys()].sort()).toEqual(['maka.pending.fresh', 'other.key']);
  expect(store.read('fresh')?.text).toBe('kept');
});
