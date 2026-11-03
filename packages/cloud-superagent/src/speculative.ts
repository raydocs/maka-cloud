/**
 * Speculative execution. Default off. A trigger may start a background
 * attempt before the Router or human decides. Results are delivered only
 * after accept; discard cleans worktree/box state. Never pushes, comments,
 * or opens PRs until accepted.
 */

import type { SuperagentStore } from './store.js';
import type { Mandate, NormalizedEvent, ProposedAction, Usage, WorkerRecord } from './types.js';
import { emptyUsage, isLiveState, observeMandate } from './types.js';

export const SPECULATIVE_PRIORITY = 0;
export const NORMAL_PRIORITY = 100;

export type SpeculativeStatus = 'running' | 'ready' | 'accepted' | 'discarded';

export interface SpeculativeMeta {
  status: SpeculativeStatus;
  trigger: string;
  priority: number;
  acceptedAt?: number;
  discardedAt?: number;
  cost?: Usage;
}

export type SpeculativeTriggerKind = 'ci_failure' | 'issue_match';

export interface SpeculativeTrigger {
  kind: SpeculativeTriggerKind;
  /** Empty = no repo matches. Must opt in. */
  repos: string[];
  /** Case-insensitive substring or regex source for issue title/body. */
  pattern?: string;
}

export interface SpeculativeSettings {
  enabled: boolean;
  maxConcurrent: number;
  dailyTokens: number;
  dailyUsd: number;
  priority: number;
  triggers: SpeculativeTrigger[];
}

export const DEFAULT_SPECULATIVE: SpeculativeSettings = {
  enabled: false,
  maxConcurrent: 1,
  dailyTokens: 50_000,
  dailyUsd: 1,
  priority: SPECULATIVE_PRIORITY,
  triggers: [],
};

export function speculativeSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SpeculativeSettings {
  const enabled = env.MAKA_CLOUD_SPECULATIVE === '1';
  const repos = (env.MAKA_CLOUD_SPECULATIVE_REPOS ?? '')
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
  const pattern = env.MAKA_CLOUD_SPECULATIVE_ISSUE?.trim() || undefined;
  const triggers: SpeculativeTrigger[] = [];
  if (enabled && repos.length > 0) {
    triggers.push({ kind: 'ci_failure', repos });
    triggers.push({ kind: 'issue_match', repos, pattern });
  }
  return { ...DEFAULT_SPECULATIVE, enabled, triggers };
}

export function isSpeculativeShadow(worker: WorkerRecord): boolean {
  return worker.speculative !== undefined && worker.speculative.status !== 'accepted';
}

export function isUnacceptedSpeculative(worker: WorkerRecord): boolean {
  const status = worker.speculative?.status;
  return status === 'running' || status === 'ready';
}

export function workerPriority(worker: WorkerRecord): number {
  if (worker.speculative && worker.speculative.status !== 'accepted') {
    return worker.speculative.priority ?? SPECULATIVE_PRIORITY;
  }
  return NORMAL_PRIORITY;
}

export function compareWorkerPriority(a: WorkerRecord, b: WorkerRecord): number {
  return workerPriority(b) - workerPriority(a);
}

export function fieldOf(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

export function matchSpeculativeTrigger(
  event: NormalizedEvent,
  settings: SpeculativeSettings,
): SpeculativeTrigger | undefined {
  if (!settings.enabled) return undefined;
  const repo = event.subject?.repo;
  if (!repo) return undefined;
  for (const trigger of settings.triggers) {
    if (trigger.repos.length > 0 && !trigger.repos.includes(repo)) continue;
    if (trigger.repos.length === 0) continue;
    if (trigger.kind === 'ci_failure' && event.type === 'ci_failed') return trigger;
    if (trigger.kind === 'issue_match' && event.type === 'issue_opened') {
      if (!trigger.pattern) return trigger;
      const text = `${fieldOf(event, 'title')}\n${fieldOf(event, 'body')}`;
      if (text.toLowerCase().includes(trigger.pattern.toLowerCase())) return trigger;
      try {
        if (new RegExp(trigger.pattern, 'i').test(text)) return trigger;
      } catch {
        // invalid regex: substring match already failed
      }
    }
  }
  return undefined;
}

export type SpeculativeAdmit =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'concurrent_cap' | 'daily_tokens' | 'daily_usd' | 'already' };

export function utcDayStart(at: number): number {
  const day = new Date(at);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

export function speculativeWorkers(store: SuperagentStore, tenantId: string): WorkerRecord[] {
  return store.workers(tenantId).filter((row) => row.speculative !== undefined);
}

export function speculativeSpendSince(
  store: SuperagentStore,
  tenantId: string,
  since: number,
): Usage {
  const usage = emptyUsage();
  for (const worker of speculativeWorkers(store, tenantId)) {
    if (worker.createdAt < since) continue;
    usage.tokens += worker.usage.tokens;
    usage.usdMicros += worker.usage.usdMicros;
    usage.wallMs += worker.usage.wallMs;
  }
  return usage;
}

export function admitSpeculative(
  store: SuperagentStore,
  tenantId: string,
  subjectKey: string,
  settings: SpeculativeSettings,
  at: number,
): SpeculativeAdmit {
  if (!settings.enabled) return { ok: false, reason: 'disabled' };
  const live = speculativeWorkers(store, tenantId).filter(
    (row) => isUnacceptedSpeculative(row) && isLiveState(row.state),
  );
  if (live.some((row) => row.subject.key === subjectKey)) {
    return { ok: false, reason: 'already' };
  }
  if (live.length >= settings.maxConcurrent) {
    return { ok: false, reason: 'concurrent_cap' };
  }
  const spend = speculativeSpendSince(store, tenantId, utcDayStart(at));
  if (spend.tokens >= settings.dailyTokens) return { ok: false, reason: 'daily_tokens' };
  if (spend.usdMicros >= Math.round(settings.dailyUsd * 1_000_000)) {
    return { ok: false, reason: 'daily_usd' };
  }
  return { ok: true };
}

const OUTBOUND_KINDS = new Set([
  'merge',
  'push_protected',
  'deploy',
  'secrets',
  'other_irreversible',
]);

export function speculativeBlocksOutbound(worker: WorkerRecord, action: ProposedAction): boolean {
  if (!isUnacceptedSpeculative(worker)) return false;
  if (OUTBOUND_KINDS.has(action.kind)) return true;
  if (action.kind === 'spend') return true;
  return looksLikeCommentOrPr(action.boundText);
}

export function looksLikeCommentOrPr(boundText: string): boolean {
  return /\b(comment|open a pr|open pr|create pull|post review)\b/i.test(boundText);
}

export function speculativeMandate(repos: string[]): Mandate {
  const mandate = observeMandate(repos, 'inferred');
  mandate.intensity = 'act';
  mandate.authority = 'open-pr';
  return mandate;
}

export interface SpeculativeCleanup {
  discard(worker: WorkerRecord): Promise<void>;
}

export class RecordingCleanup implements SpeculativeCleanup {
  readonly discarded: string[] = [];

  async discard(worker: WorkerRecord): Promise<void> {
    this.discarded.push(worker.workerId);
  }
}

export function markSpeculativeReady(worker: WorkerRecord): void {
  if (worker.speculative?.status === 'running') {
    worker.speculative = { ...worker.speculative, status: 'ready' };
  }
}

export function snapshotSpeculativeCost(worker: WorkerRecord): Usage {
  return {
    tokens: worker.usage.tokens,
    usdMicros: worker.usage.usdMicros,
    wallMs: worker.usage.wallMs,
  };
}
