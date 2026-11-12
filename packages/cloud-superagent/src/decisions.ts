import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Actor, ActorKind, AuditRecord } from './types.js';

/**
 * Standing human decisions, scoped by tenant and repo. Agent inferences
 * never write. Newest exact match wins; fuzzy matches are hints only.
 */

export const DECISION_POLARITIES = ['decided', 'refused'] as const;
export type DecisionPolarity = (typeof DECISION_POLARITIES)[number];

export const DECISION_AUDIT_RECORDED = 'decision_recorded';
export const DECISION_AUDIT_REVOKED = 'decision_revoked';
export const DECISION_AUDIT_APPLIED = 'decision_applied';
export const RULE_MATCHED_AUDIT = 'rule_matched';

export interface DecisionScope {
  tenantId: string;
  repo?: string;
  category: string;
  object?: string;
  path?: string;
  tags?: string[];
}

export interface DecisionEntry {
  entryId: string;
  polarity: DecisionPolarity;
  /** Exact words the person used. */
  verbatim: string;
  at: number;
  sourceEventId: string;
  actor: { login: string; kind: 'user' };
  scope: DecisionScope;
  origin: 'human';
  supersededBy?: string;
  revokedAt?: number;
}

export interface MustAskPending {
  pendingId: string;
  tenantId: string;
  eventId: string;
  workerId?: string;
  approvalId?: string;
  category: string;
  boundText: string;
  repo?: string;
  object?: string;
  path?: string;
  tags?: string[];
  threadId?: string;
  ruleId?: string;
  at: number;
}

export interface RuleHit {
  hitId: string;
  tenantId: string;
  repo?: string;
  ruleId: string;
  eventId: string;
  at: number;
}

export type DecisionConsult =
  | { kind: 'exact'; entry: DecisionEntry }
  | { kind: 'fuzzy'; hints: DecisionEntry[] }
  | { kind: 'none' };

export interface DecisionSnapshot {
  entries: DecisionEntry[];
  pending: MustAskPending[];
  ruleHits: RuleHit[];
}

export interface DecisionIds {
  entry(): string;
  pending(): string;
  hit(): string;
}

export interface RecordDecisionInput {
  polarity: DecisionPolarity;
  verbatim: string;
  sourceEventId: string;
  actor: { login: string; kind: ActorKind };
  scope: DecisionScope;
  at: number;
}

export function defaultDecisionIds(): DecisionIds {
  const compact = (): string => randomUUID().replaceAll('-', '');
  return {
    entry: () => `dec_${compact()}`,
    pending: () => `msk_${compact()}`,
    hit: () => `hit_${compact()}`,
  };
}

export function sequentialDecisionIds(start = 0): DecisionIds {
  let n = start;
  const next = (prefix: string) => {
    n += 1;
    return `${prefix}_${String(n).padStart(4, '0')}`;
  };
  return {
    entry: () => next('dec'),
    pending: () => next('msk'),
    hit: () => next('hit'),
  };
}

export function cloneScope(scope: DecisionScope): DecisionScope {
  return {
    tenantId: scope.tenantId,
    ...(scope.repo ? { repo: scope.repo } : {}),
    category: scope.category,
    ...(scope.object ? { object: scope.object } : {}),
    ...(scope.path ? { path: scope.path } : {}),
    ...(scope.tags && scope.tags.length > 0 ? { tags: [...scope.tags] } : {}),
  };
}

function cloneEntryRow(entry: DecisionEntry): DecisionEntry {
  return {
    entryId: entry.entryId,
    polarity: entry.polarity,
    verbatim: entry.verbatim,
    at: entry.at,
    sourceEventId: entry.sourceEventId,
    actor: { login: entry.actor.login, kind: 'user' },
    scope: cloneScope(entry.scope),
    origin: 'human',
    ...(entry.supersededBy ? { supersededBy: entry.supersededBy } : {}),
    ...(entry.revokedAt !== undefined ? { revokedAt: entry.revokedAt } : {}),
  };
}

export function isActive(entry: DecisionEntry): boolean {
  return entry.revokedAt === undefined && entry.supersededBy === undefined;
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = left.replace(/\\/g, '/').replace(/^\.\//, '');
  const b = right.replace(/\\/g, '/').replace(/^\.\//, '');
  if (a === b) return true;
  const aPrefix = a.endsWith('/') ? a : `${a}/`;
  const bPrefix = b.endsWith('/') ? b : `${b}/`;
  return b.startsWith(aPrefix) || a.startsWith(bPrefix);
}

function tagsOverlap(left?: readonly string[], right?: readonly string[]): boolean {
  if (!left?.length || !right?.length) return false;
  const have = new Set(left.map(norm));
  return right.some((tag) => have.has(norm(tag)));
}

function sameRepo(entry: DecisionScope, query: DecisionScope): boolean {
  return (entry.repo ?? '') === (query.repo ?? '');
}

export function programmaticMatch(entry: DecisionEntry, query: DecisionScope): boolean {
  if (!isActive(entry)) return false;
  if (entry.scope.tenantId !== query.tenantId) return false;
  if (!sameRepo(entry.scope, query)) return false;
  if (entry.scope.category !== query.category) return false;
  const keyed = Boolean(
    entry.scope.object || entry.scope.path || (entry.scope.tags && entry.scope.tags.length > 0),
  );
  if (!keyed) return true;
  if (entry.scope.object && query.object && norm(entry.scope.object) === norm(query.object)) {
    return true;
  }
  if (entry.scope.path && query.path && pathsOverlap(entry.scope.path, query.path)) return true;
  if (tagsOverlap(entry.scope.tags, query.tags)) return true;
  return false;
}

export function fuzzyMatch(entry: DecisionEntry, query: DecisionScope): boolean {
  if (!isActive(entry)) return false;
  if (entry.scope.tenantId !== query.tenantId) return false;
  if (entry.scope.repo && query.repo && entry.scope.repo !== query.repo) return false;
  if (entry.scope.category !== query.category) return false;
  return !programmaticMatch(entry, query);
}

export function consultDecisions(
  entries: readonly DecisionEntry[],
  query: DecisionScope,
): DecisionConsult {
  const exact = entries.filter((row) => programmaticMatch(row, query)).sort((a, b) => b.at - a.at);
  const newest = exact[0];
  if (newest) return { kind: 'exact', entry: cloneEntryRow(newest) };
  const hints = entries
    .filter((row) => fuzzyMatch(row, query))
    .sort((a, b) => b.at - a.at)
    .map(cloneEntryRow);
  if (hints.length > 0) return { kind: 'fuzzy', hints };
  return { kind: 'none' };
}

export class DecisionBook {
  private readonly rows: DecisionEntry[] = [];
  private readonly pendingRows: MustAskPending[] = [];
  private readonly hits: RuleHit[] = [];
  private readonly ids: DecisionIds;
  private readonly persist?: (snap: DecisionSnapshot) => void;

  constructor(
    options: {
      ids?: DecisionIds;
      persist?: (snap: DecisionSnapshot) => void;
      snapshot?: DecisionSnapshot;
    } = {},
  ) {
    this.ids = options.ids ?? defaultDecisionIds();
    this.persist = options.persist;
    if (options.snapshot) this.hydrateSnapshot(options.snapshot);
  }

  static fromFile(path: string, ids?: DecisionIds): DecisionBook {
    return new DecisionBook({
      ids,
      snapshot: loadDecisionSnapshot(path),
      persist: (snap) => saveDecisionSnapshot(path, snap),
    });
  }

  snapshot(): DecisionSnapshot {
    return {
      entries: this.rows.map(cloneEntryRow),
      pending: this.pendingRows.map(clonePending),
      ruleHits: this.hits.map(cloneHit),
    };
  }

  list(tenantId: string, repo?: string): DecisionEntry[] {
    return this.rows
      .filter(
        (row) => row.scope.tenantId === tenantId && (repo === undefined || row.scope.repo === repo),
      )
      .map(cloneEntryRow)
      .sort((a, b) => b.at - a.at);
  }

  active(tenantId: string, repo?: string): DecisionEntry[] {
    return this.list(tenantId, repo).filter(isActive);
  }

  pending(tenantId: string): MustAskPending[] {
    return this.pendingRows.filter((row) => row.tenantId === tenantId).map(clonePending);
  }

  ruleHits(tenantId: string, repo?: string): RuleHit[] {
    return this.hits
      .filter((row) => row.tenantId === tenantId && (repo === undefined || row.repo === repo))
      .map(cloneHit);
  }

  consult(query: DecisionScope): DecisionConsult {
    return consultDecisions(
      this.rows.filter((row) => row.scope.tenantId === query.tenantId),
      query,
    );
  }

  record(
    input: RecordDecisionInput,
  ): { ok: true; entry: DecisionEntry } | { ok: false; reason: string } {
    if (input.actor.kind !== 'user') return { ok: false, reason: 'human_only' };
    const verbatim = input.verbatim.trim();
    if (!verbatim) return { ok: false, reason: 'empty_verbatim' };
    if (!input.sourceEventId.trim()) return { ok: false, reason: 'missing_source_event' };
    if (!input.scope.tenantId.trim() || !input.scope.category.trim()) {
      return { ok: false, reason: 'missing_scope' };
    }
    const entryId = this.ids.entry();
    const matches = this.rows.filter((row) => programmaticMatch(row, input.scope));
    for (const row of matches) {
      row.supersededBy = entryId;
    }
    const entry: DecisionEntry = {
      entryId,
      polarity: input.polarity,
      verbatim,
      at: input.at,
      sourceEventId: input.sourceEventId,
      actor: { login: input.actor.login, kind: 'user' },
      scope: cloneScope(input.scope),
      origin: 'human',
    };
    this.rows.push(entry);
    this.flush();
    return { ok: true, entry: cloneEntryRow(entry) };
  }

  revoke(
    tenantId: string,
    entryId: string,
    actor: { login: string; kind: ActorKind },
    at: number,
  ): { ok: true; entry: DecisionEntry } | { ok: false; reason: string } {
    if (actor.kind !== 'user') return { ok: false, reason: 'human_only' };
    const row = this.rows.find(
      (item) => item.entryId === entryId && item.scope.tenantId === tenantId,
    );
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.revokedAt !== undefined) return { ok: false, reason: 'already_revoked' };
    row.revokedAt = at;
    this.flush();
    return { ok: true, entry: cloneEntryRow(row) };
  }

  addPending(row: Omit<MustAskPending, 'pendingId'> & { pendingId?: string }): MustAskPending {
    const pending: MustAskPending = clonePending({
      ...row,
      pendingId: row.pendingId ?? this.ids.pending(),
    });
    this.pendingRows.push(pending);
    this.flush();
    return clonePending(pending);
  }

  removePending(tenantId: string, pendingId: string): MustAskPending | undefined {
    const index = this.pendingRows.findIndex(
      (row) => row.tenantId === tenantId && row.pendingId === pendingId,
    );
    if (index < 0) return undefined;
    const [removed] = this.pendingRows.splice(index, 1);
    this.flush();
    return removed ? clonePending(removed) : undefined;
  }

  recordRuleHit(input: Omit<RuleHit, 'hitId'> & { hitId?: string }): RuleHit {
    const hit: RuleHit = {
      hitId: input.hitId ?? this.ids.hit(),
      tenantId: input.tenantId,
      ...(input.repo ? { repo: input.repo } : {}),
      ruleId: input.ruleId,
      eventId: input.eventId,
      at: input.at,
    };
    this.hits.push(hit);
    this.flush();
    return cloneHit(hit);
  }

  hydrateFromAudit(rows: readonly AuditRecord[]): void {
    const known = new Set(this.rows.map((row) => row.entryId));
    for (const row of rows) {
      if (row.kind === DECISION_AUDIT_RECORDED) {
        const entry = entryFromAudit(row);
        if (!entry || known.has(entry.entryId)) continue;
        this.rows.push(entry);
        known.add(entry.entryId);
      }
    }
    for (const row of rows) {
      if (row.kind !== DECISION_AUDIT_REVOKED) continue;
      const entryId = typeof row.detail.entryId === 'string' ? row.detail.entryId : '';
      const at = typeof row.detail.at === 'number' ? row.detail.at : row.at;
      const found = this.rows.find(
        (item) => item.entryId === entryId && item.scope.tenantId === row.tenantId,
      );
      if (found && found.revokedAt === undefined) found.revokedAt = at;
    }
    for (const row of rows) {
      if (row.kind !== RULE_MATCHED_AUDIT) continue;
      const ruleId = typeof row.detail.ruleId === 'string' ? row.detail.ruleId : '';
      const eventId = typeof row.detail.eventId === 'string' ? row.detail.eventId : '';
      const hitId = typeof row.detail.hitId === 'string' ? row.detail.hitId : '';
      if (!ruleId || !eventId) continue;
      if (hitId && this.hits.some((item) => item.hitId === hitId)) continue;
      this.hits.push({
        hitId: hitId || `hit_audit_${row.auditId}`,
        tenantId: row.tenantId,
        ...(typeof row.detail.repo === 'string' && row.detail.repo
          ? { repo: row.detail.repo }
          : {}),
        ruleId,
        eventId,
        at: row.at,
      });
    }
  }

  hydrateSnapshot(snapshot: DecisionSnapshot): void {
    const known = new Set(this.rows.map((row) => row.entryId));
    for (const row of snapshot.entries) {
      if (known.has(row.entryId)) continue;
      this.rows.push(cloneEntryRow(row));
      known.add(row.entryId);
    }
    const pendingKnown = new Set(this.pendingRows.map((row) => row.pendingId));
    for (const row of snapshot.pending) {
      if (pendingKnown.has(row.pendingId)) continue;
      this.pendingRows.push(clonePending(row));
    }
    const hitKnown = new Set(this.hits.map((row) => row.hitId));
    for (const row of snapshot.ruleHits) {
      if (hitKnown.has(row.hitId)) continue;
      this.hits.push(cloneHit(row));
    }
  }

  persistTo(path: string): void {
    saveDecisionSnapshot(path, this.snapshot());
  }

  private flush(): void {
    this.persist?.(this.snapshot());
  }
}

export function entryFromAudit(row: AuditRecord): DecisionEntry | undefined {
  if (row.kind !== DECISION_AUDIT_RECORDED) return undefined;
  const raw = row.detail.entry;
  if (typeof raw !== 'string') return undefined;
  try {
    return parseEntry(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function parseEntry(raw: unknown): DecisionEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Partial<DecisionEntry>;
  if (typeof row.entryId !== 'string' || !row.entryId) return undefined;
  if (row.polarity !== 'decided' && row.polarity !== 'refused') return undefined;
  if (typeof row.verbatim !== 'string' || typeof row.at !== 'number') return undefined;
  if (typeof row.sourceEventId !== 'string' || row.origin !== 'human') return undefined;
  if (!row.actor || row.actor.kind !== 'user' || typeof row.actor.login !== 'string') {
    return undefined;
  }
  if (
    !row.scope ||
    typeof row.scope.tenantId !== 'string' ||
    typeof row.scope.category !== 'string'
  ) {
    return undefined;
  }
  return cloneEntryRow({
    entryId: row.entryId,
    polarity: row.polarity,
    verbatim: row.verbatim,
    at: row.at,
    sourceEventId: row.sourceEventId,
    actor: { login: row.actor.login, kind: 'user' },
    scope: cloneScope(row.scope),
    origin: 'human',
    ...(typeof row.supersededBy === 'string' ? { supersededBy: row.supersededBy } : {}),
    ...(typeof row.revokedAt === 'number' ? { revokedAt: row.revokedAt } : {}),
  });
}

/** #477 DecisionCard-shaped draft. Field names match `escalate.ts` on that branch. */
export interface DecisionCardDraft {
  tenantId: string;
  eventId: string;
  threadId: string;
  title: string;
  reason: string;
  band: 'high';
  score: { value: number; urgency: number; risk: number; reason: string };
}

export type CardOption = 'accept' | 'archive' | 'reject';

export interface CardResolutionInput {
  card: {
    cardId: string;
    tenantId: string;
    eventId: string;
    title: string;
    reason: string;
    threadId?: string;
  };
  option: CardOption;
  actor: Actor;
  verbatim: string;
  at: number;
  repo?: string;
  category?: string;
  object?: string;
  path?: string;
  tags?: string[];
}

/**
 * Wire point for #477 `resolveDecisionCard`.
 * accept → decided, reject → refused, archive → no standing row.
 */
export function recordFromCardResolution(
  book: DecisionBook,
  input: CardResolutionInput,
): { ok: true; entry: DecisionEntry } | { ok: false; reason: string } {
  if (input.option === 'archive') return { ok: false, reason: 'archive_not_standing' };
  return book.record({
    polarity: input.option === 'accept' ? 'decided' : 'refused',
    verbatim: input.verbatim || input.card.title,
    sourceEventId: input.card.eventId,
    actor: input.actor,
    scope: {
      tenantId: input.card.tenantId,
      ...(input.repo ? { repo: input.repo } : {}),
      category: input.category ?? 'card',
      object: input.object ?? input.card.threadId,
      ...(input.path ? { path: input.path } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    },
    at: input.at,
  });
}

export function loadDecisionSnapshot(path: string): DecisionSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DecisionSnapshot>;
    return {
      entries: Array.isArray(parsed.entries)
        ? parsed.entries.map(parseEntry).filter((row): row is DecisionEntry => row !== undefined)
        : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending.map(clonePending) : [],
      ruleHits: Array.isArray(parsed.ruleHits) ? parsed.ruleHits.map(cloneHit) : [],
    };
  } catch {
    return { entries: [], pending: [], ruleHits: [] };
  }
}

export function saveDecisionSnapshot(path: string, snap: DecisionSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);
}

function clonePending(row: MustAskPending): MustAskPending {
  return {
    pendingId: row.pendingId,
    tenantId: row.tenantId,
    eventId: row.eventId,
    ...(row.workerId ? { workerId: row.workerId } : {}),
    ...(row.approvalId ? { approvalId: row.approvalId } : {}),
    category: row.category,
    boundText: row.boundText,
    ...(row.repo ? { repo: row.repo } : {}),
    ...(row.object ? { object: row.object } : {}),
    ...(row.path ? { path: row.path } : {}),
    ...(row.tags && row.tags.length > 0 ? { tags: [...row.tags] } : {}),
    ...(row.threadId ? { threadId: row.threadId } : {}),
    ...(row.ruleId ? { ruleId: row.ruleId } : {}),
    at: row.at,
  };
}

function cloneHit(row: RuleHit): RuleHit {
  return {
    hitId: row.hitId,
    tenantId: row.tenantId,
    ...(row.repo ? { repo: row.repo } : {}),
    ruleId: row.ruleId,
    eventId: row.eventId,
    at: row.at,
  };
}
