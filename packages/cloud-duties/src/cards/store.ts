import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { transaction } from '../db.js';
import { type Authority, dayOf, fromMicro, toMicro } from '../types.js';
import {
  CARD_KINDS,
  type CardKind,
  type CardMode,
  defaultEnabledKinds,
  isCardKind,
  KIND_SPECS,
} from './kinds.js';
import { isPrintable } from './text.js';

/** At most this many new cards a day per project (UTC day). A refreshed card replaces one and is not new. */
export const MAX_CARDS_PER_DAY = 3;
/** A dismissed or ignored suggestion (same kind, same subject) is not shown again for this long. */
export const SUPPRESS_AFTER_NO_MS = 7 * 24 * 3_600_000;
/** A suggestion that was accepted is not proposed again while its task may still be running. */
export const SUPPRESS_AFTER_YES_MS = 24 * 3_600_000;
/** An open card nobody answered in this long is ignored. */
export const EXPIRE_AFTER_MS = 3 * 24 * 3_600_000;
/** After this many ignored cards of one kind in a row, the kind backs off and the owner is offered to turn it off. */
export const BACKOFF_AFTER_IGNORED = 3;
/** A backed-off kind proposes at most one new card in this long. */
export const BACKOFF_INTERVAL_MS = 7 * 24 * 3_600_000;

export const MAX_TITLE_CHARS = 120;
export const MAX_DETAIL_CHARS = 400;
export const MAX_BRIEF_CHARS = 12_000;
export const MAX_CARD_ESTIMATE_USD = 50;

export type CardState = 'open' | 'accepted' | 'dismissed' | 'stale' | 'expired';

/** How an accepted card's task ended. `stopped` is a person's stop; `abandoned` is a task that never began. */
export type CardOutcome = 'completed' | 'failed' | 'stopped' | 'abandoned';

/** A median of fewer finished tasks than this says too little to replace the table's estimate. */
export const MIN_TASKS_FOR_TYPICAL = 3;
/** The estimate is the median of this many of the latest finished tasks of the kind. */
export const TASKS_FOR_TYPICAL = 5;

export interface Card {
  cardId: string;
  owner: string;
  projectId: string;
  kind: CardKind;
  /** What the card is about inside the project: `main`, `pr:12`, `issue:9`. With the kind it names the suggestion. */
  subjectKey: string;
  /** Verb first, one line. */
  title: string;
  detail: string;
  /** The first message of the task a tap starts. Fixed when the card is made. */
  brief: string;
  /** From the kind's table, never from the card's text. */
  mode: CardMode;
  authority: Authority;
  estimateUsd: number;
  /** The estimate is what finished tasks of this kind typically spent, not the table's default. */
  typical: boolean;
  /** Hash of the state the card was made from; a tap checks it again first. */
  preconditionHash: string;
  /** Text from outside the owner shaped the card: a task started from it runs tainted. */
  external: boolean;
  state: CardState;
  /** The card this one refreshed. */
  replaces: string | null;
  createdAt: number;
  decidedAt: number | null;
  conversationId: string | null;
  /** What the task spent, once it ended. */
  spentUsd: number | null;
  outcome: CardOutcome | null;
  settledAt: number | null;
}

/** A card as a scan proposes it. Strict: authority and mode are not inputs. */
export const NewCardSchema = z
  .object({
    kind: z.enum(CARD_KINDS),
    subjectKey: z.string().regex(/^[a-z0-9][a-z0-9:._#/-]{0,99}$/u),
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    detail: z.string().max(MAX_DETAIL_CHARS),
    brief: z.string().min(1).max(MAX_BRIEF_CHARS),
    estimateUsd: z.number().positive().max(MAX_CARD_ESTIMATE_USD),
    typical: z.boolean().optional(),
    preconditionHash: z.string().regex(/^[0-9a-f]{64}$/u),
    external: z.boolean(),
  })
  .strict()
  .refine((card) => isPrintable(card.title) && isPrintable(card.detail), {
    message: 'A title and a detail show printable characters only.',
  })
  .refine((card) => isPrintable(card.brief, true), {
    message: 'A brief shows printable characters only.',
  });
export type NewCard = z.infer<typeof NewCardSchema>;

export type ProposeResult =
  | { ok: true; card: Card }
  | {
      ok: false;
      reason:
        | 'invalid'
        | 'not_found'
        | 'kind_unavailable'
        | 'kind_off'
        | 'already_open'
        | 'recently_decided'
        | 'backed_off'
        | 'daily_cap';
    };

export type CardChange =
  | { ok: true; duplicate: boolean; card: Card }
  | { ok: false; reason: 'not_found' | 'closed' | 'stale' };

export type OfferState = 'none' | 'due' | 'offered' | 'off';

/** What the owner sees about one kind in one project. */
export interface KindStats {
  kind: CardKind;
  enabled: boolean;
  accepted: number;
  dismissed: number;
  ignored: number;
  /** Cards of this kind dismissed or ignored since the last one accepted. */
  ignoredInARow: number;
  backedOff: boolean;
  offer: OfferState;
}

export interface CardStoreOptions {
  now?: () => number;
  /** Whether this owner may use this project right now (it exists, is theirs and is still permitted). */
  projectOk(owner: string, projectId: string): boolean;
  /** The kinds this build proposes. Default: every kind whose tool exists. */
  enabled?: ReadonlySet<CardKind>;
}

interface CardRow {
  card_id: string;
  owner: string;
  project_id: string;
  kind: string;
  subject_key: string;
  title: string;
  detail: string;
  brief: string;
  estimate_micro: number;
  precondition: string;
  external: number;
  state: CardState;
  replaces: string | null;
  created_at: number;
  decided_at: number | null;
  conversation_id: string | null;
  typical: number;
  spent_micro: number | null;
  outcome: CardOutcome | null;
  settled_at: number | null;
}

interface KindRow {
  project_id: string;
  kind: string;
  accepted: number;
  dismissed: number;
  ignored: number;
  streak: number;
  enabled: number;
  offer: OfferState;
}

/**
 * The cards a project's scan proposed and what the owner did with them, in the duties database.
 * Every limit that keeps cards from becoming noise (a daily cap, a week's silence after a "no",
 * a back-off after three ignored, a switch per kind) is checked in the same transaction that
 * writes the card, so two scans cannot both pass a check and exceed it. Every method that takes an
 * owner answers `not_found` for a card or a project that is not theirs.
 */
export class CardStore {
  private readonly now: () => number;
  private readonly enabled: ReadonlySet<CardKind>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: CardStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.enabled = options.enabled ?? defaultEnabledKinds();
  }

  /** Stores a new card unless a limit says not to. The first limit that applies is the reason. */
  propose(owner: string, projectId: string, input: unknown): ProposeResult {
    const parsed = NewCardSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    const card = parsed.data;
    if (!this.options.projectOk(owner, projectId)) return { ok: false, reason: 'not_found' };
    if (!this.enabled.has(card.kind)) return { ok: false, reason: 'kind_unavailable' };
    return transaction(this.db, () => {
      const at = this.now();
      const kind = this.kindRow(projectId, card.kind);
      if (kind && kind.enabled === 0) return { ok: false, reason: 'kind_off' } as const;
      if (this.openCard(projectId, card.kind, card.subjectKey)) {
        return { ok: false, reason: 'already_open' } as const;
      }
      if (this.recentlyDecided(projectId, card.kind, card.subjectKey, at)) {
        return { ok: false, reason: 'recently_decided' } as const;
      }
      if (kind && kind.streak >= BACKOFF_AFTER_IGNORED) {
        const last = this.lastNew(projectId, card.kind);
        if (last !== undefined && at - last < BACKOFF_INTERVAL_MS) {
          return { ok: false, reason: 'backed_off' } as const;
        }
      }
      if (this.newToday(projectId, at) >= MAX_CARDS_PER_DAY) {
        return { ok: false, reason: 'daily_cap' } as const;
      }
      return { ok: true, card: this.insert(owner, projectId, card, at, null) } as const;
    });
  }

  /**
   * Replaces an open card whose state changed with a fresh one of the same kind and subject. The
   * old card ends `stale`. The new one is not a new card for the day's cap or the back-off, and
   * the owner's earlier answers do not apply to it: it is the same suggestion, up to date.
   */
  refresh(
    owner: string,
    cardId: string,
    input: unknown,
  ): { ok: true; card: Card } | { ok: false; reason: 'invalid' | 'not_found' | 'closed' } {
    const parsed = NewCardSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    return transaction(this.db, () => {
      const old = this.rowOf(owner, cardId);
      if (!old || !this.options.projectOk(owner, old.project_id)) {
        return { ok: false, reason: 'not_found' } as const;
      }
      if (old.state !== 'open') return { ok: false, reason: 'closed' } as const;
      const next = parsed.data;
      if (next.kind !== old.kind || next.subjectKey !== old.subject_key) {
        return { ok: false, reason: 'invalid' } as const;
      }
      if (!this.enabled.has(next.kind)) return { ok: false, reason: 'closed' } as const;
      const at = this.now();
      this.db
        .prepare("UPDATE cards SET state = 'stale', decided_at = ? WHERE card_id = ?")
        .run(at, cardId);
      return {
        ok: true,
        card: this.insert(owner, old.project_id, next, at, cardId),
      } as const;
    });
  }

  /** Ends an open card whose condition no longer holds. Counts as no answer: not ignored, not declined. */
  retire(owner: string, cardId: string): CardChange {
    return transaction(this.db, () => {
      const row = this.rowOf(owner, cardId);
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (row.state === 'stale') return { ok: true, duplicate: true, card: view(row) } as const;
      if (row.state !== 'open') return { ok: false, reason: 'closed' } as const;
      const at = this.now();
      this.db
        .prepare("UPDATE cards SET state = 'stale', decided_at = ? WHERE card_id = ?")
        .run(at, cardId);
      return { ok: true, duplicate: false, card: view({ ...row, state: 'stale', decided_at: at }) };
    });
  }

  get(owner: string, cardId: string): Card | undefined {
    const row = this.rowOf(owner, cardId);
    return row && this.options.projectOk(owner, row.project_id) ? view(row) : undefined;
  }

  list(owner: string, projectId: string, states?: readonly CardState[]): Card[] {
    if (!this.options.projectOk(owner, projectId)) return [];
    const rows = this.db
      .prepare(
        'SELECT * FROM cards WHERE owner = ? AND project_id = ? ORDER BY created_at, card_id',
      )
      .all(owner, projectId) as unknown as CardRow[];
    return rows.filter((row) => !states || states.includes(row.state)).map(view);
  }

  /** The owner said no. Idempotent; the same card answered the other way is `closed`. */
  dismiss(owner: string, cardId: string): CardChange {
    return this.decide(owner, cardId, 'dismissed');
  }

  /**
   * The owner said yes: the card is spent, once. A second call returns the same card with
   * `duplicate`, so a double tap and a retry after a crash start one task between them.
   */
  accept(owner: string, cardId: string): CardChange {
    return this.decide(owner, cardId, 'accepted');
  }

  /** Remembers which conversation an accepted card started. */
  attachConversation(owner: string, cardId: string, conversationId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE cards SET conversation_id = ? WHERE card_id = ? AND owner = ? AND state = 'accepted' AND conversation_id IS NULL",
      )
      .run(conversationId, cardId, owner);
    return Number(result.changes) === 1;
  }

  /** Accepted cards whose task started and has not been settled yet, oldest first. */
  unsettled(): Card[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM cards WHERE state = 'accepted' AND conversation_id IS NOT NULL AND settled_at IS NULL ORDER BY decided_at, card_id",
        )
        .all() as unknown as CardRow[]
    ).map(view);
  }

  /**
   * Accepted cards whose task never started: the process died between spending the card and
   * starting the task. Starting again under the card's key is safe.
   */
  unstarted(): Card[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM cards WHERE state = 'accepted' AND conversation_id IS NULL ORDER BY decided_at, card_id",
        )
        .all() as unknown as CardRow[]
    ).map(view);
  }

  /** Records how an accepted card's task ended and what it spent. Once only; false if it was settled already. */
  settle(cardId: string, outcome: CardOutcome, spentUsd: number): boolean {
    if (!Number.isFinite(spentUsd) || spentUsd < 0) return false;
    const result = this.db
      .prepare(
        "UPDATE cards SET settled_at = ?, outcome = ?, spent_micro = ? WHERE card_id = ? AND state = 'accepted' AND settled_at IS NULL",
      )
      .run(this.now(), outcome, toMicro(spentUsd), cardId);
    return Number(result.changes) === 1;
  }

  /**
   * What the owner's finished tasks of this kind typically spent: the median of the last
   * `TASKS_FOR_TYPICAL` that ran (finished or failed with a spend). A task a person stopped or
   * that never began says nothing about cost. Undefined until `MIN_TASKS_FOR_TYPICAL` exist.
   */
  typicalUsd(owner: string, kind: CardKind): number | undefined {
    const rows = this.db
      .prepare(
        `SELECT spent_micro FROM cards
         WHERE owner = ? AND kind = ? AND outcome IN ('completed', 'failed') AND spent_micro > 0
         ORDER BY settled_at DESC, card_id DESC LIMIT ?`,
      )
      .all(owner, kind, TASKS_FOR_TYPICAL) as unknown as Array<{ spent_micro: number }>;
    if (rows.length < MIN_TASKS_FOR_TYPICAL) return undefined;
    const spent = rows.map((r) => r.spent_micro).sort((a, b) => a - b);
    const mid = Math.floor(spent.length / 2);
    const median =
      spent.length % 2 === 1
        ? (spent[mid] as number)
        : ((spent[mid - 1] as number) + (spent[mid] as number)) / 2;
    const usd = Math.round(fromMicro(median) * 100) / 100;
    return usd > 0 ? Math.min(usd, MAX_CARD_ESTIMATE_USD) : undefined;
  }

  /**
   * Open cards nobody answered in `EXPIRE_AFTER_MS` end `expired` and count as ignored. Returns
   * them, so whoever shows them can take them down.
   */
  expire(): Card[] {
    return transaction(this.db, () => {
      const at = this.now();
      const rows = this.db
        .prepare("SELECT * FROM cards WHERE state = 'open' AND created_at <= ?")
        .all(at - EXPIRE_AFTER_MS) as unknown as CardRow[];
      for (const row of rows) {
        this.db
          .prepare("UPDATE cards SET state = 'expired', decided_at = ? WHERE card_id = ?")
          .run(at, row.card_id);
        this.count(row.project_id, row.kind as CardKind, 'ignored');
      }
      return rows.map((row) => view({ ...row, state: 'expired', decided_at: at }));
    });
  }

  /** The switches and counts of every kind this build proposes, for one project. */
  stats(owner: string, projectId: string): KindStats[] {
    if (!this.options.projectOk(owner, projectId)) return [];
    return CARD_KINDS.filter((kind) => this.enabled.has(kind)).map((kind) => {
      const row = this.kindRow(projectId, kind);
      return {
        kind,
        enabled: row ? row.enabled === 1 : true,
        accepted: row?.accepted ?? 0,
        dismissed: row?.dismissed ?? 0,
        ignored: row?.ignored ?? 0,
        ignoredInARow: row?.streak ?? 0,
        backedOff: (row?.streak ?? 0) >= BACKOFF_AFTER_IGNORED,
        offer: row?.offer ?? 'none',
      };
    });
  }

  /** Turns a kind on or off for one project. Turning it on starts its count of ignored cards again. */
  setKindEnabled(owner: string, projectId: string, kind: unknown, enabled: boolean): boolean {
    if (!isCardKind(kind) || !this.enabled.has(kind)) return false;
    if (!this.options.projectOk(owner, projectId)) return false;
    transaction(this.db, () => {
      this.ensureKind(projectId, kind);
      this.db
        .prepare(
          `UPDATE card_kinds SET enabled = ?, streak = CASE WHEN ? = 1 THEN 0 ELSE streak END,
             offer = ? WHERE project_id = ? AND kind = ?`,
        )
        .run(enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 'none' : 'off', projectId, kind);
    });
    return true;
  }

  /**
   * The kinds that reached `BACKOFF_AFTER_IGNORED` ignored cards in a row and have not been
   * offered for turning off yet. Each is returned once: it is marked `offered` here, so a caller
   * that raises the offer does it exactly once per kind.
   */
  takeOffers(owner: string, projectId: string): CardKind[] {
    if (!this.options.projectOk(owner, projectId)) return [];
    return transaction(this.db, () => {
      const rows = this.db
        .prepare("SELECT * FROM card_kinds WHERE project_id = ? AND offer = 'due' ORDER BY kind")
        .all(projectId) as unknown as KindRow[];
      this.db
        .prepare("UPDATE card_kinds SET offer = 'offered' WHERE project_id = ? AND offer = 'due'")
        .run(projectId);
      return rows.map((row) => row.kind as CardKind);
    });
  }

  /**
   * The owner's answer to the offer: `off` turns the kind off, `keep` ends its back-off by
   * counting from zero again. The same answer twice is a duplicate; the other answer after one
   * is `closed`.
   */
  answerOffer(
    owner: string,
    projectId: string,
    kind: unknown,
    answer: 'off' | 'keep',
  ): { ok: true; duplicate: boolean } | { ok: false; reason: 'not_found' | 'closed' } {
    if (!isCardKind(kind) || !this.options.projectOk(owner, projectId)) {
      return { ok: false, reason: 'not_found' };
    }
    return transaction(this.db, () => {
      const row = this.kindRow(projectId, kind);
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (answer === 'off') {
        if (row.enabled === 0) return { ok: true, duplicate: true } as const;
        if (row.offer !== 'offered' && row.offer !== 'due')
          return { ok: false, reason: 'closed' } as const;
        this.db
          .prepare(
            "UPDATE card_kinds SET enabled = 0, offer = 'off' WHERE project_id = ? AND kind = ?",
          )
          .run(projectId, kind);
        return { ok: true, duplicate: false } as const;
      }
      if (row.enabled === 0) return { ok: false, reason: 'closed' } as const;
      if (row.offer !== 'offered' && row.offer !== 'due')
        return { ok: true, duplicate: true } as const;
      this.db
        .prepare(
          "UPDATE card_kinds SET streak = 0, offer = 'none' WHERE project_id = ? AND kind = ?",
        )
        .run(projectId, kind);
      return { ok: true, duplicate: false } as const;
    });
  }

  // ----------------------------------------------------------------- inside

  private decide(owner: string, cardId: string, to: 'accepted' | 'dismissed'): CardChange {
    return transaction(this.db, () => {
      const row = this.rowOf(owner, cardId);
      if (!row || !this.options.projectOk(owner, row.project_id)) {
        return { ok: false, reason: 'not_found' } as const;
      }
      if (row.state === to) return { ok: true, duplicate: true, card: view(row) } as const;
      if (row.state === 'stale') return { ok: false, reason: 'stale' } as const;
      if (row.state !== 'open') return { ok: false, reason: 'closed' } as const;
      const at = this.now();
      this.db
        .prepare('UPDATE cards SET state = ?, decided_at = ? WHERE card_id = ?')
        .run(to, at, cardId);
      this.count(
        row.project_id,
        row.kind as CardKind,
        to === 'accepted' ? 'accepted' : 'dismissed',
      );
      return {
        ok: true,
        duplicate: false,
        card: view({ ...row, state: to, decided_at: at }),
      } as const;
    });
  }

  private insert(
    owner: string,
    projectId: string,
    card: NewCard,
    at: number,
    replaces: string | null,
  ): Card {
    const cardId = `card_${randomUUID().replaceAll('-', '')}`;
    this.db
      .prepare(
        `INSERT INTO cards (card_id, owner, project_id, kind, subject_key, title, detail, brief,
           estimate_micro, typical, precondition, external, state, day, replaces, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        cardId,
        owner,
        projectId,
        card.kind,
        card.subjectKey,
        card.title,
        card.detail,
        card.brief,
        toMicro(card.estimateUsd),
        card.typical ? 1 : 0,
        card.preconditionHash,
        card.external ? 1 : 0,
        dayOf(at),
        replaces,
        at,
      );
    return view(this.rowOf(owner, cardId) as CardRow);
  }

  private rowOf(owner: string, cardId: string): CardRow | undefined {
    return this.db
      .prepare('SELECT * FROM cards WHERE card_id = ? AND owner = ?')
      .get(cardId, owner) as unknown as CardRow | undefined;
  }

  private openCard(projectId: string, kind: CardKind, subjectKey: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM cards WHERE project_id = ? AND kind = ? AND subject_key = ? AND state = 'open'",
        )
        .get(projectId, kind, subjectKey) !== undefined
    );
  }

  private recentlyDecided(
    projectId: string,
    kind: CardKind,
    subjectKey: string,
    at: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM cards WHERE project_id = ? AND kind = ? AND subject_key = ? AND (
             (state IN ('dismissed', 'expired') AND decided_at > ?) OR
             (state = 'accepted' AND decided_at > ?))`,
        )
        .get(projectId, kind, subjectKey, at - SUPPRESS_AFTER_NO_MS, at - SUPPRESS_AFTER_YES_MS) !==
      undefined
    );
  }

  private newToday(projectId: string, at: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM cards WHERE project_id = ? AND day = ? AND replaces IS NULL',
      )
      .get(projectId, dayOf(at)) as { n: number };
    return row.n;
  }

  private lastNew(projectId: string, kind: CardKind): number | undefined {
    const row = this.db
      .prepare(
        'SELECT MAX(created_at) AS at FROM cards WHERE project_id = ? AND kind = ? AND replaces IS NULL',
      )
      .get(projectId, kind) as { at: number | null };
    return row.at ?? undefined;
  }

  private kindRow(projectId: string, kind: CardKind): KindRow | undefined {
    return this.db
      .prepare('SELECT * FROM card_kinds WHERE project_id = ? AND kind = ?')
      .get(projectId, kind) as unknown as KindRow | undefined;
  }

  private ensureKind(projectId: string, kind: CardKind): void {
    this.db
      .prepare('INSERT OR IGNORE INTO card_kinds (project_id, kind) VALUES (?, ?)')
      .run(projectId, kind);
  }

  /** Counts an answer for a kind; a "no" or an ignored card lengthens the run that backs the kind off. */
  private count(
    projectId: string,
    kind: CardKind,
    what: 'accepted' | 'dismissed' | 'ignored',
  ): void {
    this.ensureKind(projectId, kind);
    if (what === 'accepted') {
      this.db
        .prepare(
          "UPDATE card_kinds SET accepted = accepted + 1, streak = 0, offer = CASE WHEN offer IN ('due', 'offered') THEN 'none' ELSE offer END WHERE project_id = ? AND kind = ?",
        )
        .run(projectId, kind);
      return;
    }
    this.db
      .prepare(
        `UPDATE card_kinds SET ${what} = ${what} + 1, streak = streak + 1 WHERE project_id = ? AND kind = ?`,
      )
      .run(projectId, kind);
    // The offer is raised once per run of ignored cards: when the run reaches the limit.
    this.db
      .prepare(
        "UPDATE card_kinds SET offer = 'due' WHERE project_id = ? AND kind = ? AND streak >= ? AND offer = 'none' AND enabled = 1",
      )
      .run(projectId, kind, BACKOFF_AFTER_IGNORED);
  }
}

function view(row: CardRow): Card {
  const spec = KIND_SPECS[row.kind as CardKind];
  return {
    cardId: row.card_id,
    owner: row.owner,
    projectId: row.project_id,
    kind: row.kind as CardKind,
    subjectKey: row.subject_key,
    title: row.title,
    detail: row.detail,
    brief: row.brief,
    mode: spec.mode,
    authority: spec.authority,
    estimateUsd: fromMicro(row.estimate_micro),
    typical: row.typical === 1,
    preconditionHash: row.precondition,
    external: row.external === 1,
    state: row.state,
    replaces: row.replaces,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    conversationId: row.conversation_id,
    spentUsd: row.spent_micro === null ? null : fromMicro(row.spent_micro),
    outcome: row.outcome,
    settledAt: row.settled_at,
  };
}
