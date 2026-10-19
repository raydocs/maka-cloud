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

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS invites (
      invite_id TEXT PRIMARY KEY,
      token_sha256 BLOB NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
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
    return Number(result.changes) > 0;
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
