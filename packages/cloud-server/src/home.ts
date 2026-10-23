import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { accountReadiness, type Readiness } from './readiness.js';
import { transaction } from './db.js';
import { HttpError, readJson, respond, take } from './http.js';
import { type Language, messages } from './i18n.js';
import type { InboxOwners, InboxService } from './inbox.js';
import type { InviteInfo } from './invites.js';
import type { RateLimiter } from './rate-limit.js';

/**
 * Home as the server owns it (Hark pattern 4): the cards of one owner, in one order, with what the
 * owner has seen, so the web and the phone agree. The cards point at things the owner already has
 * (an inbox item, a task, a duty); a `note` is the one card the employee writes, and it is a
 * template with typed parameters, never text. Every card is built from this owner's own
 * conversations, projects and rows, so another owner's never appear.
 */

export const CARD_KINDS = ['waiting', 'suggestion', 'finished', 'note', 'scheduled'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export type CardRef =
  | { type: 'inbox'; id: string }
  | { type: 'task'; id: string; conversationId: string }
  | { type: 'duty'; id: string; projectId: string }
  | { type: 'note'; id: string };

export interface HomeCard {
  /** `<kind>:<id of what it points at>`: the same thing is always the same card. */
  cardId: string;
  kind: CardKind;
  ref: CardRef;
  /** Position in the whole list, from 0. */
  rank: number;
  /** When this owner last saw the card, or null. */
  seenAt: number | null;
  /** The time the card is about: when it was raised, when the task finished, when a duty runs next. */
  at: number;
  /** On a `finished` card: how the task ended. */
  state?: 'succeeded' | 'failed' | 'cancelled';
  /** On a `note` card: the template's words. */
  text?: string;
}

interface Draft extends Omit<HomeCard, 'rank' | 'seenAt'> {
  /** The default order inside the kind, lowest first. */
  sort: number[];
}

/** Cards the page lists per kind beyond the waiting ones, so Home stays a glance. */
const FINISHED_CARDS = 8;
const SCHEDULED_CARDS = 5;
const OPEN_ITEMS = 200;
const NOTE_CARDS = 5;
const NOTES_KEPT = 20;
const NOTE_AGE_MS = 7 * 86_400_000;
const SEEN_KEPT = 1000;
const SEEN_AGE_MS = 30 * 86_400_000;
const ORDER_KEPT = 500;
export const DAY_MS = 86_400_000;

// -- notes -------------------------------------------------------------------------------------

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const repo = z.string().regex(REPO);
const prNumber = z.number().int().positive().max(1_000_000_000);

/**
 * What a note may say. Every parameter is a typed token (a repository name from a fixed alphabet,
 * a number, one of a few words), so nothing a model or another person wrote can ride in a note:
 * the words around them are ours.
 */
const NoteSchema = z.discriminatedUnion('template', [
  z
    .object({
      template: z.literal('pull_request_merged'),
      repo,
      number: prNumber,
      checks: z.enum(['green', 'red', 'pending', 'none']),
    })
    .strict(),
  z.object({ template: z.literal('checks_failed'), repo, number: prNumber }).strict(),
]);
export type HomeNote = z.infer<typeof NoteSchema>;

/** A note's words, in the owner's language. */
export function noteText(note: HomeNote, language: Language = 'en'): string {
  const words = messages(language).note;
  switch (note.template) {
    case 'pull_request_merged':
      return words.pullRequestMerged(note.repo, note.number, note.checks);
    case 'checks_failed':
      return words.checksFailed(note.repo, note.number);
  }
}

// -- ranking -----------------------------------------------------------------------------------

const compare = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * The order of Home: waiting first, then suggestions, then what finished since the owner last
 * left, then the employee's notes, then what runs next. Inside a kind, the cards the owner has
 * moved keep the owner's order and come after the ones that have arrived since; the rest follow
 * the kind's own order (`sort`). Same input, same list: a card id breaks every tie.
 */
export function rankCards(
  drafts: readonly Draft[],
  pinned: ReadonlyMap<string, number>,
  seen: ReadonlyMap<string, number>,
): HomeCard[] {
  const byKind = (kind: CardKind) => drafts.filter((draft) => draft.kind === kind);
  const ordered: Draft[] = [];
  for (const kind of CARD_KINDS) {
    const group = byKind(kind);
    const fresh = group
      .filter((draft) => !pinned.has(draft.cardId))
      .sort((a, b) => compare(a.sort, b.sort) || (a.cardId < b.cardId ? -1 : 1));
    const moved = group
      .filter((draft) => pinned.has(draft.cardId))
      .sort((a, b) => (pinned.get(a.cardId) ?? 0) - (pinned.get(b.cardId) ?? 0));
    ordered.push(...fresh, ...moved);
  }
  return ordered.map(({ sort: _sort, ...card }, rank) => ({
    ...card,
    rank,
    seenAt: seen.get(card.cardId) ?? null,
  }));
}

// -- what the server keeps -----------------------------------------------------------------------

interface FinishedRow {
  taskId: string;
  at: number;
  type: string;
  conversationId: string;
}

const ENDED = {
  task_succeeded: 'succeeded',
  task_failed: 'failed',
  task_cancelled: 'cancelled',
} as const;

/** The owner's Home rows. Nothing here is read without the owner it belongs to. */
export class HomeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  readiness(owner: string, language: boolean, project: boolean, model: boolean): Readiness {
    const rows = this.db
      .prepare('SELECT step, until_at AS untilAt FROM home_setup WHERE owner = ?')
      .all(owner) as unknown as { step: string; untilAt: number }[];
    const permission = this.db
      .prepare('SELECT notifications_allowed AS allowed FROM home_permissions WHERE owner = ?')
      .get(owner) as { allowed: number } | undefined;
    const message = this.db
      .prepare(
        `SELECT 1 FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.owner = ? AND m.role = 'user' LIMIT 1`,
      )
      .get(owner);
    return accountReadiness(
      {
        language,
        project,
        model,
        notifications: permission?.allowed === 1,
        conversation: !!message,
      },
      new Map(rows.map((row) => [row.step, row.untilAt])),
      this.now(),
    );
  }

  setup(owner: string, report: { dismiss?: string; notificationsAllowed?: boolean }): void {
    if (report.dismiss !== undefined)
      this.db
        .prepare(
          `INSERT INTO home_setup VALUES (?, ?, ?) ON CONFLICT (owner, step) DO UPDATE SET until_at = excluded.until_at`,
        )
        .run(owner, report.dismiss, this.now() + DAY_MS);
    if (report.notificationsAllowed !== undefined)
      this.db
        .prepare(
          `INSERT INTO home_permissions VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET notifications_allowed = excluded.notifications_allowed`,
        )
        .run(owner, Number(report.notificationsAllowed));
  }

  visitedAt(owner: string): number | undefined {
    const row = this.db
      .prepare('SELECT visited_at AS at FROM home_visits WHERE owner = ?')
      .get(owner) as { at: number } | undefined;
    return row?.at;
  }

  seenAt(owner: string): Map<string, number> {
    const rows = this.db
      .prepare('SELECT card_id AS id, seen_at AS at FROM home_seen WHERE owner = ?')
      .all(owner) as unknown as Array<{ id: string; at: number }>;
    return new Map(rows.map((row) => [row.id, row.at]));
  }

  pinned(owner: string): Map<string, number> {
    const rows = this.db
      .prepare('SELECT card_id AS id, pos FROM home_order WHERE owner = ?')
      .all(owner) as unknown as Array<{ id: string; pos: number }>;
    return new Map(rows.map((row) => [row.id, row.pos]));
  }

  /** Top-level tasks of the owner's conversations that ended after `since`, newest first. */
  finished(owner: string, since: number, limit: number): FinishedRow[] {
    return this.db
      .prepare(
        `SELECT t.task_id AS taskId, t.at AS at, json_extract(t.event, '$.type') AS type,
                c.conversation_id AS conversationId
         FROM conversations c
         JOIN task_index i ON i.root_session_id = c.session_id AND i.parent_task_id IS NULL
         JOIN task_log t ON t.task_id = i.task_id
           AND json_extract(t.event, '$.type') IN ('task_succeeded', 'task_failed', 'task_cancelled')
         WHERE c.owner = ? AND t.at > ?
           AND t.seq = (SELECT MAX(e.seq) FROM task_log e WHERE e.task_id = t.task_id
             AND json_extract(e.event, '$.type') IN ('task_succeeded', 'task_failed', 'task_cancelled'))
         ORDER BY t.at DESC, t.seq DESC
         LIMIT ?`,
      )
      .all(owner, since, limit) as unknown as FinishedRow[];
  }

  notes(owner: string): Array<{ noteId: string; at: number; note: HomeNote }> {
    const rows = this.db
      .prepare(
        'SELECT note_id AS id, created_at AS at, template, params FROM home_notes WHERE owner = ? AND created_at > ? ORDER BY created_at DESC, note_id LIMIT ?',
      )
      .all(owner, this.now() - NOTE_AGE_MS, NOTE_CARDS) as unknown as Array<{
      id: string;
      at: number;
      template: string;
      params: string;
    }>;
    return rows.flatMap((row) => {
      // Read back through the same schema: a row that no longer fits it (or is not JSON) is not shown.
      let params: unknown;
      try {
        params = JSON.parse(row.params);
      } catch {
        return [];
      }
      const parsed = NoteSchema.safeParse({ template: row.template, ...(params as object) });
      return parsed.success ? [{ noteId: row.id, at: row.at, note: parsed.data }] : [];
    });
  }

  /**
   * The employee puts one fact on the owner's Home. Only a known template with its typed
   * parameters is accepted, and the same fact twice is one card.
   */
  addNote(owner: string, input: unknown): 'added' | 'duplicate' | 'invalid' {
    const parsed = NoteSchema.safeParse(input);
    if (!parsed.success) return 'invalid';
    const { template, ...params } = parsed.data;
    const body = JSON.stringify(params, Object.keys(params).sort());
    const dedupe = createHash('sha256').update(`${template}\n${body}`).digest('hex').slice(0, 32);
    return transaction(this.db, () => {
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO home_notes (note_id, owner, dedupe, template, params, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(`note_${randomUUID().replaceAll('-', '')}`, owner, dedupe, template, body, this.now());
      if (inserted.changes === 0) return 'duplicate';
      this.db
        .prepare(
          `DELETE FROM home_notes WHERE owner = ? AND note_id NOT IN
             (SELECT note_id FROM home_notes WHERE owner = ? ORDER BY created_at DESC, note_id LIMIT ?)`,
        )
        .run(owner, owner, NOTES_KEPT);
      return 'added';
    });
  }

  /** Records that the owner saw these cards and left Home now. */
  markSeen(owner: string, cardIds: readonly string[]): number {
    const at = this.now();
    transaction(this.db, () => {
      const put = this.db.prepare(
        `INSERT INTO home_seen (owner, card_id, seen_at) VALUES (?, ?, ?)
         ON CONFLICT (owner, card_id) DO UPDATE SET seen_at = excluded.seen_at`,
      );
      for (const id of cardIds) put.run(owner, id, at);
      this.db
        .prepare(
          `INSERT INTO home_visits (owner, visited_at) VALUES (?, ?)
           ON CONFLICT (owner) DO UPDATE SET visited_at = excluded.visited_at`,
        )
        .run(owner, at);
      this.db
        .prepare('DELETE FROM home_seen WHERE owner = ? AND seen_at < ?')
        .run(owner, at - SEEN_AGE_MS);
      this.db
        .prepare(
          `DELETE FROM home_seen WHERE owner = ? AND card_id NOT IN
             (SELECT card_id FROM home_seen WHERE owner = ? ORDER BY seen_at DESC, card_id LIMIT ?)`,
        )
        .run(owner, owner, SEEN_KEPT);
    });
    return at;
  }

  /**
   * Keeps the owner's order for `moved` (ids in the order to show them) and forgets the order of
   * cards that are gone: `live` is every card there is now.
   */
  setOrder(owner: string, moved: readonly string[], live: ReadonlySet<string>): void {
    transaction(this.db, () => {
      const rows = this.db
        .prepare('SELECT card_id AS id FROM home_order WHERE owner = ?')
        .all(owner) as unknown as Array<{ id: string }>;
      const drop = this.db.prepare('DELETE FROM home_order WHERE owner = ? AND card_id = ?');
      for (const { id } of rows) if (!live.has(id) || moved.includes(id)) drop.run(owner, id);
      const put = this.db.prepare('INSERT INTO home_order (owner, card_id, pos) VALUES (?, ?, ?)');
      moved.forEach((id, pos) => {
        put.run(owner, id, pos);
      });
      this.db
        .prepare(
          `DELETE FROM home_order WHERE owner = ? AND card_id NOT IN
             (SELECT card_id FROM home_order WHERE owner = ? ORDER BY pos, card_id LIMIT ?)`,
        )
        .run(owner, owner, ORDER_KEPT);
    });
  }
}

// -- the routes ----------------------------------------------------------------------------------

/** What Home needs of the duties engine: the owner's projects, as the engine's own JSON. */
export interface HomeDuties {
  listProjects(owner: string): unknown[];
}

const InboxItemShape = z
  .object({
    itemId: z.string().min(1),
    kind: z.string(),
    createdAt: z.number(),
    interrupts: z.boolean().optional(),
  })
  .passthrough();

const ProjectShape = z
  .object({
    projectId: z.string().min(1),
    duties: z.array(
      z
        .object({
          dutyId: z.string().min(1),
          state: z.string(),
          activatedAt: z.number().nullable(),
          trigger: z
            .object({ kind: z.string(), everyMinutes: z.number().optional() })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const cardIdSchema = z.string().min(3).max(200);
const seenBody = z.object({ cardIds: z.array(cardIdSchema).max(100) }).strict();
const orderBody = z.object({ cardId: cardIdSchema, after: cardIdSchema.nullable() }).strict();

/** The `/v1/home` routes. */
export class HomeRoutes {
  constructor(
    private readonly store: HomeStore,
    private readonly sources: {
      inbox?: Pick<InboxService, 'list'>;
      duties?: HomeDuties;
      languageChosen?: (owner: string) => boolean;
      modelAvailable?: () => boolean;
    },
    private readonly limiter: RateLimiter,
    private readonly owners: InboxOwners,
    private readonly now: () => number = Date.now,
  ) {}

  /** Answers a request under `/v1/home`, or returns false for a path that is not one of its routes. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
  ): Promise<boolean> {
    const method = req.method ?? 'GET';
    const owner = invite.inviteId;
    switch (url.pathname) {
      case '/v1/home': {
        allow(method, 'GET');
        const { cards } = await this.build(owner);
        respond(res, 200, { cards, readiness: this.readiness(owner) });
        return true;
      }
      case '/v1/home/setup': {
        allow(method, 'POST');
        take(this.limiter, invite);
        const body = z
          .union([
            z
              .object({
                dismiss: z.enum(['language', 'project', 'model', 'notifications', 'conversation']),
              })
              .strict(),
            z.object({ notificationsAllowed: z.boolean() }).strict(),
          ])
          .safeParse(await readJson(req, false));
        if (!body.success) throw new HttpError(400, 'invalid_request');
        this.checkActive(invite);
        this.store.setup(owner, body.data);
        respond(res, 200, { readiness: this.readiness(owner) });
        return true;
      }
      case '/v1/home/seen': {
        allow(method, 'POST');
        take(this.limiter, invite);
        const body = seenBody.safeParse(await readJson(req, false));
        if (!body.success) throw new HttpError(400, 'invalid_request');
        this.checkActive(invite);
        // Only cards that are on this owner's Home are recorded; the finished ones that were shown
        // are history from here on, because the visit moves to now.
        const { cards } = await this.build(owner);
        const live = new Set(cards.map((card) => card.cardId));
        const seen = [...new Set(body.data.cardIds)].filter((id) => live.has(id));
        const visitedAt = this.store.markSeen(owner, seen);
        respond(res, 200, { seen, visitedAt });
        return true;
      }
      case '/v1/home/order': {
        allow(method, 'POST');
        take(this.limiter, invite);
        const body = orderBody.safeParse(await readJson(req, false));
        if (!body.success) throw new HttpError(400, 'invalid_request');
        this.checkActive(invite);
        const { cards, drafts, pinned, seen } = await this.build(owner);
        const card = cards.find((shown) => shown.cardId === body.data.cardId);
        if (!card) throw new HttpError(404, 'not_found');
        // Waiting always leads, then each kind in its place: a card moves inside its kind.
        const group = cards
          .filter((shown) => shown.kind === card.kind)
          .map((shown) => shown.cardId);
        const rest = group.filter((id) => id !== card.cardId);
        let at = 0;
        if (body.data.after !== null) {
          const after = rest.indexOf(body.data.after);
          if (after < 0) throw new HttpError(400, 'invalid_request');
          at = after + 1;
        }
        const moved = [...rest.slice(0, at), card.cardId, ...rest.slice(at)];
        const live = new Set(cards.map((shown) => shown.cardId));
        this.store.setOrder(owner, moved, live);
        // The list as the next read will show it.
        const next = new Map(pinned);
        for (const id of group) next.delete(id);
        moved.forEach((id, pos) => next.set(id, pos));
        respond(res, 200, { cards: rankCards(drafts, next, seen) });
        return true;
      }
    }
    return false;
  }

  private readiness(owner: string): Readiness {
    return this.store.readiness(
      owner,
      this.sources.languageChosen?.(owner) ?? false,
      (this.sources.duties?.listProjects(owner).length ?? 0) > 0,
      this.sources.modelAvailable?.() ?? false,
    );
  }

  private checkActive(invite: InviteInfo): void {
    if (!this.owners.active(invite.inviteId, invite.sessionId)) {
      throw new HttpError(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
  }

  private async build(owner: string) {
    const now = this.now();
    const drafts: Draft[] = [];

    if (this.sources.inbox) {
      const page = await this.sources.inbox.list({
        state: 'open',
        after: 0,
        limit: OPEN_ITEMS,
        conversations: this.owners.conversationsOf(owner),
      });
      for (const raw of page.items) {
        const item = InboxItemShape.safeParse(raw);
        if (!item.success) continue;
        const kind = item.data.kind === 'suggestion' ? 'suggestion' : 'waiting';
        drafts.push({
          cardId: `${kind}:${item.data.itemId}`,
          kind,
          ref: { type: 'inbox', id: item.data.itemId },
          at: item.data.createdAt,
          // A decision that interrupts goes first, then the one that has waited longest; a
          // suggestion is newest first.
          sort:
            kind === 'waiting'
              ? [item.data.interrupts === true ? 0 : 1, item.data.createdAt]
              : [-item.data.createdAt],
        });
      }
    }

    const since = this.store.visitedAt(owner) ?? now - DAY_MS;
    for (const row of this.store.finished(owner, since, FINISHED_CARDS)) {
      const state = ENDED[row.type as keyof typeof ENDED];
      if (state === undefined) continue;
      drafts.push({
        cardId: `finished:${row.taskId}`,
        kind: 'finished',
        ref: { type: 'task', id: row.taskId, conversationId: row.conversationId },
        at: row.at,
        state,
        sort: [-row.at],
      });
    }

    for (const { noteId, at, note } of this.store.notes(owner)) {
      drafts.push({
        cardId: `note:${noteId}`,
        kind: 'note',
        ref: { type: 'note', id: noteId },
        at,
        text: noteText(note, this.owners.languageOf?.(owner)),
        sort: [-at],
      });
    }

    drafts.push(...this.scheduled(owner, now));

    const pinned = this.store.pinned(owner);
    const seen = this.store.seenAt(owner);
    return { drafts, pinned, seen, cards: rankCards(drafts, pinned, seen) };
  }

  /**
   * Duties on a schedule that are on, soonest first. A schedule runs every `everyMinutes`, counted
   * from the moment the duty was approved; a duty that wakes on a GitHub event has no time and no card.
   */
  private scheduled(owner: string, now: number): Draft[] {
    if (!this.sources.duties) return [];
    const runs: Draft[] = [];
    for (const raw of this.sources.duties.listProjects(owner)) {
      const project = ProjectShape.safeParse(raw);
      if (!project.success) continue;
      for (const duty of project.data.duties) {
        const period = (duty.trigger.everyMinutes ?? 0) * 60_000;
        if (
          duty.state !== 'active' ||
          duty.trigger.kind !== 'schedule' ||
          period <= 0 ||
          duty.activatedAt === null
        ) {
          continue;
        }
        const slots = Math.max(0, Math.floor((now - duty.activatedAt) / period)) + 1;
        const at = duty.activatedAt + slots * period;
        runs.push({
          cardId: `scheduled:${duty.dutyId}`,
          kind: 'scheduled',
          ref: { type: 'duty', id: duty.dutyId, projectId: project.data.projectId },
          at,
          sort: [at],
        });
      }
    }
    return runs.sort((a, b) => compare(a.sort, b.sort)).slice(0, SCHEDULED_CARDS);
  }
}

function allow(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, 'method_not_allowed', { allow: expected });
}
