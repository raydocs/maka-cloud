import { observeMandate } from './types.js';
import type {
  AdmissionPolicy,
  EventSource,
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

/** Stub: a later PR may wire a cheap gateway model. Throws if called. */
export class ModelJudge implements RouterJudge {
  constructor(private readonly provider?: { complete(prompt: string): Promise<string> }) {}
  async decide(
    _event: NormalizedEvent,
    _ctx: { workers: WorkerRecord[] },
  ): Promise<RouterDecision> {
    if (!this.provider) throw new Error('ModelJudge has no provider.');
    throw new Error('ModelJudge is not wired in this slice.');
  }
}
