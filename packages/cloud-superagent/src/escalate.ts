import type { SuperagentStore } from './store.js';
import type { NormalizedEvent } from './types.js';

export const ESCALATE_DOCUMENT = 'escalate';
export const DEFAULT_LOW = 0.25;
export const DEFAULT_HIGH = 0.85;
export const DEFAULT_RISK_HUMAN = 0.8;

export const SCORE_BANDS = ['low', 'medium', 'high'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

export const CARD_OPTIONS = ['accept', 'archive', 'reject'] as const;
export type CardOption = (typeof CARD_OPTIONS)[number];

export interface Score {
  value: number;
  urgency: number;
  risk: number;
  reason: string;
}

export interface Thresholds {
  low: number;
  high: number;
  riskHuman: number;
}

export interface DecisionCard {
  cardId: string;
  tenantId: string;
  eventId: string;
  threadId: string;
  title: string;
  reason: string;
  band: 'high';
  score: Score;
  state: 'pending' | 'accepted' | 'archived' | 'rejected';
  at: number;
  resolvedAt?: number;
  resolution?: CardOption;
}

export interface EscalateFeedback {
  cardId: string;
  option: CardOption;
  score: Score;
  at: number;
}

export interface EscalateMetrics {
  scoreCalls: number;
  heuristicCalls: number;
  archived: number;
  assigned: number;
  escalated: number;
  tokens: number;
  usdMicros: number;
  byBand: Record<string, number>;
}

export interface EscalateState {
  enabled: boolean;
  thresholds: Thresholds;
  cards: DecisionCard[];
  feedback: EscalateFeedback[];
  metrics: EscalateMetrics;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  low: DEFAULT_LOW,
  high: DEFAULT_HIGH,
  riskHuman: DEFAULT_RISK_HUMAN,
};

const MAX_CARDS = 80;
const MAX_FEEDBACK = 80;
const WORK_RE = /\b(fix|implement|please|can you|ship|open a pr|investigate)\b/iu;
const URGENT_RE = /\b(urgent|asap|p0|prod|production|outage|down)\b/iu;
const RISK_RE = /\b(secret|secrets|credential|deploy|leak|rce|auth bypass)\b/iu;

export function emptyEscalateMetrics(): EscalateMetrics {
  return {
    scoreCalls: 0,
    heuristicCalls: 0,
    archived: 0,
    assigned: 0,
    escalated: 0,
    tokens: 0,
    usdMicros: 0,
    byBand: {},
  };
}

export function emptyEscalateState(): EscalateState {
  return {
    enabled: false,
    thresholds: { ...DEFAULT_THRESHOLDS },
    cards: [],
    feedback: [],
    metrics: emptyEscalateMetrics(),
  };
}

export function parseEscalateState(raw: string | undefined): EscalateState {
  if (!raw) return emptyEscalateState();
  try {
    const parsed = JSON.parse(raw) as Partial<EscalateState>;
    return {
      enabled: parsed.enabled === true,
      thresholds: {
        low: clamp01(parsed.thresholds?.low ?? DEFAULT_LOW),
        high: clamp01(parsed.thresholds?.high ?? DEFAULT_HIGH),
        riskHuman: clamp01(parsed.thresholds?.riskHuman ?? DEFAULT_RISK_HUMAN),
      },
      cards: Array.isArray(parsed.cards)
        ? parsed.cards.map((row) => ({ ...row, score: { ...row.score } }))
        : [],
      feedback: Array.isArray(parsed.feedback)
        ? parsed.feedback.map((row) => ({ ...row, score: { ...row.score } }))
        : [],
      metrics: {
        ...emptyEscalateMetrics(),
        ...parsed.metrics,
        byBand: parsed.metrics?.byBand ?? {},
      },
    };
  } catch {
    return emptyEscalateState();
  }
}

export function loadEscalate(store: SuperagentStore, tenantId: string): EscalateState {
  return parseEscalateState(store.getDocument(tenantId, ESCALATE_DOCUMENT));
}

export function saveEscalate(
  store: SuperagentStore,
  tenantId: string,
  state: EscalateState,
  at: number,
): void {
  store.putDocument(tenantId, ESCALATE_DOCUMENT, JSON.stringify(state), at);
}

export function compositeScore(score: Score): number {
  return (score.value + score.urgency + score.risk) / 3;
}

export function bandOf(score: Score, thresholds: Thresholds): ScoreBand {
  if (score.risk >= thresholds.riskHuman || compositeScore(score) >= thresholds.high) return 'high';
  if (compositeScore(score) < thresholds.low) return 'low';
  return 'medium';
}

export function heuristicScore(event: NormalizedEvent): Score {
  const text = [
    event.summary,
    field(event, 'text'),
    field(event, 'body'),
    field(event, 'comment'),
    field(event, 'title'),
  ].join('\n');
  let value = 0.45;
  let urgency = 0.35;
  let risk = 0.2;
  let reason = 'heuristic';
  if (event.type === 'ci_failed') {
    value = 0.7;
    urgency = 0.8;
    reason = 'ci_failed';
  }
  if (WORK_RE.test(text) || event.type === 'issue_opened' || event.type === 'pr_opened') {
    value = Math.max(value, 0.7);
    reason = 'work';
  }
  if (URGENT_RE.test(text)) {
    urgency = 0.92;
    reason = 'urgent';
  }
  if (RISK_RE.test(text)) {
    risk = 0.9;
    reason = 'risk';
  }
  if (event.source === 'timer' || event.type === 'ping') {
    value = 0.08;
    urgency = 0.08;
    risk = 0.05;
    reason = 'noise';
  }
  return { value, urgency, risk, reason };
}

export function parseScore(raw: string): Score | undefined {
  const json = extractJson(raw);
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as {
      value?: unknown;
      urgency?: unknown;
      risk?: unknown;
      reason?: unknown;
    };
    const value = asUnit(parsed.value);
    const urgency = asUnit(parsed.urgency);
    const risk = asUnit(parsed.risk);
    if (value === undefined || urgency === undefined || risk === undefined) return undefined;
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'model';
    return { value, urgency, risk, reason };
  } catch {
    return undefined;
  }
}

export function scorePrompt(event: NormalizedEvent): string {
  return [
    'Score this event for a Super-agent. JSON only.',
    '{"value":0.0,"urgency":0.0,"risk":0.0,"reason":"..."}',
    'Each field is 0..1. High risk or a needed human decision should set risk >= 0.8.',
    `type=${event.type} source=${event.source} subject=${event.subject?.key ?? ''} summary=${event.summary}`,
  ].join('\n');
}

export function recordBand(
  state: EscalateState,
  input: {
    band: ScoreBand;
    kind: 'archive' | 'assign' | 'escalate';
    scoreCalls: number;
    tokens?: number;
    usdMicros?: number;
  },
): EscalateState {
  const metrics = { ...state.metrics, byBand: { ...state.metrics.byBand } };
  metrics.byBand[input.band] = (metrics.byBand[input.band] ?? 0) + 1;
  if (input.scoreCalls > 0) {
    metrics.scoreCalls += input.scoreCalls;
    metrics.tokens += input.tokens ?? 0;
    metrics.usdMicros += input.usdMicros ?? 0;
  } else {
    metrics.heuristicCalls += 1;
  }
  if (input.kind === 'archive') metrics.archived += 1;
  if (input.kind === 'assign') metrics.assigned += 1;
  if (input.kind === 'escalate') metrics.escalated += 1;
  return { ...state, metrics };
}

export function addCard(state: EscalateState, card: DecisionCard): EscalateState {
  return { ...state, cards: [...state.cards, card].slice(-MAX_CARDS) };
}

export function resolveCard(
  state: EscalateState,
  cardId: string,
  option: CardOption,
  at: number,
): EscalateState {
  const card = state.cards.find((row) => row.cardId === cardId);
  if (!card || card.state !== 'pending') return state;
  const nextState =
    option === 'accept' ? 'accepted' : option === 'archive' ? 'archived' : 'rejected';
  const cards: DecisionCard[] = state.cards.map((row) =>
    row.cardId === cardId ? { ...row, state: nextState, resolvedAt: at, resolution: option } : row,
  );
  const feedback: EscalateFeedback = { cardId, option, score: card.score, at };
  return {
    ...state,
    cards,
    feedback: [...state.feedback, feedback].slice(-MAX_FEEDBACK),
  };
}

export function pendingCards(state: EscalateState): DecisionCard[] {
  return state.cards.filter((row) => row.state === 'pending');
}

export function patchEscalate(
  state: EscalateState,
  patch: Partial<Pick<EscalateState, 'enabled' | 'thresholds'>>,
): EscalateState {
  return {
    ...state,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.thresholds
      ? {
          thresholds: {
            low: clamp01(patch.thresholds.low),
            high: clamp01(patch.thresholds.high),
            riskHuman: clamp01(patch.thresholds.riskHuman),
          },
        }
      : {}),
  };
}

export function formatDecisionLine(card: DecisionCard): string {
  return `${card.cardId}  waiting on human: ${card.title}  ${card.reason}`;
}

function field(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

function asUnit(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return clamp01(n);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function extractJson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return undefined;
}
