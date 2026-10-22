import { storagePendingSends } from '@maka-cloud/client';

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
