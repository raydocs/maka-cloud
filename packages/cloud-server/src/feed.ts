import type { DatabaseSync } from 'node:sqlite';
import type { TaskEvent } from '@maka-cloud/orchestrator';
import { toPublicEvent } from './public-view.js';

export type FeedKind = 'conversation.created' | 'message.posted' | 'task.event' | 'task.cost';

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
  k_task: string | null;
  k_usd: number | null;
}

const PAGE_SQL = `
SELECT f.id, f.kind, f.conversation_id, f.at,
  t.seq AS t_seq, t.at AS t_at, t.event AS t_event,
  m.message_id, m.role, m.text, m.at AS m_at,
  c.title, c.created_at AS c_at,
  k.task_id AS k_task, k.usd AS k_usd
FROM feed f
LEFT JOIN task_log t ON f.kind = 'task.event' AND t.seq = CAST(f.ref AS INTEGER)
LEFT JOIN messages m ON f.kind = 'message.posted' AND m.message_id = f.ref
LEFT JOIN conversations c ON f.kind = 'conversation.created' AND c.conversation_id = f.ref
LEFT JOIN task_cost_log k ON f.kind = 'task.cost' AND k.id = CAST(f.ref AS INTEGER)
WHERE f.id > ? AND (? IS NULL OR f.conversation_id = ?)
ORDER BY f.id
LIMIT ?`;

/** Feed entries after `after`, in order, at most `limit`, optionally of one conversation. */
export function readFeed(
  db: DatabaseSync,
  after: number,
  limit: number,
  conversationId?: string,
): FeedEntry[] {
  const scope = conversationId ?? null;
  const rows = db.prepare(PAGE_SQL).all(after, scope, scope, limit) as unknown as FeedRow[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    conversationId: row.conversation_id,
    at: row.at,
    data: payload(row),
  }));
}

function payload(row: FeedRow): unknown {
  switch (row.kind) {
    case 'task.event':
      return {
        seq: row.t_seq,
        at: row.t_at,
        event: toPublicEvent(JSON.parse(row.t_event ?? 'null') as TaskEvent),
      };
    case 'message.posted':
      return { messageId: row.message_id, role: row.role, text: row.text, at: row.m_at };
    case 'conversation.created':
      return { title: row.title, at: row.c_at };
    case 'task.cost':
      return { taskId: row.k_task, costUsd: row.k_usd, at: row.at };
  }
}
