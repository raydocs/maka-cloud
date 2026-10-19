import type { DatabaseSync } from 'node:sqlite';
import type { TaskEvent } from '@maka-cloud/orchestrator';
import { toPublicEvent, toPublicItem } from './public-view.js';

export type FeedKind =
  | 'conversation.created'
  | 'message.posted'
  | 'task.event'
  | 'conductor.notice'
  | 'conductor.question'
  | 'conductor.answered'
  | 'inbox.item'
  | 'inbox.digest';

/** What a client receives. `id` is the position in the feed and the SSE event id. */
export interface FeedEntry {
  id: number;
  kind: FeedKind;
  conversationId: string | null;
  at: number;
  data: unknown;
}

/** Tells open streams that the feed moved. It carries no data: streams read the rows themselves. */
export class FeedHub {
  private readonly listeners = new Set<() => void>();

  get listening(): number {
    return this.listeners.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Must run inside the transaction that wrote the row `ref` points at. */
export function appendFeed(
  db: DatabaseSync,
  kind: FeedKind,
  conversationId: string | null,
  ref: string | number,
  at: number,
): number {
  const result = db
    .prepare('INSERT INTO feed (kind, conversation_id, ref, at) VALUES (?, ?, ?, ?)')
    .run(kind, conversationId, String(ref), at);
  return Number(result.lastInsertRowid);
}

interface FeedRow {
  id: number;
  kind: FeedKind;
  conversation_id: string | null;
  at: number;
  t_seq: number | null;
  t_at: number | null;
  t_event: string | null;
  message_id: string | null;
  role: string | null;
  text: string | null;
  m_at: number | null;
  title: string | null;
  c_at: number | null;
  e_data: string | null;
  x_data: string | null;
}

const PAGE_SQL = `
SELECT f.id, f.kind, f.conversation_id, f.at,
  t.seq AS t_seq, t.at AS t_at, t.event AS t_event,
  m.message_id, m.role, m.text, m.at AS m_at,
  c.title, c.created_at AS c_at,
  e.data AS e_data,
  x.data AS x_data
FROM feed f
LEFT JOIN task_log t ON f.kind = 'task.event' AND t.seq = CAST(f.ref AS INTEGER)
LEFT JOIN messages m ON f.kind = 'message.posted' AND m.message_id = f.ref
LEFT JOIN conversations c ON f.kind = 'conversation.created' AND c.conversation_id = f.ref
LEFT JOIN conductor_events e ON f.kind LIKE 'conductor.%' AND e.event_id = f.ref
LEFT JOIN extension_events x ON f.kind LIKE 'inbox.%' AND x.event_id = CAST(f.ref AS INTEGER)
WHERE f.id > ? AND f.id <= ? AND (? IS NULL OR f.conversation_id = ?)
  AND (? IS NULL OR f.conversation_id IN (SELECT conversation_id FROM conversations WHERE owner = ?))
ORDER BY f.id
LIMIT ?`;

/** The last feed id among the next `limit` rows after `after`, of every conversation. */
const WINDOW_SQL =
  'SELECT MAX(id) AS last FROM (SELECT id FROM feed WHERE id > ? ORDER BY id LIMIT ?)';

export interface ReadFeedOptions {
  /**
   * Keep the fields clients never see (a task's runner id). Only for components
   * inside the server process; what they publish is still their own to keep clean.
   */
  internal?: boolean;
}

/** Feed entries after `after`, in order, at most `limit`, optionally of one conversation. */
export function readFeed(
  db: DatabaseSync,
  after: number,
  limit: number,
  conversationId?: string,
  options: ReadFeedOptions = {},
): FeedEntry[] {
  return readRows(db, after, Number.MAX_SAFE_INTEGER, limit, conversationId ?? null, null, options);
}

/**
 * What one invite may read: entries of the conversations it owns, after `after`,
 * at most `limit`, optionally of one of them. Rows of other owners, of no
 * conversation and of unowned conversations are skipped. `scannedTo` is how far
 * the read looked, so a stream that skips other owners' rows never reads them
 * again.
 */
export function readOwnFeed(
  db: DatabaseSync,
  owner: string,
  after: number,
  limit: number,
  conversationId?: string,
): { entries: FeedEntry[]; scannedTo: number } {
  if (conversationId !== undefined) {
    const entries = readRows(db, after, Number.MAX_SAFE_INTEGER, limit, conversationId, owner);
    return { entries, scannedTo: entries.at(-1)?.id ?? after };
  }
  const { last } = db.prepare(WINDOW_SQL).get(after, limit) as { last: number | null };
  if (last === null) return { entries: [], scannedTo: after };
  return { entries: readRows(db, after, last, limit, null, owner), scannedTo: last };
}

function readRows(
  db: DatabaseSync,
  after: number,
  upTo: number,
  limit: number,
  conversationId: string | null,
  owner: string | null,
  options: ReadFeedOptions = {},
): FeedEntry[] {
  const rows = db
    .prepare(PAGE_SQL)
    .all(after, upTo, conversationId, conversationId, owner, owner, limit) as unknown as FeedRow[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    conversationId: row.conversation_id,
    at: row.at,
    data: payload(db, row, options.internal === true),
  }));
}

/**
 * What a task has cost so far as of log position `seq`, worked out the way the
 * orchestrator's reducer does: the most each run reported, added up.
 */
function costSoFar(db: DatabaseSync, taskId: string, seq: number): number {
  const rows = db
    .prepare(
      `SELECT MAX(json_extract(event, '$.costUsd')) AS usd FROM task_log
       WHERE task_id = ? AND seq <= ? AND json_extract(event, '$.type') = 'task_cost'
       GROUP BY json_extract(event, '$.fromTaskId')`,
    )
    .all(taskId, seq) as unknown as Array<{ usd: number }>;
  return Math.round(rows.reduce((sum, row) => sum + row.usd, 0) * 1e9) / 1e9;
}

function payload(db: DatabaseSync, row: FeedRow, internal: boolean): unknown {
  switch (row.kind) {
    case 'task.event': {
      const event = JSON.parse(row.t_event ?? 'null') as TaskEvent;
      return {
        seq: row.t_seq,
        at: row.t_at,
        event: internal ? event : toPublicEvent(event),
        // A cost event carries one run's figure; clients want the task's total.
        ...(event.type === 'task_cost' && row.t_seq !== null
          ? { totalCostUsd: costSoFar(db, event.taskId, row.t_seq) }
          : {}),
      };
    }
    case 'message.posted':
      return { messageId: row.message_id, role: row.role, text: row.text, at: row.m_at };
    case 'conversation.created':
      return { title: row.title, at: row.c_at };
    case 'conductor.notice':
    case 'conductor.question':
    case 'conductor.answered':
      return { ...(JSON.parse(row.e_data ?? '{}') as object), at: row.at };
    case 'inbox.item': {
      const item = JSON.parse(row.x_data ?? 'null') as unknown;
      return internal ? item : toPublicItem(item);
    }
    case 'inbox.digest':
      return JSON.parse(row.x_data ?? 'null') as unknown;
  }
}
