import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { MemorySuperagentStore } from './memory-store.js';
import type { SuperagentStore } from './store.js';
import type {
  ApprovalRecord,
  AuditRecord,
  InboxItem,
  NormalizedEvent,
  Subscription,
  TenantBoxRecord,
  Usage,
  UsageEntry,
  WorkerRecord,
} from './types.js';
import { emptyUsage, isLiveState, tenantBoxAsWorker } from './types.js';

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  subject_key TEXT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE UNIQUE INDEX events_idem ON events (tenant_id, idempotency_key);

CREATE TABLE workers (
  worker_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE INDEX workers_tenant_state ON workers (tenant_id, state);

CREATE TABLE subscriptions (
  subscription_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE UNIQUE INDEX subs_live ON subscriptions (tenant_id, subject_key, worker_id)
  WHERE retired_at IS NULL;

CREATE TABLE inbox (
  worker_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (worker_id, seq)
);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  bound_text TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE audit (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  worker_id TEXT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE usage (
  tenant_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  usd_micros INTEGER NOT NULL,
  wall_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, worker_id)
);

CREATE TABLE usage_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  usd_micros INTEGER NOT NULL,
  wall_ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX usage_events_tenant ON usage_events (tenant_id, at);
`;

const USAGE_EVENTS_V2 = `
CREATE TABLE IF NOT EXISTS usage_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  usd_micros INTEGER NOT NULL,
  wall_ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_tenant ON usage_events (tenant_id, at);
`;

export class SuperagentDatabaseInUseError extends Error {
  constructor(readonly path: string) {
    super(`The superagent database is already open: ${path}`);
    this.name = 'SuperagentDatabaseInUseError';
  }
}

export class SuperagentDatabaseVersionError extends Error {
  constructor(
    readonly path: string,
    readonly version: number,
  ) {
    super(
      `The superagent database ${path} is schema version ${version}; this build reads version ${SCHEMA_VERSION}.`,
    );
    this.name = 'SuperagentDatabaseVersionError';
  }
}

export function openSuperagentDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    const version = userVersion(db);
    if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
      throw new SuperagentDatabaseVersionError(path, version);
    }
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    if (isBusy(error)) throw new SuperagentDatabaseInUseError(path);
    throw error;
  }
  db.exec('PRAGMA synchronous = FULL');
  const current = userVersion(db);
  if (current === 0) {
    db.exec('BEGIN IMMEDIATE');
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } else if (current === 1) {
    // Additive: append-only tenant usage events. Not a cloud-server migration.
    db.exec('BEGIN IMMEDIATE');
    db.exec(USAGE_EVENTS_V2);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  }
  return db;
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return code !== undefined && [5, 6].includes(code & 0xff);
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/**
 * Sqlite-backed store. The memory store is the in-process projection; sqlite is
 * the restart truth. Writes go to both.
 */
export class SqliteSuperagentStore implements SuperagentStore {
  private readonly memory = new MemorySuperagentStore();

  constructor(private readonly db: DatabaseSync) {
    this.replay();
  }

  static open(path: string): SqliteSuperagentStore {
    return new SqliteSuperagentStore(openSuperagentDatabase(path));
  }

  private replay(): void {
    for (const row of this.db.prepare('SELECT json FROM events').all() as Array<{ json: string }>) {
      this.memory.putEvent(JSON.parse(row.json) as NormalizedEvent);
    }
    for (const row of this.db.prepare('SELECT json FROM workers').all() as Array<{
      json: string;
    }>) {
      this.memory.putWorker(JSON.parse(row.json) as WorkerRecord);
    }
    for (const row of this.db
      .prepare(
        'SELECT subscription_id, tenant_id, subject_key, worker_id, created_at, retired_at FROM subscriptions',
      )
      .all() as Array<{
      subscription_id: string;
      tenant_id: string;
      subject_key: string;
      worker_id: string;
      created_at: number;
      retired_at: number | null;
    }>) {
      this.memory.putSubscription({
        subscriptionId: row.subscription_id,
        tenantId: row.tenant_id,
        subjectKey: row.subject_key,
        workerId: row.worker_id,
        createdAt: row.created_at,
        retiredAt: row.retired_at,
      });
    }
    for (const row of this.db
      .prepare('SELECT worker_id, seq, event_id, delivered_at, consumed_at FROM inbox ORDER BY seq')
      .all() as Array<{
      worker_id: string;
      seq: number;
      event_id: string;
      delivered_at: number;
      consumed_at: number | null;
    }>) {
      this.memory.putInbox({
        workerId: row.worker_id,
        seq: row.seq,
        eventId: row.event_id,
        deliveredAt: row.delivered_at,
        consumedAt: row.consumed_at,
      });
    }
    for (const row of this.db
      .prepare(
        'SELECT approval_id, tenant_id, worker_id, kind, bound_text, state, created_at, expires_at, decided_at FROM approvals',
      )
      .all() as Array<{
      approval_id: string;
      tenant_id: string;
      worker_id: string;
      kind: ApprovalRecord['kind'];
      bound_text: string;
      state: ApprovalRecord['state'];
      created_at: number;
      expires_at: number;
      decided_at: number | null;
    }>) {
      this.memory.putApproval({
        approvalId: row.approval_id,
        tenantId: row.tenant_id,
        workerId: row.worker_id,
        kind: row.kind,
        boundText: row.bound_text,
        state: row.state,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        decidedAt: row.decided_at,
      });
    }
    for (const row of this.db
      .prepare('SELECT audit_id, tenant_id, worker_id, kind, at, json FROM audit')
      .all() as Array<{
      audit_id: string;
      tenant_id: string;
      worker_id: string | null;
      kind: string;
      at: number;
      json: string;
    }>) {
      this.memory.appendAudit({
        auditId: row.audit_id,
        tenantId: row.tenant_id,
        workerId: row.worker_id,
        kind: row.kind,
        at: row.at,
        detail: JSON.parse(row.json) as AuditRecord['detail'],
      });
    }
    for (const row of this.db
      .prepare('SELECT tenant_id, worker_id, tokens, usd_micros, wall_ms, updated_at FROM usage')
      .all() as Array<{
      tenant_id: string;
      worker_id: string;
      tokens: number;
      usd_micros: number;
      wall_ms: number;
      updated_at: number;
    }>) {
      this.memory.putUsage(
        row.tenant_id,
        row.worker_id,
        { tokens: row.tokens, usdMicros: row.usd_micros, wallMs: row.wall_ms },
        row.updated_at,
      );
    }
    for (const row of this.db
      .prepare(
        'SELECT tenant_id, worker_id, tokens, usd_micros, wall_ms, at FROM usage_events ORDER BY seq',
      )
      .all() as Array<{
      tenant_id: string;
      worker_id: string;
      tokens: number;
      usd_micros: number;
      wall_ms: number;
      at: number;
    }>) {
      this.memory.appendUsageEvent({
        tenantId: row.tenant_id,
        workerId: row.worker_id,
        tokens: row.tokens,
        usdMicros: row.usd_micros,
        wallMs: row.wall_ms,
        at: row.at,
      });
    }
  }

  putEvent(event: NormalizedEvent): 'stored' | 'duplicate' {
    const result = this.memory.putEvent(event);
    if (result === 'duplicate') return result;
    this.db
      .prepare(
        `INSERT INTO events (event_id, tenant_id, idempotency_key, subject_key, source, type, occurred_at, received_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.tenantId,
        event.idempotencyKey,
        event.subject?.key ?? null,
        event.source,
        event.type,
        event.occurredAt,
        event.receivedAt,
        JSON.stringify(event),
      );
    return 'stored';
  }

  event(tenantId: string, eventId: string): NormalizedEvent | undefined {
    return this.memory.event(tenantId, eventId);
  }

  eventByIdempotency(tenantId: string, key: string): NormalizedEvent | undefined {
    return this.memory.eventByIdempotency(tenantId, key);
  }

  putWorker(worker: WorkerRecord): void {
    this.memory.putWorker(worker);
    this.db
      .prepare(
        `INSERT INTO workers (worker_id, tenant_id, subject_key, state, generation, json, created_at, updated_at, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           state=excluded.state,
           generation=excluded.generation,
           json=excluded.json,
           updated_at=excluded.updated_at,
           retired_at=excluded.retired_at`,
      )
      .run(
        worker.workerId,
        worker.tenantId,
        worker.subject.key,
        worker.state,
        worker.generation,
        JSON.stringify(worker),
        worker.createdAt,
        worker.updatedAt,
        worker.retiredAt,
      );
  }

  worker(tenantId: string, workerId: string): WorkerRecord | undefined {
    return this.memory.worker(tenantId, workerId);
  }

  liveWorkerBySubject(tenantId: string, subjectKey: string): WorkerRecord | undefined {
    return this.memory.liveWorkerBySubject(tenantId, subjectKey);
  }

  workers(tenantId: string): WorkerRecord[] {
    return this.memory.workers(tenantId);
  }

  allWorkers(): WorkerRecord[] {
    return this.memory.allWorkers();
  }

  putSubscription(sub: Subscription): void {
    this.memory.putSubscription(sub);
    this.db
      .prepare(
        `INSERT INTO subscriptions (subscription_id, tenant_id, subject_key, worker_id, created_at, retired_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sub.subscriptionId,
        sub.tenantId,
        sub.subjectKey,
        sub.workerId,
        sub.createdAt,
        sub.retiredAt,
      );
  }

  liveSubscribers(tenantId: string, subjectKey: string): Subscription[] {
    return this.memory.liveSubscribers(tenantId, subjectKey);
  }

  retireSubscription(tenantId: string, subscriptionId: string, at: number): void {
    this.memory.retireSubscription(tenantId, subscriptionId, at);
    this.db
      .prepare(
        'UPDATE subscriptions SET retired_at = ? WHERE subscription_id = ? AND tenant_id = ?',
      )
      .run(at, subscriptionId, tenantId);
  }

  enqueue(workerId: string, eventId: string, at: number): number {
    const seq = this.memory.enqueue(workerId, eventId, at);
    this.db
      .prepare(
        'INSERT INTO inbox (worker_id, seq, event_id, delivered_at, consumed_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(workerId, seq, eventId, at);
    return seq;
  }

  putInbox(item: InboxItem): void {
    this.memory.putInbox(item);
    this.db
      .prepare(
        'INSERT INTO inbox (worker_id, seq, event_id, delivered_at, consumed_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(item.workerId, item.seq, item.eventId, item.deliveredAt, item.consumedAt);
  }

  inbox(workerId: string): InboxItem[] {
    return this.memory.inbox(workerId);
  }

  consume(workerId: string, seq: number, at: number): void {
    this.memory.consume(workerId, seq, at);
    this.db
      .prepare('UPDATE inbox SET consumed_at = ? WHERE worker_id = ? AND seq = ?')
      .run(at, workerId, seq);
  }

  putApproval(row: ApprovalRecord): void {
    this.memory.putApproval(row);
    this.db
      .prepare(
        `INSERT INTO approvals (approval_id, tenant_id, worker_id, kind, bound_text, state, created_at, expires_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(approval_id) DO UPDATE SET state=excluded.state, decided_at=excluded.decided_at`,
      )
      .run(
        row.approvalId,
        row.tenantId,
        row.workerId,
        row.kind,
        row.boundText,
        row.state,
        row.createdAt,
        row.expiresAt,
        row.decidedAt,
      );
  }

  approval(tenantId: string, approvalId: string): ApprovalRecord | undefined {
    return this.memory.approval(tenantId, approvalId);
  }

  approvalsFor(tenantId: string, workerId: string): ApprovalRecord[] {
    return this.memory.approvalsFor(tenantId, workerId);
  }

  pendingApprovals(tenantId: string, workerId?: string): ApprovalRecord[] {
    return this.memory.pendingApprovals(tenantId, workerId);
  }

  appendAudit(row: AuditRecord): void {
    this.memory.appendAudit(row);
    this.db
      .prepare(
        'INSERT INTO audit (audit_id, tenant_id, worker_id, kind, at, json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.auditId, row.tenantId, row.workerId, row.kind, row.at, JSON.stringify(row.detail));
  }

  audit(tenantId: string): AuditRecord[] {
    return this.memory.audit(tenantId);
  }

  putUsage(tenantId: string, workerId: string, usage: Usage, at: number): void {
    this.memory.putUsage(tenantId, workerId, usage, at);
    this.db
      .prepare(
        `INSERT INTO usage (tenant_id, worker_id, tokens, usd_micros, wall_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, worker_id) DO UPDATE SET
           tokens=excluded.tokens, usd_micros=excluded.usd_micros, wall_ms=excluded.wall_ms, updated_at=excluded.updated_at`,
      )
      .run(tenantId, workerId, usage.tokens, usage.usdMicros, usage.wallMs, at);
  }

  usage(tenantId: string, workerId: string): Usage | undefined {
    return this.memory.usage(tenantId, workerId);
  }

  appendUsageEvent(entry: UsageEntry): void {
    this.memory.appendUsageEvent(entry);
    this.db
      .prepare(
        `INSERT INTO usage_events (tenant_id, worker_id, tokens, usd_micros, wall_ms, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.tenantId, entry.workerId, entry.tokens, entry.usdMicros, entry.wallMs, entry.at);
  }

  usageEvents(tenantId: string): UsageEntry[] {
    return this.memory.usageEvents(tenantId);
  }

  tenantUsage(tenantId: string) {
    return this.memory.tenantUsage(tenantId);
  }

  putTenantBox(box: TenantBoxRecord): void {
    this.putWorker(tenantBoxAsWorker(box));
  }

  tenantBox(tenantId: string): TenantBoxRecord | undefined {
    return this.memory.tenantBox(tenantId);
  }

  allTenantBoxes(): TenantBoxRecord[] {
    return this.memory.allTenantBoxes();
  }

  close(): void {
    this.memory.close();
    this.db.close();
  }

  async backupTo(destination: string): Promise<void> {
    await sqliteBackup(this.db, destination);
  }
}

/** Live worker lookup used by tests that inspect isolation without going through Superagent. */
export function isLiveWorker(worker: WorkerRecord): boolean {
  return isLiveState(worker.state);
}
