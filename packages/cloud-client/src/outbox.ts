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
  /**
   * The person's last message the conversation showed when this one was sent, if any. Only a
   * message after it can be this one, when the server does not name the id a message was sent under.
   */
  after?: string;
  /** Why the last try failed, when it ended in a failure that sending again can help. */
  failure?: 'offline' | 'server';
}

/**
 * Where unacknowledged messages are kept. Calls run one at a time, in the order they were made, so
 * a late call of an earlier view cannot undo a newer one; `remove` takes an id, never a whole
 * conversation, so a request that ends late can only clear its own message.
 */
export interface Outbox {
  list(conversationId: string): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(conversationId: string, id: string): Promise<void>;
}

/** A store of strings by key: Web Storage, the phone's secure store, or a map. */
export interface OutboxStorage {
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

/** After this long an unacknowledged message is dropped, text and all, instead of offered again. */
export const OUTBOX_KEEP_MS = 24 * 60 * 60_000;

/** At most this many messages are kept per conversation; the oldest go first. */
const MAX_PER_CONVERSATION = 20;

const ID = /^[A-Za-z0-9_-]{1,128}$/u;

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
    (v['after'] === undefined || typeof v['after'] === 'string') &&
    (v['failure'] === undefined || v['failure'] === 'offline' || v['failure'] === 'server')
  );
}

/**
 * An outbox over a store of strings: one record per conversation, a list of its entries. Junk and
 * entries past `OUTBOX_KEEP_MS` are dropped when read. A store that is missing, full or blocked
 * keeps nothing: the message is still sent, it just is not offered again after a reload.
 */
export function storageOutbox(
  storage: OutboxStorage | undefined,
  prefix = 'maka.outbox.',
  now: () => number = Date.now,
): Outbox {
  // Keys stay within what every store takes (the phone's secure store allows `[A-Za-z0-9._-]`).
  const keyOf = (conversationId: string) =>
    prefix + conversationId.replace(/[^A-Za-z0-9._-]/gu, '_');
  const fresh = (entry: OutboxEntry) => now() - entry.at >= 0 && now() - entry.at < OUTBOX_KEEP_MS;

  const read = async (conversationId: string): Promise<OutboxEntry[]> => {
    let raw: string | null | undefined;
    try {
      raw = await storage?.get(keyOf(conversationId));
    } catch {
      return [];
    }
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is OutboxEntry => isEntry(entry, conversationId) && fresh(entry),
        )
      : [];
  };
  const write = async (conversationId: string, entries: OutboxEntry[]) => {
    try {
      if (entries.length === 0) await storage?.remove(keyOf(conversationId));
      else await storage?.set(keyOf(conversationId), JSON.stringify(entries));
    } catch {
      // Not kept: the message is still sent, but a reload would not offer it again.
    }
  };

  // One call at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  return {
    list: (conversationId) =>
      serial(async () => {
        const entries = await read(conversationId);
        return entries.sort((a, b) => a.at - b.at);
      }),
    put: (entry) =>
      serial(async () => {
        const entries = (await read(entry.conversationId)).filter((e) => e.id !== entry.id);
        entries.push(entry);
        await write(entry.conversationId, entries.slice(-MAX_PER_CONVERSATION));
      }),
    remove: (conversationId, id) =>
      serial(async () => {
        const entries = await read(conversationId);
        const kept = entries.filter((e) => e.id !== id);
        // Rewritten when something went, or when reading dropped expired or junk records.
        await write(conversationId, kept);
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
    },
    'maka.outbox.',
    now,
  );
}

/** Web Storage as an outbox store (the web app uses `localStorage`, so a closed tab keeps it). */
export function webStorageOutbox(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined,
  now: () => number = Date.now,
): Outbox {
  return storageOutbox(
    storage && {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
    },
    'maka.outbox.',
    now,
  );
}
