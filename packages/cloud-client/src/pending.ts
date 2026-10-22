/**
 * A message posted but not yet acknowledged, kept so that sending the same text again after a
 * reload reuses its id: the server dedupes on it, so a lost acknowledgment never runs a message
 * twice. Kept only until the acknowledgment, and only for an hour.
 */
export interface PendingSend {
  /** The `clientMessageId` the post used. */
  id: string;
  text: string;
  at: number;
  /** For a first message: the conversation it created, reused with the id. */
  conversationId?: string;
}

export interface PendingSends {
  read(key: string): PendingSend | undefined;
  write(key: string, value: PendingSend): void;
  clear(key: string): void;
}

/** After this long an unacknowledged send is forgotten: sending the same text is a new message. */
export const PENDING_SEND_MS = 60 * 60_000;

/** The kept send, when it is for this exact text and recent enough to reuse. */
export function reusable(
  kept: PendingSend | undefined,
  text: string,
  now: number,
): PendingSend | undefined {
  return kept && kept.text === text && now - kept.at >= 0 && now - kept.at < PENDING_SEND_MS
    ? kept
    : undefined;
}

const isPending = (value: unknown): value is PendingSend => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(v['id']) &&
    typeof v['text'] === 'string' &&
    typeof v['at'] === 'number' &&
    (v['conversationId'] === undefined || typeof v['conversationId'] === 'string')
  );
};

/**
 * Pending sends in a Web Storage (the web app uses `sessionStorage`: one tab, gone when it
 * closes). Storage can be missing, full or blocked; then nothing is kept and a reload sends anew.
 */
export function storagePendingSends(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined,
  prefix = 'maka.pending.',
): PendingSends {
  return {
    read(key) {
      try {
        const raw = storage?.getItem(prefix + key);
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return isPending(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    write(key, value) {
      try {
        storage?.setItem(prefix + key, JSON.stringify(value));
      } catch {
        // Not kept: a reload after a lost acknowledgment would send again.
      }
    },
    clear(key) {
      try {
        storage?.removeItem(prefix + key);
      } catch {
        // Nothing to do.
      }
    },
  };
}
