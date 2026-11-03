import { admit } from './router.js';
import { pathOverlaps } from './scheduler.js';
import type { AdmissionPolicy, Mandate, NormalizedEvent, RouterDecision } from './types.js';

export const ROUTER_MODES = ['off', 'observe', 'auto'] as const;
export type RouterMode = (typeof ROUTER_MODES)[number];

export const CLASSIFICATIONS = ['explicit', 'inferred', 'not_accepted'] as const;
export type RouterClass = (typeof CLASSIFICATIONS)[number];

export const DEFAULT_ROUTER_MODE: RouterMode = 'observe';
export const DEFAULT_SENSITIVITY = 0.5;
export const ROUTER_DOCUMENT = 'router';
export const INTAKE_DOCUMENT = 'intake';
const MAX_DECISIONS = 50;
const MAX_FEEDBACK = 50;
const MAX_HANDLED = 400;
const MAX_SLOW_AT = 200;

const WORK_RE = /\b(fix|implement|please|can you|ship|open a pr|investigate)\b/iu;

export interface ModelRef {
  provider: 'anthropic' | 'openai' | 'gateway' | 'fake';
  model: string;
  baseUrl?: string;
  /** Name of the env var that holds the key. Never the secret. */
  apiKeyEnv?: string;
}

export interface RouterRule {
  id: string;
  effect: 'allow' | 'deny';
  repo?: string;
  label?: string;
  author?: string;
  path?: string;
  keyword?: string;
}

export interface RouterFeedback {
  id: string;
  at: number;
  decisionId: string;
  verdict: 'correct' | 'wrong';
  note?: string;
}

export interface RouterDecisionRecord {
  decisionId: string;
  at: number;
  eventId: string;
  class: RouterClass;
  action: 'ignore' | 'answer' | 'spawn' | 'would_accept';
  confidence: number;
  reason: string;
  mode: RouterMode;
  summary: string;
}

export interface TenantRouterConfig {
  tenantId: string;
  mode: RouterMode;
  sensitivity: number;
  rules: RouterRule[];
  models: { router?: ModelRef; worker?: ModelRef };
  decisions: RouterDecisionRecord[];
  feedback: RouterFeedback[];
}

export interface Classification {
  class: RouterClass;
  confidence: number;
  reason: string;
}

export function defaultTenantRouterConfig(tenantId: string): TenantRouterConfig {
  return {
    tenantId,
    mode: DEFAULT_ROUTER_MODE,
    sensitivity: DEFAULT_SENSITIVITY,
    rules: [],
    models: {},
    decisions: [],
    feedback: [],
  };
}

export function parseRouterConfig(raw: string | undefined, tenantId: string): TenantRouterConfig {
  const fallback = defaultTenantRouterConfig(tenantId);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<TenantRouterConfig>;
    return {
      tenantId,
      mode: ROUTER_MODES.includes(parsed.mode as RouterMode)
        ? (parsed.mode as RouterMode)
        : fallback.mode,
      sensitivity: clamp01(parsed.sensitivity ?? fallback.sensitivity),
      rules: Array.isArray(parsed.rules) ? parsed.rules.map((row) => ({ ...row })) : [],
      models: {
        ...(parsed.models?.router ? { router: { ...parsed.models.router } } : {}),
        ...(parsed.models?.worker ? { worker: { ...parsed.models.worker } } : {}),
      },
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map((row) => ({ ...row })) : [],
      feedback: Array.isArray(parsed.feedback) ? parsed.feedback.map((row) => ({ ...row })) : [],
    };
  } catch {
    return fallback;
  }
}

export function classifyDecision(event: NormalizedEvent, decision: RouterDecision): Classification {
  if (decision.action === 'ignore') {
    return {
      class: 'not_accepted',
      confidence: decision.confidence ?? 0.85,
      reason: decision.reason,
    };
  }
  if (decision.action === 'answer') {
    return { class: 'not_accepted', confidence: decision.confidence ?? 0.8, reason: 'answer' };
  }
  const text =
    field(event, 'text') || field(event, 'body') || field(event, 'comment') || event.summary;
  const explicitAsk =
    event.type === 'user_message' || event.source === 'chat' || WORK_RE.test(text);
  if (explicitAsk || decision.mandate.strength === 'explicit') {
    return {
      class: 'explicit',
      confidence: decision.confidence ?? 0.9,
      reason: 'explicit_request',
    };
  }
  return {
    class: 'inferred',
    confidence: decision.confidence ?? 0.65,
    reason: 'inferred_work',
  };
}

export function belowSensitivity(classified: Classification, sensitivity: number): boolean {
  return classified.class !== 'not_accepted' && classified.confidence < sensitivity;
}

export function ruleMatches(rule: RouterRule, event: NormalizedEvent): boolean {
  const repo = event.subject?.repo ?? '';
  const author = field(event, 'author') || event.actor.login;
  const labels = field(event, 'labels')
    .split(',')
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  const label = field(event, 'label');
  const path = field(event, 'file') || field(event, 'path');
  const text = [
    event.summary,
    field(event, 'text'),
    field(event, 'body'),
    field(event, 'comment'),
    field(event, 'title'),
    path,
  ].join('\n');
  if (rule.repo && !repoMatches(rule.repo, repo)) return false;
  if (rule.author && rule.author.toLowerCase() !== author.toLowerCase()) return false;
  if (rule.label) {
    const want = rule.label.toLowerCase();
    if (!labels.includes(want) && label.toLowerCase() !== want) return false;
  }
  if (rule.path && !pathOverlaps(rule.path, path) && !text.includes(rule.path)) return false;
  if (rule.keyword && !text.toLowerCase().includes(rule.keyword.toLowerCase())) return false;
  return true;
}

export function applyRouterRules(
  event: NormalizedEvent,
  rules: readonly RouterRule[],
): { ok: boolean; reason: string } {
  for (const rule of rules) {
    if (rule.effect === 'deny' && ruleMatches(rule, event)) {
      return { ok: false, reason: `rule_deny:${rule.id}` };
    }
  }
  const allows = rules.filter((rule) => rule.effect === 'allow');
  if (allows.length > 0 && !allows.some((rule) => ruleMatches(rule, event))) {
    return { ok: false, reason: 'rule_allow_miss' };
  }
  return { ok: true, reason: 'rules_ok' };
}

export function fewShotPrompt(config: TenantRouterConfig): string {
  const lines: string[] = [];
  for (const row of config.feedback.slice(-8)) {
    const decision = config.decisions.find((item) => item.decisionId === row.decisionId);
    if (!decision) continue;
    lines.push(
      `feedback ${row.verdict}: class=${decision.class} action=${decision.action} summary=${decision.summary} reason=${decision.reason}${row.note ? ` note=${row.note}` : ''}`,
    );
  }
  return lines.join('\n');
}

export function suggestedRuleLines(config: TenantRouterConfig): string {
  const lines: string[] = [];
  for (const row of config.feedback) {
    if (row.verdict !== 'wrong') continue;
    const decision = config.decisions.find((item) => item.decisionId === row.decisionId);
    if (!decision) continue;
    lines.push(`suggest deny for similar: ${decision.summary} (was ${decision.action})`);
  }
  return lines.slice(-6).join('\n');
}

export function recordDecision(
  config: TenantRouterConfig,
  row: RouterDecisionRecord,
): TenantRouterConfig {
  return {
    ...config,
    decisions: [...config.decisions, row].slice(-MAX_DECISIONS),
  };
}

export function recordFeedback(
  config: TenantRouterConfig,
  row: RouterFeedback,
): TenantRouterConfig {
  return {
    ...config,
    feedback: [...config.feedback, row].slice(-MAX_FEEDBACK),
  };
}

export function patchRouterConfig(
  config: TenantRouterConfig,
  patch: Partial<
    Pick<TenantRouterConfig, 'mode' | 'sensitivity' | 'rules'> & {
      models?: TenantRouterConfig['models'];
    }
  >,
): TenantRouterConfig {
  return {
    ...config,
    ...(patch.mode && ROUTER_MODES.includes(patch.mode) ? { mode: patch.mode } : {}),
    ...(patch.sensitivity !== undefined ? { sensitivity: clamp01(patch.sensitivity) } : {}),
    ...(patch.rules ? { rules: patch.rules.map((row) => ({ ...row })) } : {}),
    ...(patch.models ? { models: { ...config.models, ...patch.models } } : {}),
  };
}

export function parseRouterCommand(
  text: string,
):
  | { kind: 'feedback'; verdict: 'correct' | 'wrong'; decisionId: string; note?: string }
  | { kind: 'mode'; mode: RouterMode }
  | { kind: 'sensitivity'; value: number }
  | undefined {
  const line = text.trim().replace(/^\/?(?:router\s+)?/i, '');
  const feedback = /^(?:feedback|fb)\s+(correct|wrong|yes|no)\s+(\S+)(?:\s+(.+))?$/iu.exec(line);
  if (feedback) {
    const raw = (feedback[1] ?? '').toLowerCase();
    const verdict = raw === 'correct' || raw === 'yes' ? 'correct' : 'wrong';
    const note = feedback[3]?.trim();
    return {
      kind: 'feedback',
      verdict,
      decisionId: feedback[2] ?? '',
      ...(note ? { note } : {}),
    };
  }
  const mode = /^mode\s+(off|observe|auto)$/iu.exec(line);
  if (mode) return { kind: 'mode', mode: (mode[1] ?? 'observe').toLowerCase() as RouterMode };
  const sensitivity = /^sensitivity\s+(0(?:\.\d+)?|1(?:\.0+)?)$/u.exec(line);
  if (sensitivity) return { kind: 'sensitivity', value: Number(sensitivity[1]) };
  return undefined;
}

export function strengthFor(classified: Classification, mandate: Mandate): Mandate {
  if (classified.class === 'explicit' && mandate.strength !== 'explicit') {
    return { ...mandate, strength: 'explicit' };
  }
  return mandate;
}

function repoMatches(rule: string, repo: string): boolean {
  const want = rule.toLowerCase();
  const have = repo.toLowerCase();
  if (want === have) return true;
  if (want.endsWith('/*')) return have.startsWith(want.slice(0, -1));
  if (want.includes('*')) {
    const escaped = want.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(have);
  }
  return false;
}

function field(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SENSITIVITY;
  return Math.min(1, Math.max(0, value));
}

export type IntakeLayer = 'fast' | 'slow' | 'passthrough';

export interface IntakeMetrics {
  fastDropped: number;
  slowDropped: number;
  slowCalls: number;
  slowWouldAccept: number;
  passthrough: number;
  byReason: Record<string, number>;
}

export interface IntakeState {
  metrics: IntakeMetrics;
  handledIds: string[];
  slowAt: number[];
}

export function emptyIntakeMetrics(): IntakeMetrics {
  return {
    fastDropped: 0,
    slowDropped: 0,
    slowCalls: 0,
    slowWouldAccept: 0,
    passthrough: 0,
    byReason: {},
  };
}

export function emptyIntakeState(): IntakeState {
  return { metrics: emptyIntakeMetrics(), handledIds: [], slowAt: [] };
}

export function parseIntakeState(raw: string | undefined): IntakeState {
  if (!raw) return emptyIntakeState();
  try {
    const parsed = JSON.parse(raw) as Partial<IntakeState>;
    return {
      metrics: {
        ...emptyIntakeMetrics(),
        ...parsed.metrics,
        byReason: parsed.metrics?.byReason ?? {},
      },
      handledIds: Array.isArray(parsed.handledIds) ? parsed.handledIds : [],
      slowAt: Array.isArray(parsed.slowAt) ? parsed.slowAt : [],
    };
  } catch {
    return emptyIntakeState();
  }
}

export function bumpIntake(
  state: IntakeState,
  input: {
    layer: IntakeLayer;
    reason: string;
    kind: 'drop' | 'call' | 'passthrough' | 'would_accept' | 'accept';
  },
  ids: string[] = [],
  now = 0,
): IntakeState {
  const metrics = { ...state.metrics, byReason: { ...state.metrics.byReason } };
  const key = `${input.layer}:${input.reason}`;
  metrics.byReason[key] = (metrics.byReason[key] ?? 0) + 1;
  if (input.kind === 'drop' && input.layer === 'fast') metrics.fastDropped += 1;
  if (input.kind === 'drop' && input.layer === 'slow') metrics.slowDropped += 1;
  if (input.kind === 'call') metrics.slowCalls += 1;
  if (input.kind === 'would_accept') metrics.slowWouldAccept += 1;
  if (input.kind === 'passthrough') metrics.passthrough += 1;
  return {
    metrics,
    handledIds: uniqueTail([...state.handledIds, ...ids], MAX_HANDLED),
    slowAt: input.kind === 'call' ? [...state.slowAt, now].slice(-MAX_SLOW_AT) : state.slowAt,
  };
}

export function fastPathDrop(input: {
  event: NormalizedEvent;
  policy: AdmissionPolicy;
  meteringStop: boolean;
  rules: readonly RouterRule[];
  mode: RouterMode;
  handledIds: readonly string[];
  slowAt: readonly number[];
  maxUnownedPerMinute?: number;
  now: number;
}): { drop: true; reason: string } | { drop: false } {
  if (
    input.handledIds.includes(input.event.eventId) ||
    input.handledIds.includes(input.event.idempotencyKey)
  ) {
    return { drop: true, reason: 'already_handled' };
  }
  if (input.mode === 'off') return { drop: true, reason: 'router_off' };
  const admission = admit(input.event, input.policy, input.meteringStop);
  if (!admission.ok) return { drop: true, reason: admission.reason };
  const rules = applyRouterRules(input.event, input.rules);
  if (!rules.ok) return { drop: true, reason: rules.reason };
  if (input.maxUnownedPerMinute !== undefined) {
    const window = input.slowAt.filter((at) => input.now - at < 60_000).length;
    if (window >= input.maxUnownedPerMinute) return { drop: true, reason: 'rate_cap' };
  }
  return { drop: false };
}

function uniqueTail(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(-max);
}
