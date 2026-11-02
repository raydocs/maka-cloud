import { z } from 'zod';
import { inspectNotes, type RouterInspect } from './router-inspect.js';
import { actMandate, observeMandate } from './types.js';
import type {
  AdmissionPolicy,
  EventSource,
  JudgeLogEntry,
  NormalizedEvent,
  RouterDecision,
  RouterJudge,
  WorkerRecord,
} from './types.js';

export interface AdmissionResult {
  ok: boolean;
  reason: string;
}

const STATUS_RE = /\b(status|what'?s happening|where are we|any update)\b/iu;
const WORK_RE = /\b(fix|implement|please|can you|ship|open a pr|investigate)\b/iu;

export function admit(
  event: NormalizedEvent,
  policy: AdmissionPolicy,
  meteringStop: boolean,
): AdmissionResult {
  if (event.type === 'ping') return { ok: false, reason: 'ping' };
  if (event.subject === null) return { ok: false, reason: 'no_subject' };
  if (event.subject.kind === 'check') return { ok: false, reason: 'unowned_check' };
  if (policy.allowSources && !policy.allowSources.includes(event.source as EventSource)) {
    return { ok: false, reason: 'source_denied' };
  }
  if (meteringStop) return { ok: false, reason: 'tenant_paused' };
  if (event.subject.closed) return { ok: false, reason: 'subject_closed' };
  if (event.type === 'ci_failed' || event.type === 'ci_passed') {
    return { ok: false, reason: 'unowned_ci' };
  }
  if (event.source === 'timer') return { ok: false, reason: 'unowned_timer' };
  const denyBots = policy.denyUnownedBots !== false;
  if (denyBots && event.actor.kind === 'bot') return { ok: false, reason: 'bot' };
  const self = (policy.selfLogins ?? []).map((login) => login.toLowerCase());
  if (self.includes(event.actor.login.toLowerCase())) return { ok: false, reason: 'self' };
  if (policy.allowActors) {
    const allow = policy.allowActors.map((login) => login.toLowerCase());
    if (!allow.includes(event.actor.login.toLowerCase())) {
      return { ok: false, reason: 'actor_denied' };
    }
  }
  return { ok: true, reason: 'admitted' };
}

/** Spawn-time cap: concurrent Instabox boxes and tenant spend. */
export function admitSpawn(input: {
  boxedLive: number;
  wouldBox: boolean;
  tenantUsdMicros: number;
  policy: Pick<AdmissionPolicy, 'maxBoxes' | 'spendCapUsd'>;
}): AdmissionResult {
  if (input.policy.spendCapUsd !== undefined) {
    const cap = Math.round(input.policy.spendCapUsd * 1_000_000);
    if (input.tenantUsdMicros >= cap) return { ok: false, reason: 'spend_cap' };
  }
  if (
    input.wouldBox &&
    input.policy.maxBoxes !== undefined &&
    input.boxedLive >= input.policy.maxBoxes
  ) {
    return { ok: false, reason: 'box_cap' };
  }
  return { ok: true, reason: 'admitted' };
}

export class HeuristicJudge implements RouterJudge {
  async decide(
    event: NormalizedEvent,
    _ctx?: { workers: WorkerRecord[] },
  ): Promise<RouterDecision> {
    if (event.type === 'user_message') {
      const text = field(event, 'text');
      if (STATUS_RE.test(text) && !WORK_RE.test(text)) {
        return { action: 'answer', text: 'No worker is on this thread yet.' };
      }
      if (WORK_RE.test(text) || text.trim().length > 0) {
        return spawn(event, 'Chat work');
      }
      return { action: 'ignore', reason: 'empty_message' };
    }
    if (event.type === 'issue_opened' || event.type === 'pr_opened') {
      return spawn(event, event.type === 'issue_opened' ? 'Opened issue' : 'Opened pull request');
    }
    return { action: 'ignore', reason: 'no_work' };
  }
}

function spawn(event: NormalizedEvent, title: string): RouterDecision {
  const repos = event.subject?.repo ? [event.subject.repo] : [];
  return { action: 'spawn', mandate: observeMandate(repos, 'inferred'), title };
}

function field(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

export class RecordingJudge implements RouterJudge {
  readonly calls: NormalizedEvent[] = [];
  constructor(public inner: RouterJudge = new HeuristicJudge()) {}
  async decide(event: NormalizedEvent, ctx: { workers: WorkerRecord[] }): Promise<RouterDecision> {
    this.calls.push(event);
    return this.inner.decide(event, ctx);
  }
}

export interface ModelCompletion {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    tokens: number;
    usdMicros: number;
    wallMs: number;
    model: string;
  };
}

/** Injectable cheap Router model. Tests pass a fake client; no API keys live here. */
export interface JudgeClient {
  complete(prompt: string): Promise<string>;
  completeDetailed?(prompt: string): Promise<ModelCompletion>;
}

const ModelDecision = z.object({
  action: z.enum(['ignore', 'answer', 'spawn']),
  reason: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  intensity: z.enum(['observe', 'act']).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export interface ModelJudgeOptions {
  /** Heuristic ignore/empty skips the model (saves a wasted Router wakeup). */
  prefilter?: boolean;
  inspect?: RouterInspect;
  now?: () => number;
}

/**
 * Optional Router judge. Heuristic is the constructor default on Superagent.
 * `createJudgeFromEnv` uses this with `prefilter` when a key is present.
 * A missing client throws. A bad or failed completion falls back.
 */
export class ModelJudge implements RouterJudge {
  readonly log: JudgeLogEntry[] = [];

  constructor(
    private readonly client?: JudgeClient,
    private readonly fallback: RouterJudge = new HeuristicJudge(),
    private readonly options: ModelJudgeOptions = {},
  ) {}

  async decide(event: NormalizedEvent, ctx: { workers: WorkerRecord[] }): Promise<RouterDecision> {
    const at = this.options.now?.() ?? Date.now();
    const heuristic = await this.fallback.decide(event, ctx);
    if (this.options.prefilter && heuristic.action === 'ignore') {
      const decision = { ...heuristic, confidence: heuristic.confidence ?? 0.9 };
      this.log.push({
        at,
        eventType: event.type,
        action: 'ignore',
        source: 'prefilter',
        confidence: decision.confidence,
        reason: heuristic.reason,
      });
      return decision;
    }
    if (!this.client) throw new Error('ModelJudge has no provider.');
    const notes = await inspectNotes(this.options.inspect, event);
    let raw: string;
    try {
      raw = await this.client.complete(promptOf(event, notes));
    } catch {
      this.log.push({
        at,
        eventType: event.type,
        action: heuristic.action,
        source: 'heuristic',
        reason: 'model_failed',
      });
      return heuristic;
    }
    const parsed = parseModelDecision(raw, event) ?? heuristic;
    this.log.push({
      at,
      eventType: event.type,
      action: parsed.action,
      source: parsed === heuristic ? 'heuristic' : 'model',
      confidence: parsed.confidence,
      reason: parsed.action === 'ignore' ? parsed.reason : parsed.action,
    });
    return parsed;
  }
}

export function parseModelDecision(
  raw: string,
  event: NormalizedEvent,
): RouterDecision | undefined {
  const json = extractJson(raw);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const decision = ModelDecision.safeParse(parsed);
  if (!decision.success) return undefined;
  const data = decision.data;
  const confidence = data.confidence;
  if (data.action === 'ignore') {
    return {
      action: 'ignore',
      reason: data.reason ?? 'model_ignore',
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  if (data.action === 'answer') {
    const text = data.text?.trim();
    if (!text) return undefined;
    return { action: 'answer', text, ...(confidence !== undefined ? { confidence } : {}) };
  }
  const repos = event.subject?.repo ? [event.subject.repo] : [];
  const mandate = data.intensity === 'act' ? actMandate(repos, 'inferred') : observeMandate(repos);
  return {
    action: 'spawn',
    mandate,
    title: data.title?.trim() || 'Model spawn',
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function promptOf(event: NormalizedEvent, inspect = ''): string {
  return [
    'Decide ignore, answer, or spawn for this unowned event.',
    'Reply with JSON only: {"action":"ignore"|"answer"|"spawn","reason":"...","text":"...","title":"...","intensity":"observe"|"act","confidence":0.0}.',
    `type=${event.type} source=${event.source} actor=${event.actor.login} subject=${event.subject?.key ?? ''}`,
    `summary=${event.summary}`,
    inspect,
  ]
    .filter(Boolean)
    .join('\n');
}

function extractJson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return undefined;
}
