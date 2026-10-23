import type { Mode } from './contract';

/**
 * A message the person sent that the server has not acknowledged yet. It is kept from before the
 * post until the acknowledgment, so a reload, a crash or a killed app finds it and can offer to send
 * it again under the same id (the server dedupes on it, so it never runs twice).
 */
export interface OutboxEntry {
  /** The `clientMessageId` the post uses, on every try. */
  id: string;
  conversationId: string;
  text: string;
  /** When the person sent it, on this device's clock. */
  at: number;
  mode?: Mode;
  /** Why the last try failed, when it ended in a failure that sending again can help. */
  failure?: 'offline' | 'server';
}

/**
 * Where unacknowledged messages are kept, for one account on one server. `put` and `remove` touch
 * only their own message, so a late call of an earlier view, or another tab, can only clear the
 * message it names.
 */
export interface Outbox {
  list(conversationId: string): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(conversationId: string, id: string): Promise<void>;
}

/**
 * A store of strings by key: Web Storage, the phone's secure store, or a map. `keys` lists what it
 * holds; a store without it (the phone's secure store) keeps a small index per conversation instead,
 * which is only safe while one process writes it.
 */
export interface OutboxStorage {
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
  keys?(): string[] | Promise<string[]>;
}

/** After this long an unacknowledged message is dropped, text and all, instead of offered again. */
export const OUTBOX_KEEP_MS = 24 * 60 * 60_000;

/** At most this many messages are kept per conversation; the oldest go first. */
const MAX_PER_CONVERSATION = 20;

const ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Keys stay within what every store takes (the phone's secure store allows `[A-Za-z0-9._-]`). */
const part = (value: string) => value.replace(/[^A-Za-z0-9_-]/gu, '_');

/**
 * A short name for an account on a server, to keep its unsent messages apart from another
 * account's on the same device. It only separates; it is not a secret and does not reveal the token
 * (two independent 32-bit hashes, so it works where Web Crypto does not, as on React Native).
 */
export function outboxScope(server: string, token: string): string {
  const input = `${server}\n${token}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function isEntry(value: unknown, conversationId: string): value is OutboxEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    ID.test(v['id']) &&
    v['conversationId'] === conversationId &&
    typeof v['text'] === 'string' &&
    typeof v['at'] === 'number' &&
    (v['mode'] === undefined || typeof v['mode'] === 'string') &&
    (v['failure'] === undefined || v['failure'] === 'offline' || v['failure'] === 'server')
  );
}

/** One queue per store, shared by every outbox over it, so calls in one process never interleave. */
const queues = new WeakMap<object, Promise<unknown>>();
const memoryQueue = { current: Promise.resolve() as Promise<unknown> };

/**
 * An outbox over a store of strings, for one `scope` (see `outboxScope`): each message under a key
 * of its own, `<prefix><scope>.<conversation>.<id>`, so writers in other tabs never overwrite each
 * other's messages. Junk and entries past `OUTBOX_KEEP_MS` are dropped when read. A store that is
 * missing, full or blocked keeps nothing: the message is still sent, it just is not offered again
 * after a reload.
 */
export function storageOutbox(
  storage: OutboxStorage | undefined,
  scope: string,
  prefix = 'maka.outbox.',
  now: () => number = Date.now,
): Outbox {
  const base = (conversationId: string) => `${prefix}${part(scope)}.${part(conversationId)}`;
  const keyOf = (conversationId: string, id: string) => `${base(conversationId)}.${part(id)}`;
  const fresh = (entry: OutboxEntry) => now() - entry.at >= 0 && now() - entry.at < OUTBOX_KEEP_MS;
  const quietly = async <T>(work: () => T | Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch {
      return fallback;
    }
  };

  /** The ids kept for a conversation: from the store's own keys, or from the index. */
  const ids = async (conversationId: string): Promise<string[]> => {
    if (!storage) return [];
    const head = `${base(conversationId)}.`;
    if (storage.keys) {
      const keys = await quietly(() => storage.keys?.() ?? [], [] as string[]);
      return keys.filter((key) => key.startsWith(head)).map((key) => key.slice(head.length));
    }
    const raw = await quietly(() => storage.get(base(conversationId)), null);
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : [];
    } catch {
      parsed = [];
    }
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  };
  const writeIndex = async (conversationId: string, list: string[]) => {
    if (!storage || storage.keys) return;
    await quietly(
      () =>
        list.length === 0
          ? storage.remove(base(conversationId))
          : storage.set(base(conversationId), JSON.stringify(list)),
      undefined,
    );
  };
  const read = async (conversationId: string): Promise<OutboxEntry[]> => {
    const entries: OutboxEntry[] = [];
    const gone: string[] = [];
    const listed = await ids(conversationId);
    for (const id of listed) {
      const raw = await quietly(() => storage?.get(keyOf(conversationId, id)), null);
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }
      const other = (parsed as { conversationId?: unknown } | undefined)?.conversationId;
      // Another conversation whose id reads the same once made safe for a key: not this one's.
      if (typeof other === 'string' && other !== conversationId) continue;
      if (isEntry(parsed, conversationId) && parsed.id === id && fresh(parsed))
        entries.push(parsed);
      else gone.push(id);
    }
    // Junk and expired records are deleted, text and all, not just ignored.
    for (const id of gone)
      await quietly(() => storage?.remove(keyOf(conversationId, id)), undefined);
    if (gone.length > 0)
      await writeIndex(
        conversationId,
        listed.filter((id) => !gone.includes(id)),
      );
    return entries.sort((a, b) => a.at - b.at);
  };

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const previous = storage ? (queues.get(storage) ?? Promise.resolve()) : memoryQueue.current;
    const run = previous.then(work, work);
    const settled = run.catch(() => {});
    if (storage) queues.set(storage, settled);
    else memoryQueue.current = settled;
    return run;
  };

  return {
    list: (conversationId) => serial(() => read(conversationId)),
    put: (entry) =>
      serial(async () => {
        if (!storage || !ID.test(entry.id)) return;
        const set = await quietly(async () => {
          await storage.set(keyOf(entry.conversationId, entry.id), JSON.stringify(entry));
          return true;
        }, false);
        if (!set) return;
        // The oldest beyond the cap go.
        const others = (await read(entry.conversationId)).filter((e) => e.id !== entry.id);
        const dropped = new Set(
          others.slice(0, Math.max(0, others.length - (MAX_PER_CONVERSATION - 1))).map((e) => e.id),
        );
        for (const id of dropped)
          await quietly(() => storage.remove(keyOf(entry.conversationId, id)), undefined);
        if (!storage.keys) {
          const listed = (await ids(entry.conversationId)).filter(
            (id) => id !== entry.id && !dropped.has(id),
          );
          await writeIndex(entry.conversationId, [...listed, entry.id]);
        }
      }),
    remove: (conversationId, id) =>
      serial(async () => {
        if (!storage) return;
        await quietly(() => storage.remove(keyOf(conversationId, id)), undefined);
        if (!storage.keys)
          await writeIndex(
            conversationId,
            (await ids(conversationId)).filter((kept) => kept !== id),
          );
      }),
  };
}

/** An outbox in memory only: kept while the app runs, gone on a reload. */
export function memoryOutbox(now: () => number = Date.now): Outbox {
  const map = new Map<string, string>();
  return storageOutbox(
    {
      get: (key) => map.get(key),
      set: (key, value) => {
        map.set(key, value);
      },
      remove: (key) => {
        map.delete(key);
      },
      keys: () => [...map.keys()],
    },
    'memory',
    'maka.outbox.',
    now,
  );
}

/**
 * Web Storage as an outbox store (the web app uses `localStorage`, so a closed tab keeps it). Every
 * tab of the browser sees the same messages; each one's own key keeps them from overwriting another.
 */
export function webStorageOutbox(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> | undefined,
  scope: string,
  now: () => number = Date.now,
): Outbox {
  return storageOutbox(
    storage && {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
      keys: () => {
        const keys: string[] = [];
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i);
          if (key !== null) keys.push(key);
        }
        return keys;
      },
    },
    scope,
    'maka.outbox.',
    now,
  );
}
