/**
 * Where a conversation's live link stands. This is the connection only, never a task: a task that
 * failed says so in its own row, and a dropped link is not a failed task.
 *
 * - `connecting`: the first request is on its way.
 * - `live`: the server is sending (bytes arrived, not just a request started).
 * - `reconnecting`: the link dropped or went silent; it is tried again at `retryAt`.
 * - `offline`: the server could not be reached at all; it is tried again at `retryAt`.
 * - `signed_out`: this device's sign-in is no longer valid. Nothing is retried.
 * - `invite_expired`: the invite this browser used is no longer valid. Nothing is retried.
 * - `unavailable`: the conversation is gone or not this person's. Nothing is retried.
 * - `protocol_error`: the server answered with something this client cannot read; it is tried
 *   again at `retryAt` when there is one.
 */
export type ConnectionState =
  | { state: 'connecting' }
  | { state: 'live' }
  | { state: 'reconnecting'; retryAt: number }
  | { state: 'offline'; retryAt: number }
  | { state: 'signed_out' }
  | { state: 'invite_expired' }
  | { state: 'unavailable' }
  | { state: 'protocol_error'; retryAt?: number };

/** What a connection banner offers: try now, sign in again, or nothing. */
export type ConnectionAction = 'retry' | 'sign_in' | null;

/** The connection in words. Web and phone translate these sentences as they are. */
export function connectionText(connection: ConnectionState): string {
  switch (connection.state) {
    case 'connecting':
      return 'Connecting…';
    case 'live':
      return 'Live';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'offline':
      return 'Offline. Check your connection.';
    case 'signed_out':
      return 'You are signed out. Sign in again to continue.';
    case 'invite_expired':
      return 'Invite expired. Reconnect with a valid invite.';
    case 'unavailable':
      return 'This conversation is not available.';
    case 'protocol_error':
      return 'The server sent something this app cannot read.';
  }
}

export function connectionAction(connection: ConnectionState): ConnectionAction {
  switch (connection.state) {
    case 'reconnecting':
    case 'offline':
    case 'protocol_error':
      return 'retry';
    case 'signed_out':
    case 'invite_expired':
      return 'sign_in';
    default:
      return null;
  }
}

/** Whether a banner is worth showing: connected, or still connecting the first time, is not. */
export function connectionNeedsBanner(connection: ConnectionState): boolean {
  return connection.state !== 'live' && connection.state !== 'connecting';
}
