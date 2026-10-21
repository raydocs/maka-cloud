import { DatabaseSync } from 'node:sqlite';
import { open, parsePlanKey, seal } from './seal.js';

export type PlanVendor = 'claude' | 'chatgpt';

/**
 * What the user is shown for a connection. It never holds the credential, nor any text that came
 * from outside.
 *
 * - `linked`: usable now.
 * - `expired`: the credential's own life ended; link again.
 * - `broken`: the vendor refused it (a 401) or the stored copy cannot be read; link again.
 */
export interface PlanStatus {
  vendor: PlanVendor;
  state: 'unlinked' | 'linked' | 'expired' | 'broken';
  linkedAt?: number;
  expiresAt?: number;
  /** True in the last 30 days before `expiresAt`. */
  expiresSoon?: boolean;
  brokenAt?: number;
}

/** A refusal with a fixed message: it never repeats what the user pasted. */
export class PlanLinkError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;
/** `claude setup-token` makes a token that lives one year and has no refresh. */
export const CLAUDE_TOKEN_LIFE_MS = 365 * DAY_MS;
export const EXPIRY_WARNING_MS = 30 * DAY_MS;

const SETUP_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/u;
const API_KEY = /^sk-ant-api/u;

export interface PlanVaultOptions {
  /** The SQLite file. `:memory:` is allowed for tests. */
  path: string;
  /** 32 bytes as base64 or hex, see `parsePlanKey`. */
  key: string;
  now?: () => number;
}

interface Row {
  invite_id: string;
  vendor: string;
  sealed: Uint8Array | null;
  linked_at: number;
  expires_at: number | null;
  broken_at: number | null;
}

/**
 * The plan credentials of the invites, sealed at rest. The only way to read one is `claudeProcessEnv`,
 * which gives the environment of the `claude` process and nothing else: there is no call that lists,
 * exports or logs a credential, and a status holds none.
 */
export class PlanVault {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly now: () => number;

  private constructor(options: PlanVaultOptions) {
    this.key = parsePlanKey(options.key);
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.path);
    // Deleted and replaced credentials are overwritten in the file, not left in free pages.
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS plan_connections (
      invite_id TEXT NOT NULL,
      vendor TEXT NOT NULL,
      sealed BLOB,
      linked_at INTEGER NOT NULL,
      expires_at INTEGER,
      broken_at INTEGER,
      PRIMARY KEY (invite_id, vendor)
    )`);
  }

  static open(options: PlanVaultOptions): PlanVault {
    return new PlanVault(options);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Stores the one-year token the user made with `claude setup-token`, replacing an earlier link.
   * An API key is refused here: a box never holds a plan credential and an API key for one vendor.
   */
  linkClaudeToken(inviteId: string, pasted: string): PlanStatus {
    const token = pasted.trim();
    if (API_KEY.test(token)) {
      throw new PlanLinkError(
        'that is an API key; paste the token that `claude setup-token` prints',
      );
    }
    if (!SETUP_TOKEN.test(token)) {
      throw new PlanLinkError(
        'that is not a Claude setup token; run `claude setup-token` and paste its output',
      );
    }
    const linkedAt = this.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO plan_connections (invite_id, vendor, sealed, linked_at, expires_at, broken_at)
         VALUES (?, 'claude', ?, ?, ?, NULL)`,
      )
      .run(
        inviteId,
        seal(this.key, aad(inviteId, 'claude'), token),
        linkedAt,
        linkedAt + CLAUDE_TOKEN_LIFE_MS,
      );
    return this.status(inviteId, 'claude');
  }

  status(inviteId: string, vendor: PlanVendor): PlanStatus {
    const row = this.row(inviteId, vendor);
    if (row === undefined) return { vendor, state: 'unlinked' };
    const now = this.now();
    const base = {
      vendor,
      linkedAt: row.linked_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    };
    if (row.broken_at !== null || row.sealed === null) {
      return { ...base, state: 'broken', brokenAt: row.broken_at ?? row.linked_at };
    }
    if (row.expires_at !== null && now >= row.expires_at) return { ...base, state: 'expired' };
    // A copy that cannot be opened (another key, damage) is not usable and not worth hiding.
    if (open(this.key, aad(inviteId, vendor), row.sealed) === undefined) {
      return { ...base, state: 'broken', brokenAt: now };
    }
    return {
      ...base,
      state: 'linked',
      expiresSoon: row.expires_at !== null && row.expires_at - now <= EXPIRY_WARNING_MS,
    };
  }

  /**
   * The environment for the `claude` process on this invite's boxes: `CLAUDE_CODE_OAUTH_TOKEN` and
   * nothing else, or `undefined` when the invite has no usable Claude link. The caller puts it in
   * that process's environment only, never in a profile, a file, an event or a log.
   */
  claudeProcessEnv(inviteId: string): { CLAUDE_CODE_OAUTH_TOKEN: string } | undefined {
    const row = this.row(inviteId, 'claude');
    if (row === undefined || row.sealed === null || row.broken_at !== null) return undefined;
    if (row.expires_at !== null && this.now() >= row.expires_at) return undefined;
    const token = open(this.key, aad(inviteId, 'claude'), row.sealed);
    return token === undefined ? undefined : { CLAUDE_CODE_OAUTH_TOKEN: token };
  }

  /**
   * The vendor answered 401: the credential is dropped from the store at once and the connection
   * shows as broken until the user links again. Nothing retries it, and no other invite's credential
   * is tried in its place.
   */
  markBroken(inviteId: string, vendor: PlanVendor): void {
    this.db
      .prepare(
        'UPDATE plan_connections SET sealed = NULL, broken_at = ? WHERE invite_id = ? AND vendor = ?',
      )
      .run(this.now(), inviteId, vendor);
  }

  /** Deletes the stored credential. True when there was one. New tasks stop getting it at once. */
  unlink(inviteId: string, vendor: PlanVendor): boolean {
    const result = this.db
      .prepare('DELETE FROM plan_connections WHERE invite_id = ? AND vendor = ?')
      .run(inviteId, vendor);
    return Number(result.changes) > 0;
  }

  private row(inviteId: string, vendor: PlanVendor): Row | undefined {
    return this.db
      .prepare('SELECT * FROM plan_connections WHERE invite_id = ? AND vendor = ?')
      .get(inviteId, vendor) as Row | undefined;
  }
}

function aad(inviteId: string, vendor: PlanVendor): string {
  return `maka-cloud/plan/v1/${inviteId}/${vendor}`;
}
