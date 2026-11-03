import { scrubSecretText } from '@maka-cloud/orchestrator';
import { INLINE_MEMORY_CHARS } from './spill.js';
import type { NormalizedEvent, WorkerRecord } from './types.js';

/** Audit kinds written for the mistake book. Never a sqlite schema change. */
export const LESSON_AUDIT_KINDS = [
  'lesson_recorded',
  'lesson_proposed',
  'lesson_accepted',
  'lesson_rejected',
] as const;
export type LessonAuditKind = (typeof LESSON_AUDIT_KINDS)[number];

export const LESSON_CAUSES = [
  'review_changes',
  'review_rejected',
  'ci_failed_then_fixed',
  'approval_denied',
  'watchdog_correct',
  'peer_review',
] as const;
export type LessonCause = (typeof LESSON_CAUSES)[number];

export const LESSON_STATUSES = ['recorded', 'accepted', 'rejected'] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export const PROPOSAL_TARGETS = ['skill', 'system_prompt', 'permission'] as const;
export type ProposalTarget = (typeof PROPOSAL_TARGETS)[number];

export const PROPOSAL_STATUSES = ['proposed', 'accepted', 'rejected'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const WATCHDOG_CORRECT_ACTIONS = ['nudge', 'escalate', 'restart', 'stop'] as const;

/** Stable prompt header. New accepted lessons only append after this block. */
export const LESSON_PREFIX_HEADER = '## lessons\n';

export interface LessonRecord {
  lessonId: string;
  tenantId: string;
  triggerEventId: string;
  cause: LessonCause;
  mistake: string;
  correct: string;
  scope: string;
  summary: string;
  status: LessonStatus;
  workerId: string | null;
  at: number;
}

export interface SkillProposal {
  proposalId: string;
  tenantId: string;
  lessonIds: string[];
  target: ProposalTarget;
  path: string;
  diff: string;
  status: ProposalStatus;
  at: number;
}

export interface LearningSettings {
  enabled: boolean;
  /** Host may override; default is orchestrator `scrubSecretText`. */
  scrub: (text: string) => string;
  /** Max chars of the spawn-time lesson prefix kept inline. */
  injectBudget: number;
  /** Distill after this many new recorded lessons. Default 5. Host may also call `distillLessons`. */
  distillAfter: number;
}

export interface LessonDraft {
  tenantId: string;
  triggerEventId: string;
  cause: LessonCause;
  mistake: string;
  correct: string;
  scope: string;
  workerId?: string | null;
  at: number;
}

export interface DistillResult {
  document: string;
  proposals: SkillProposal[];
  groups: number;
}

/**
 * Host-facing constructor helper. Does not read `process.env`.
 * `enabled` is true only when the host passes `true`.
 */
export function learningSettingsFrom(
  input: {
    enabled?: boolean;
    scrub?: (text: string) => string;
    injectBudget?: number;
    distillAfter?: number;
  } = {},
): LearningSettings {
  return {
    enabled: input.enabled === true,
    scrub: input.scrub ?? scrubSecretText,
    injectBudget: input.injectBudget ?? INLINE_MEMORY_CHARS,
    distillAfter: input.distillAfter ?? 5,
  };
}

export const DEFAULT_LEARNING: LearningSettings = learningSettingsFrom();

export function fieldOf(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

export function reviewBounceOf(event: NormalizedEvent): LessonCause | undefined {
  if (event.type !== 'review_comment') return undefined;
  const state = fieldOf(event, 'state').toLowerCase();
  if (state === 'changes_requested') return 'review_changes';
  if (state === 'rejected' || state === 'dismissed') return 'review_rejected';
  return undefined;
}

export function isWatchdogCorrectAction(action: string): boolean {
  return (WATCHDOG_CORRECT_ACTIONS as readonly string[]).includes(action);
}

export function lessonSummary(row: Pick<LessonRecord, 'mistake' | 'correct'>): string {
  const text = `${row.mistake} → ${row.correct}`.replace(/\s+/g, ' ').trim();
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

export function formatLessonPrefix(
  lessons: readonly LessonRecord[],
  budget: number,
): { prefix: string; refsOnly: boolean } {
  if (lessons.length === 0) return { prefix: '', refsOnly: false };
  const detailed =
    LESSON_PREFIX_HEADER + lessons.map((row) => `- [${row.lessonId}] ${row.summary}\n`).join('');
  if (detailed.length <= budget) return { prefix: detailed, refsOnly: false };
  const compact = LESSON_PREFIX_HEADER + lessons.map((row) => `- [${row.lessonId}]\n`).join('');
  return { prefix: compact, refsOnly: true };
}

/** Drop a leading lesson prefix so handler memory never rewrites it. */
export function stripLessonPrefix(prefix: string | undefined, memory: string): string {
  if (!prefix) return memory;
  if (memory.startsWith(prefix)) return memory.slice(prefix.length);
  return memory;
}

export function recallWithLessons(
  worker: Pick<WorkerRecord, 'memory' | 'spills' | 'lessonPrefix'>,
  recallBody: (worker: Pick<WorkerRecord, 'memory' | 'spills'>) => string,
): string {
  return `${worker.lessonPrefix ?? ''}${recallBody(worker)}`;
}

export function normalizeLessonKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function formatLessonsDocument(
  repo: string,
  groups: ReadonlyArray<{ cause: LessonCause; scope: string; rows: readonly LessonRecord[] }>,
): string {
  const lines = [`# Lessons — ${repo || 'tenant'}`, ''];
  for (const group of groups) {
    const sample = group.rows[0];
    if (!sample) continue;
    lines.push(`## ${group.cause}`);
    lines.push(`- Scope: ${group.scope}`);
    lines.push(`- Triggers: ${group.rows.map((row) => row.triggerEventId).join(', ')}`);
    lines.push(`- Mistake: ${sample.mistake}`);
    lines.push(`- Do instead: ${sample.correct}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function proposalPath(target: ProposalTarget, scope: string): string {
  const repo = scope || 'tenant';
  if (target === 'system_prompt') return `prompts/${repo}.md`;
  if (target === 'permission') return `permissions/${repo}.md`;
  return `skills/${repo}.md`;
}

export function formatProposalDiff(target: ProposalTarget, scope: string, body: string): string {
  const path = proposalPath(target, scope);
  const added = body
    .split('\n')
    .map((line) => (line.length === 0 ? '+' : `+${line}`))
    .join('\n');
  return `--- /dev/null\n+++ b/${path}\n@@\n${added}\n`;
}

/**
 * Forbidden. Suggestions stay reviewable drafts. Host / humans apply them.
 */
export function applySkillProposal(_proposal: SkillProposal): {
  ok: false;
  reason: 'never_auto_apply';
} {
  return { ok: false, reason: 'never_auto_apply' };
}

export interface AuditLike {
  kind: string;
  tenantId: string;
  workerId: string | null;
  at: number;
  detail: Record<string, string | number | boolean | null>;
}

/**
 * In-memory mistake book. Persistence is the existing audit log (no schema bump).
 * Reconstruct with `loadFromAudit`.
 */
export class LessonBook {
  private n = 0;
  private readonly rows = new Map<string, LessonRecord>();
  private readonly props = new Map<string, SkillProposal>();
  private readonly documents = new Map<string, string>();
  private readonly seenTenants = new Set<string>();

  private key(tenantId: string, lessonId: string): string {
    return `${tenantId}:${lessonId}`;
  }

  private nextId(prefix: string): string {
    this.n += 1;
    return `${prefix}_${String(this.n).padStart(4, '0')}`;
  }

  hydrated(tenantId: string): boolean {
    return this.seenTenants.has(tenantId);
  }

  markHydrated(tenantId: string): void {
    this.seenTenants.add(tenantId);
  }

  loadFromAudit(rows: readonly AuditLike[]): void {
    for (const row of rows) {
      if (row.kind === 'lesson_recorded') {
        const lesson = lessonFromAudit(row);
        if (!lesson) continue;
        this.rows.set(this.key(lesson.tenantId, lesson.lessonId), lesson);
        this.bump(lesson.lessonId);
        this.seenTenants.add(lesson.tenantId);
      } else if (row.kind === 'lesson_accepted' || row.kind === 'lesson_rejected') {
        const lessonId = str(row.detail.lessonId);
        const proposalId = str(row.detail.proposalId);
        if (lessonId) {
          const lesson = this.rows.get(this.key(row.tenantId, lessonId));
          if (lesson) {
            lesson.status = row.kind === 'lesson_accepted' ? 'accepted' : 'rejected';
          }
        }
        if (proposalId) {
          const proposal = this.props.get(this.key(row.tenantId, proposalId));
          if (proposal) {
            proposal.status = row.kind === 'lesson_accepted' ? 'accepted' : 'rejected';
          }
        }
        this.seenTenants.add(row.tenantId);
      } else if (row.kind === 'lesson_proposed') {
        const proposal = proposalFromAudit(row);
        if (!proposal) continue;
        this.props.set(this.key(proposal.tenantId, proposal.proposalId), proposal);
        this.bump(proposal.proposalId);
        const document = str(row.detail.document);
        const scope = str(row.detail.scope) || 'tenant';
        if (document) this.documents.set(`${row.tenantId}:${scope}`, document);
        this.seenTenants.add(row.tenantId);
      }
    }
  }

  record(draft: LessonDraft, scrub: (text: string) => string): LessonRecord {
    const existing = this.byTrigger(draft.tenantId, draft.triggerEventId);
    if (existing) return existing;
    const lessonId = this.nextId('les');
    const row: LessonRecord = {
      lessonId,
      tenantId: draft.tenantId,
      triggerEventId: draft.triggerEventId,
      cause: draft.cause,
      mistake: scrub(draft.mistake).slice(0, 4000),
      correct: scrub(draft.correct).slice(0, 4000),
      scope: scrub(draft.scope).slice(0, 400),
      summary: '',
      status: 'recorded',
      workerId: draft.workerId ?? null,
      at: draft.at,
    };
    row.summary = lessonSummary(row);
    this.rows.set(this.key(row.tenantId, row.lessonId), row);
    this.seenTenants.add(row.tenantId);
    return row;
  }

  byTrigger(tenantId: string, triggerEventId: string): LessonRecord | undefined {
    return this.list(tenantId).find((row) => row.triggerEventId === triggerEventId);
  }

  get(tenantId: string, lessonId: string): LessonRecord | undefined {
    const row = this.rows.get(this.key(tenantId, lessonId));
    return row ? { ...row } : undefined;
  }

  list(tenantId: string): LessonRecord[] {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => a.at - b.at || a.lessonId.localeCompare(b.lessonId))
      .map((row) => ({ ...row }));
  }

  acceptedFor(tenantId: string, repo?: string): LessonRecord[] {
    return this.list(tenantId).filter((row) => {
      if (row.status !== 'accepted') return false;
      if (!repo) return true;
      return row.scope === repo || row.scope === 'tenant' || row.scope === '';
    });
  }

  recordedCount(tenantId: string): number {
    return this.list(tenantId).filter((row) => row.status === 'recorded').length;
  }

  setStatus(tenantId: string, lessonId: string, status: LessonStatus): LessonRecord | undefined {
    const row = this.rows.get(this.key(tenantId, lessonId));
    if (!row) return undefined;
    row.status = status;
    return { ...row };
  }

  recall(tenantId: string, lessonId: string): string | undefined {
    const row = this.rows.get(this.key(tenantId, lessonId));
    if (!row) return undefined;
    return [`lesson:${row.lessonId}`, row.mistake, row.correct, `scope:${row.scope}`].join('\n');
  }

  distill(tenantId: string, repo: string, at: number): DistillResult {
    const rows = this.list(tenantId).filter(
      (row) =>
        (row.status === 'recorded' || row.status === 'accepted') &&
        (repo === '' || row.scope === repo || row.scope === 'tenant' || row.scope === ''),
    );
    const grouped = new Map<string, LessonRecord[]>();
    for (const row of rows) {
      const key = `${row.scope}|${row.cause}|${normalizeLessonKey(row.mistake)}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }
    const groups = [...grouped.values()].map((list) => ({
      cause: list[0].cause,
      scope: list[0].scope,
      rows: list,
    }));
    const document = formatLessonsDocument(repo || 'tenant', groups);
    this.documents.set(`${tenantId}:${repo || 'tenant'}`, document);
    const proposals: SkillProposal[] = [];
    for (const group of groups) {
      const sample = group.rows[0];
      if (!sample) continue;
      const body = [
        `When ${sample.cause.replaceAll('_', ' ')}:`,
        `- Do not: ${sample.mistake}`,
        `- Do: ${sample.correct}`,
      ].join('\n');
      const proposal: SkillProposal = {
        proposalId: this.nextId('prop'),
        tenantId,
        lessonIds: group.rows.map((row) => row.lessonId),
        target: 'skill',
        path: proposalPath('skill', group.scope),
        diff: formatProposalDiff('skill', group.scope, body),
        status: 'proposed',
        at,
      };
      this.props.set(this.key(tenantId, proposal.proposalId), proposal);
      proposals.push({ ...proposal, lessonIds: [...proposal.lessonIds] });
    }
    this.seenTenants.add(tenantId);
    return { document, proposals, groups: groups.length };
  }

  proposals(tenantId: string): SkillProposal[] {
    return [...this.props.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => a.at - b.at || a.proposalId.localeCompare(b.proposalId))
      .map((row) => ({ ...row, lessonIds: [...row.lessonIds] }));
  }

  proposal(tenantId: string, proposalId: string): SkillProposal | undefined {
    const row = this.props.get(this.key(tenantId, proposalId));
    return row ? { ...row, lessonIds: [...row.lessonIds] } : undefined;
  }

  setProposalStatus(
    tenantId: string,
    proposalId: string,
    status: ProposalStatus,
  ): SkillProposal | undefined {
    const row = this.props.get(this.key(tenantId, proposalId));
    if (!row) return undefined;
    row.status = status;
    return { ...row, lessonIds: [...row.lessonIds] };
  }

  document(tenantId: string, repo = 'tenant'): string {
    return this.documents.get(`${tenantId}:${repo}`) ?? '';
  }

  private bump(id: string): void {
    const match = /_(\d+)$/.exec(id);
    if (!match) return;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > this.n) this.n = n;
  }
}

export function lessonAuditDetail(
  row: LessonRecord,
): Record<string, string | number | boolean | null> {
  return {
    lessonId: row.lessonId,
    triggerEventId: row.triggerEventId,
    cause: row.cause,
    mistake: row.mistake,
    correct: row.correct,
    scope: row.scope,
    summary: row.summary,
    status: row.status,
  };
}

export function proposalAuditDetail(
  row: SkillProposal,
  extras: { document?: string; scope?: string } = {},
): Record<string, string | number | boolean | null> {
  return {
    proposalId: row.proposalId,
    lessonIds: row.lessonIds.join(','),
    target: row.target,
    path: row.path,
    diff: row.diff.slice(0, 8000),
    status: row.status,
    document: extras.document?.slice(0, 8000) ?? null,
    scope: extras.scope ?? null,
  };
}

function str(value: string | number | boolean | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function lessonFromAudit(row: AuditLike): LessonRecord | undefined {
  const lessonId = str(row.detail.lessonId);
  const triggerEventId = str(row.detail.triggerEventId);
  const cause = str(row.detail.cause);
  if (!lessonId || !triggerEventId || !isLessonCause(cause)) return undefined;
  const mistake = str(row.detail.mistake);
  const correct = str(row.detail.correct);
  return {
    lessonId,
    tenantId: row.tenantId,
    triggerEventId,
    cause,
    mistake,
    correct,
    scope: str(row.detail.scope),
    summary: str(row.detail.summary) || lessonSummary({ mistake, correct }),
    status: lessonStatusOf(str(row.detail.status)),
    workerId: row.workerId,
    at: row.at,
  };
}

function proposalFromAudit(row: AuditLike): SkillProposal | undefined {
  const proposalId = str(row.detail.proposalId);
  const target = str(row.detail.target);
  if (!proposalId || !isProposalTarget(target)) return undefined;
  const status = str(row.detail.status);
  return {
    proposalId,
    tenantId: row.tenantId,
    lessonIds: str(row.detail.lessonIds)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    target,
    path: str(row.detail.path),
    diff: str(row.detail.diff),
    status: isProposalStatus(status) ? status : 'proposed',
    at: row.at,
  };
}

function isLessonCause(value: string): value is LessonCause {
  return (LESSON_CAUSES as readonly string[]).includes(value);
}

function isLessonStatus(value: string): value is LessonStatus {
  return (LESSON_STATUSES as readonly string[]).includes(value);
}

function lessonStatusOf(value: string): LessonStatus {
  return isLessonStatus(value) ? value : 'recorded';
}

function isProposalTarget(value: string): value is ProposalTarget {
  return (PROPOSAL_TARGETS as readonly string[]).includes(value);
}

function isProposalStatus(value: string): value is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(value);
}
