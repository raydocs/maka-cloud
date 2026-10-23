import { storagePendingSends, webStorageOutbox } from '@maka-cloud/client';

function sessionStore() {
  try {
    return globalThis.sessionStorage;
  } catch {
    // Blocked storage: sends are kept in memory only.
    return undefined;
  }
}

/** This tab's unacknowledged sends, so a reload after a lost acknowledgment does not send twice. */
export const pendingSends = storagePendingSends(sessionStore());

function localStore() {
  try {
    return globalThis.localStorage;
  } catch {
    // Blocked storage: unconfirmed messages are kept in memory only.
    return undefined;
  }
}

/**
 * The conversation's messages the server has not confirmed, in `localStorage`, so a reload or a
 * closed tab offers them again ("Send again") instead of losing them. Nothing is resent on its own.
 */
export const outbox = webStorageOutbox(localStore());
