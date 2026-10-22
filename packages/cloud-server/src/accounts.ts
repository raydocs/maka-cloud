import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrateInvites } from './invites.js';

const PREFIX = 'mks_';
/** A device that has not been seen for this long must sign in again. */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most this often per session, so a busy stream is not a write load. */
const SEEN_EVERY_MS = 60_000;

export interface Session {
  sessionId: string;
  accountId: string;
  deviceLabel: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface IssuedSession extends Session {
  /** Shown once; only its SHA-256 is stored. */
  token: string;
}

/** What a session token stands for: the invite it acts as, and the device it was issued to. */
export interface SessionOwner {
  inviteId: string;
  sessionId: string;
}

/** Who someone is at a provider. `email` is shown to them and never used to find an account. */
export interface Identity {
  provider: 'apple' | 'google' | 'email';
  subject: string;
  email?: string;
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function sessionIdOf(token: string): string | undefined {
  if (!token.startsWith(PREFIX)) return undefined;
  const dot = token.indexOf('.');
  return dot === -1 ? undefined : token.slice(PREFIX.length, dot);
}

/**
 * Accounts and the sessions of their devices, in the invites file. An account is bound to exactly
 * one invite, and a session acts as that invite: every route that is scoped to an invite stays
 * scoped the same way. A session is good only while its account's invite is active, so revoking
 * the invite signs every device out at once, and while it is neither revoked nor idle for too long.
 * Like invites, everything is read from the file on every call.
 */
export class AccountStore {
  private readonly db: DatabaseSync;
  private readonly revokeListeners = new Set<(sessionId: string) => void>();

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    try {
      migrateInvites(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * The account of an active invite, made now. One invite has one account: a second call for the
   * same invite returns nothing instead of a second way in.
   */
  createAccount(inviteId: string): string | undefined {
    const accountId = `acc_${randomBytes(6).toString('hex')}`;
    const result = this.db
      .prepare(
        `INSERT INTO accounts (account_id, invite_id, created_at)
         SELECT ?, invite_id, ? FROM invites WHERE invite_id = ? AND revoked_at IS NULL
         ON CONFLICT (invite_id) DO NOTHING`,
      )
      .run(accountId, this.now(), inviteId);
    return Number(result.changes) > 0 ? accountId : undefined;
  }

  /**
   * The account of an active invite, made now together with its first identity, or nothing when the
   * invite is gone or already has an account or the identity already belongs to one. All or nothing.
   */
  createAccountWithIdentity(inviteId: string, identity: Identity): string | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const accountId = this.createAccount(inviteId);
      if (accountId === undefined || !this.insertIdentity(accountId, identity)) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      this.db.exec('COMMIT');
      return accountId;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The account an identity signs in to, whether or not its invite is still active. */
  accountOfIdentity(identity: Pick<Identity, 'provider' | 'subject'>): string | undefined {
    const row = this.db
      .prepare('SELECT account_id FROM identities WHERE provider = ? AND subject = ?')
      .get(identity.provider, identity.subject) as { account_id: string } | undefined;
    return row?.account_id;
  }

  /**
   * Adds a way to sign in to an account: `linked`, `already_here` when the account has it, or
   * `taken` when another account does. The caller proves the identity first.
   */
  linkIdentity(accountId: string, identity: Identity): 'linked' | 'already_here' | 'taken' {
    if (this.insertIdentity(accountId, identity)) return 'linked';
    return this.accountOfIdentity(identity) === accountId ? 'already_here' : 'taken';
  }

  /** The ways to sign in to an account, for its owner to see. */
  identities(accountId: string): Array<{ provider: Identity['provider']; email?: string }> {
    const rows = this.db
      .prepare('SELECT provider, email FROM identities WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as unknown as Array<{ provider: Identity['provider']; email: string | null }>;
    return rows.map((row) => ({
      provider: row.provider,
      ...(row.email === null ? {} : { email: row.email }),
    }));
  }

  private insertIdentity(accountId: string, identity: Identity): boolean {
    // An identity left on an account whose invite was revoked belongs to nobody: it is released, so
    // its person can come back on a new invite. An identity of a live account is never touched.
    this.db
      .prepare(
        `DELETE FROM identities WHERE provider = ? AND subject = ? AND account_id IN (
           SELECT a.account_id FROM accounts a JOIN invites i ON i.invite_id = a.invite_id
           WHERE i.revoked_at IS NOT NULL)`,
      )
      .run(identity.provider, identity.subject);
    const result = this.db
      .prepare(
        `INSERT INTO identities (provider, subject, account_id, email, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, subject) DO NOTHING`,
      )
      .run(identity.provider, identity.subject, accountId, identity.email ?? null, this.now());
    return Number(result.changes) > 0;
  }

  /** The account that belongs to an invite, active or not. */
  accountOf(inviteId: string): string | undefined {
    const row = this.db
      .prepare('SELECT account_id FROM accounts WHERE invite_id = ?')
      .get(inviteId) as { account_id: string } | undefined;
    return row?.account_id;
  }

  /** A new session for a device. Nothing for an account whose invite is no longer active. */
  issueSession(accountId: string, deviceLabel: string): IssuedSession | undefined {
    const live = this.db
      .prepare(
        `SELECT 1 FROM accounts a JOIN invites i ON i.invite_id = a.invite_id
         WHERE a.account_id = ? AND i.revoked_at IS NULL`,
      )
      .get(accountId);
    if (!live) return undefined;
    const sessionId = `ses_${randomBytes(6).toString('hex')}`;
    const token = `${PREFIX}${sessionId}.${randomBytes(32).toString('base64url')}`;
    const label = deviceLabel.replace(/\p{C}/gu, '').trim().slice(0, 80) || 'Unnamed device';
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, account_id, token_sha256, device_label, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, accountId, digest(token), label, at, at);
    return { sessionId, accountId, deviceLabel: label, createdAt: at, lastSeenAt: at, token };
  }

  /**
   * The invite a session token acts as, or nothing for a token that is malformed, unknown, revoked,
   * idle for too long, or whose account's invite was revoked.
   */
  resolve(token: string): SessionOwner | undefined {
    const sessionId = sessionIdOf(token);
    if (sessionId === undefined) return undefined;
    const row = this.db
      .prepare(
        `SELECT s.token_sha256, s.last_seen_at, a.invite_id
         FROM sessions s
         JOIN accounts a ON a.account_id = s.account_id
         JOIN invites i ON i.invite_id = a.invite_id
         WHERE s.session_id = ? AND s.revoked_at IS NULL AND i.revoked_at IS NULL`,
      )
      .get(sessionId) as
      | { token_sha256: Uint8Array; last_seen_at: number; invite_id: string }
      | undefined;
    if (!row) return undefined;
    if (!timingSafeEqual(Buffer.from(row.token_sha256), digest(token))) return undefined;
    const now = this.now();
    if (now - row.last_seen_at > SESSION_IDLE_MS) return undefined;
    if (now - row.last_seen_at > SEEN_EVERY_MS) {
      this.db
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ? AND revoked_at IS NULL')
        .run(now, sessionId);
    }
    return { inviteId: row.invite_id, sessionId };
  }

  /** Whether the session is still good: not revoked, not idle for too long, and its invite active. */
  active(sessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT s.last_seen_at FROM sessions s
         JOIN accounts a ON a.account_id = s.account_id
         JOIN invites i ON i.invite_id = a.invite_id
         WHERE s.session_id = ? AND s.revoked_at IS NULL AND i.revoked_at IS NULL`,
      )
      .get(sessionId) as { last_seen_at: number } | undefined;
    return row !== undefined && this.now() - row.last_seen_at <= SESSION_IDLE_MS;
  }

  /** The devices signed in to an account, newest first, with nothing that could be used as a token. */
  sessions(accountId: string): Session[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, account_id, device_label, created_at, last_seen_at
         FROM sessions WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all(accountId) as unknown as Array<{
      session_id: string;
      account_id: string;
      device_label: string;
      created_at: number;
      last_seen_at: number;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      accountId: row.account_id,
      deviceLabel: row.device_label,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  /**
   * Signs one device out. Only a session of `accountId` can be revoked this way, so one account
   * cannot touch another's devices; false for anything else, and for one already revoked.
   */
  revokeSession(accountId: string, sessionId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND account_id = ? AND revoked_at IS NULL',
      )
      .run(this.now(), sessionId, accountId);
    const revoked = Number(result.changes) > 0;
    if (revoked) for (const listener of [...this.revokeListeners]) listener(sessionId);
    return revoked;
  }

  /** Called after a session is revoked through this store. Returns the unsubscribe function. */
  onRevoke(listener: (sessionId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }
}
