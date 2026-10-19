import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface InviteInfo {
  inviteId: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface CreatedInvite extends InviteInfo {
  /** Shown once; only its SHA-256 is stored. */
  token: string;
}

const PREFIX = 'mki_';

/**
 * Step `i` takes the invites file from version `i` to `i + 1`; steps are only
 * appended. v1 is the table as it was before the file had a version, so a file
 * created then (version 0, table present) passes through it unchanged.
 */
export const INVITE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS invites (
    invite_id TEXT PRIMARY KEY,
    token_sha256 BLOB NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
];

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function inviteIdOf(token: string): string | undefined {
  if (!token.startsWith(PREFIX)) return undefined;
  const dot = token.indexOf('.');
  return dot === -1 ? undefined : token.slice(PREFIX.length, dot);
}

/**
 * Invite tokens, in a file of their own. The main database belongs to one
 * running server; invites are created and revoked from the command line while
 * it runs, so they live apart and are read on every request (a revoke takes
 * effect at once).
 */
export class InviteStore {
  private readonly db: DatabaseSync;
  private readonly revokeListeners = new Set<(inviteId: string) => void>();
  private dataVersion: number;

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
    this.dataVersion = this.readDataVersion();
  }

  close(): void {
    this.db.close();
  }

  create(label: string): CreatedInvite {
    const inviteId = `inv_${randomBytes(6).toString('hex')}`;
    const token = `${PREFIX}${inviteId}.${randomBytes(32).toString('base64url')}`;
    const createdAt = this.now();
    this.db
      .prepare(
        'INSERT INTO invites (invite_id, token_sha256, label, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(inviteId, digest(token), label, createdAt);
    return { inviteId, label, createdAt, revokedAt: null, token };
  }

  revoke(inviteId: string): boolean {
    const result = this.db
      .prepare('UPDATE invites SET revoked_at = ? WHERE invite_id = ? AND revoked_at IS NULL')
      .run(this.now(), inviteId);
    const revoked = Number(result.changes) > 0;
    if (revoked) for (const listener of [...this.revokeListeners]) listener(inviteId);
    return revoked;
  }

  /** Whether the invite exists and is not revoked. Read from the file every time. */
  active(inviteId: string): boolean {
    const row = this.db
      .prepare('SELECT revoked_at FROM invites WHERE invite_id = ?')
      .get(inviteId) as { revoked_at: number | null } | undefined;
    return row !== undefined && row.revoked_at === null;
  }

  /** Called after a revoke through this store. Returns the unsubscribe function. */
  onRevoke(listener: (inviteId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  /**
   * Whether another connection (the command line, from its own process) wrote
   * the file since the last call. One cheap pragma, so it can be polled.
   */
  changedElsewhere(): boolean {
    const version = this.readDataVersion();
    const changed = version !== this.dataVersion;
    this.dataVersion = version;
    return changed;
  }

  private readDataVersion(): number {
    return (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  }

  list(): InviteInfo[] {
    const rows = this.db
      .prepare('SELECT invite_id, label, created_at, revoked_at FROM invites ORDER BY created_at')
      .all() as unknown as Array<{
      invite_id: string;
      label: string;
      created_at: number;
      revoked_at: number | null;
    }>;
    return rows.map((row) => ({
      inviteId: row.invite_id,
      label: row.label,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  /** The invite a token belongs to, or nothing for a missing, malformed, unknown or revoked one. */
  resolve(token: string): InviteInfo | undefined {
    const inviteId = inviteIdOf(token);
    if (inviteId === undefined) return undefined;
    const row = this.db
      .prepare(
        'SELECT invite_id, token_sha256, label, created_at, revoked_at FROM invites WHERE invite_id = ?',
      )
      .get(inviteId) as unknown as
      | {
          invite_id: string;
          token_sha256: Uint8Array;
          label: string;
          created_at: number;
          revoked_at: number | null;
        }
      | undefined;
    if (!row || row.revoked_at !== null) return undefined;
    if (!timingSafeEqual(Buffer.from(row.token_sha256), digest(token))) return undefined;
    return {
      inviteId: row.invite_id,
      label: row.label,
      createdAt: row.created_at,
      revokedAt: null,
    };
  }
}

function migrateInvites(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (version > INVITE_MIGRATIONS.length) {
      throw new Error(`Unsupported invites schema version ${version}`);
    }
    for (let step = version; step < INVITE_MIGRATIONS.length; step += 1) {
      db.exec(INVITE_MIGRATIONS[step] ?? '');
      db.exec(`PRAGMA user_version = ${step + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
