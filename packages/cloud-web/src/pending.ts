import {
  adoptPendingSend,
  type CloudClient,
  storagePendingSends,
  webStorageOutbox,
} from '@maka-cloud/client';

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
 * Kept per account on its server (`CloudClient.outboxScope`): another account signed in to this
 * browser never sees them, and signing in again to the same account finds them. Signing out keeps
 * them under that account; they go when sent or deleted, or after 30 days unsent, once shown.
 * A send this tab kept the earlier way (`pendingSends`) is taken over first, under its own id.
 */
export function outboxFor(client: CloudClient, conversationId: string) {
  const outbox = webStorageOutbox(localStore(), client.outboxScope());
  void adoptPendingSend(pendingSends, outbox, conversationId);
  return outbox;
}
