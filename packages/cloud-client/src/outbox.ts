import type { Mode, QuotaReason } from './contract';
import type { PendingSend } from './pending';
import { quotaReason } from './quota';

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
  /** When it was last tried (or kept), on this device's clock: how long it is kept counts from here. */
  keptAt?: number;
  mode?: Mode;
  /** Why the last try failed, when it ended in a failure that sending again can help. */
  failure?: 'offline' | 'server' | 'quota';
  /** With `failure: 'quota'`: the limit it ran into, so a later visit explains it the same way. */
  quota?: QuotaReason;
}

/**
 * Where unacknowledged messages are kept, for one account on one server. `put` and `remove` touch
 * only their own message, so a late call of an earlier view, or another tab, can only clear the
 * message it names. Nothing is dropped for its age here: the conversation decides (`OUTBOX_KEEP_MS`).
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

/**
 * Whose outbox it is. `account` is the account's scope on its server, the same across its sessions
 * (`CloudClient.outboxScope`); it is undefined when the server cannot say (an older server, or no
 * answer yet). `token` is this token's own scope, used until the account's is known; what was kept
 * under it moves to the account's scope once that is known.
 */
export interface OutboxScope {
  account(): Promise<string | undefined>;
  token: string;
}

/**
 * How long an unsent message is kept on the device after its last try. Past that it is shown one
 * last time, as not sent and no longer kept, and then deleted: never dropped without being shown.
 */
export const OUTBOX_KEEP_MS = 30 * 24 * 60 * 60_000;

/** How long working out the account's scope may hold the outbox up before the token's is used. */
const ACCOUNT_WAIT_MS = 3000;

const ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Keys stay within what every store takes (the phone's secure store allows `[A-Za-z0-9._-]`). */
const part = (value: string) => value.replace(/[^A-Za-z0-9_-]/gu, '_');

/**
 * A short name for one account (or one token) on a server, to keep its unsent messages apart from
 * another's on the same device. It only separates; it is not a secret and does not reveal what it
 * was made from (two independent 32-bit hashes, so it works where Web Crypto does not, as on React
 * Native). Never pass a raw token where a key would show it: this is what keys carry instead.
 */
export function outboxScope(server: string, who: string): string {
  const input = `${server}\n${who}`;
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
    (v['keptAt'] === undefined || typeof v['keptAt'] === 'number') &&
    (v['mode'] === undefined || typeof v['mode'] === 'string') &&
    (v['failure'] === undefined ||
      v['failure'] === 'offline' ||
      v['failure'] === 'server' ||
      (v['failure'] === 'quota' && quotaReason(v['quota']) !== undefined))
  );
}

/** One queue per store, shared by every outbox over it, so calls in one process never interleave. */
const queues = new WeakMap<object, Promise<unknown>>();
const memoryQueue = { current: Promise.resolve() as Promise<unknown> };

const quietly = async <T>(work: () => T | Promise<T>, fallback: T): Promise<T> => {
  try {
    return await work();
  } catch {
    return fallback;
  }
};

/**
 * An outbox over a store of strings: each message under a key of its own,
 * `<prefix><scope>.<conversation>.<id>`, so writers in other tabs never overwrite each other's
 * messages. Junk records are dropped when read. A store that is missing, full or blocked keeps
 * nothing: the message is still sent, it just is not offered again after a reload.
 */
export function storageOutbox(
  storage: OutboxStorage | undefined,
  scope: string | OutboxScope,
  prefix = 'maka.outbox.',
): Outbox {
  const whose: OutboxScope =
    typeof scope === 'string' ? { account: async () => scope, token: scope } : scope;
  const base = (s: string, conversationId: string) => `${prefix}${part(s)}.${part(conversationId)}`;
  const keyOf = (s: string, conversationId: string, id: string) =>
    `${base(s, conversationId)}.${part(id)}`;

  // The token's scope is linked to the account's once known, so an offline start still finds it.
  const linkKey = `${prefix}account.${part(whose.token)}`;
  let resolved: string | undefined;
  const current = async (): Promise<string> => {
    if (resolved !== undefined) return resolved;
    const linked = await quietly(() => storage?.get(linkKey), null);
    if (linked && ID.test(linked)) {
      resolved = linked;
      return linked;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const account = await Promise.race([
      quietly(() => whose.account(), undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ACCOUNT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (account === undefined || !ID.test(account)) return whose.token;
    resolved = account;
    if (account !== whose.token) await quietly(() => storage?.set(linkKey, account), undefined);
    return account;
  };

  /** The ids kept for a conversation: from the store's own keys, or from the index. */
  const ids = async (s: string, conversationId: string): Promise<string[]> => {
    if (!storage) return [];
    const head = `${base(s, conversationId)}.`;
    if (storage.keys) {
      const keys = await quietly(() => storage.keys?.() ?? [], [] as string[]);
      return keys.filter((key) => key.startsWith(head)).map((key) => key.slice(head.length));
    }
    const raw = await quietly(() => storage.get(base(s, conversationId)), null);
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : [];
    } catch {
      parsed = [];
    }
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  };
  const writeIndex = async (s: string, conversationId: string, list: string[]) => {
    if (!storage || storage.keys) return;
    await quietly(
      () =>
        list.length === 0
          ? storage.remove(base(s, conversationId))
          : storage.set(base(s, conversationId), JSON.stringify(list)),
      undefined,
    );
  };
  const read = async (s: string, conversationId: string): Promise<OutboxEntry[]> => {
    const entries: OutboxEntry[] = [];
    const gone: string[] = [];
    const listed = await ids(s, conversationId);
    for (const id of listed) {
      const raw = await quietly(() => storage?.get(keyOf(s, conversationId, id)), null);
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }
      const other = (parsed as { conversationId?: unknown } | undefined)?.conversationId;
      // Another conversation whose id reads the same once made safe for a key: not this one's.
      if (typeof other === 'string' && other !== conversationId) continue;
      if (isEntry(parsed, conversationId) && parsed.id === id) entries.push(parsed);
      else gone.push(id);
    }
    // Junk records are deleted, not just ignored.
    for (const id of gone)
      await quietly(() => storage?.remove(keyOf(s, conversationId, id)), undefined);
    if (gone.length > 0)
      await writeIndex(
        s,
        conversationId,
        listed.filter((id) => !gone.includes(id)),
      );
    return entries.sort((a, b) => a.at - b.at);
  };
  const write = async (s: string, entry: OutboxEntry): Promise<boolean> => {
    if (!storage || !ID.test(entry.id)) return false;
    const set = await quietly(async () => {
      await storage.set(keyOf(s, entry.conversationId, entry.id), JSON.stringify(entry));
      return true;
    }, false);
    if (!set) return false;
    // No count limit: every unsent message is kept until it is sent, deleted, or shown as expired.
    if (!storage.keys) {
      const listed = (await ids(s, entry.conversationId)).filter((id) => id !== entry.id);
      await writeIndex(s, entry.conversationId, [...listed, entry.id]);
    }
    return true;
  };
  const erase = async (s: string, conversationId: string, id: string) => {
    if (!storage) return;
    await quietly(() => storage.remove(keyOf(s, conversationId, id)), undefined);
    if (!storage.keys)
      await writeIndex(
        s,
        conversationId,
        (await ids(s, conversationId)).filter((kept) => kept !== id),
      );
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
    list: (conversationId) =>
      serial(async () => {
        const s = await current();
        // What was kept under the token before the account was known moves to the account.
        if (s !== whose.token)
          for (const entry of await read(whose.token, conversationId))
            if (await write(s, entry)) await erase(whose.token, conversationId, entry.id);
        return read(s, conversationId);
      }),
    put: (entry) =>
      serial(async () => {
        await write(await current(), entry);
      }),
    remove: (conversationId, id) =>
      serial(async () => {
        const s = await current();
        await erase(s, conversationId, id);
        if (s !== whose.token) await erase(whose.token, conversationId, id);
      }),
  };
}

/** An outbox in memory only: kept while the app runs, gone on a reload. */
export function memoryOutbox(): Outbox {
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
  );
}

/**
 * Web Storage as an outbox store (the web app uses `localStorage`, so a closed tab keeps it). Every
 * tab of the browser sees the same messages; each one's own key keeps them from overwriting another.
 */
export function webStorageOutbox(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> | undefined,
  scope: string | OutboxScope,
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
  );
}

/**
 * Moves an unacknowledged send of the conversation kept the earlier way (`PendingSends`: the web's
 * `sessionStorage` record `maka.pending.<conversationId>`) into the outbox, under the id it was
 * posted with, so sending it again stays the same message to the server. Call it before the
 * conversation's feed opens: the outbox runs its calls in order, so the feed then finds it. The old
 * record is cleared only once the outbox holds it. A first message's record (the starter's, with a
 * conversation id of its own) is left to the starter.
 *
 * The record is read as stored, whatever its age: the earlier way forgot a send after an hour, but
 * its words were never shown as dropped, so an old one is taken over too and the conversation shows
 * it (as expired if it is past `OUTBOX_KEEP_MS`). The earlier store must not sweep these records
 * first (`storagePendingSends` with `owns`).
 */
export async function adoptPendingSend(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined,
  outbox: Outbox,
  conversationId: string,
  prefix = 'maka.pending.',
): Promise<void> {
  const key = prefix + conversationId;
  let kept: unknown;
  try {
    const raw = storage?.getItem(key);
    kept = raw ? JSON.parse(raw) : undefined;
  } catch {
    kept = undefined;
  }
  if (!isLegacySend(kept)) return;
  const { id, text, at } = kept;
  await outbox.put({ id, conversationId, text, at, keptAt: at });
  if ((await outbox.list(conversationId)).some((entry) => entry.id === id)) {
    try {
      storage?.removeItem(key);
    } catch {
      // Left in place: taking it over again is the same message, under the same id.
    }
  }
}

/** A conversation's send as the earlier way kept it (`PendingSend`, without a conversation id). */
function isLegacySend(value: unknown): value is Omit<PendingSend, 'conversationId'> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    ID.test(v['id']) &&
    typeof v['text'] === 'string' &&
    v['text'].trim() !== '' &&
    typeof v['at'] === 'number' &&
    v['conversationId'] === undefined
  );
}
