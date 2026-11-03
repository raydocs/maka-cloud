import type {
  AutonomyIncident,
  AutonomySettings,
  AutonomyState,
  UsageEntry,
  WatchdogFinding,
  WorkerRecord,
} from './types.js';
import { DEFAULT_AUTONOMY } from './types.js';

export { DEFAULT_AUTONOMY, type AutonomyIncident, type AutonomySettings, type AutonomyState };

export const AUTONOMY_LEDGER_KIND = {
  retry: 'autonomy_retry',
  nudge: 'autonomy_nudge',
  stop: 'autonomy_stop',
} as const;

export function emptyAutonomy(): AutonomyState {
  return {
    emptyTurns: 0,
    lastToolKey: null,
    lastToolResultHash: null,
    identicalToolRuns: 0,
    timeLimitAttempts: 0,
    streamRetries: 0,
    cacheBreaks: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
  };
}

export function autonomyOf(worker: Pick<WorkerRecord, 'autonomy'>): AutonomyState {
  return worker.autonomy ? { ...worker.autonomy } : emptyAutonomy();
}

export function mergeAutonomy(
  base: AutonomySettings,
  patch?: Partial<AutonomySettings>,
): AutonomySettings {
  return { ...base, ...patch };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compaction summaries have room for 16k tokens. Super-agent had no
 * conversation compact before this; Factory raised the same budget from 8k.
 */
export function compactHistory(
  messages: ReadonlyArray<{ role: string; content: string }>,
  budgetTokens = DEFAULT_AUTONOMY.compactionSummaryTokens,
): { messages: Array<{ role: string; content: string }>; summarized: boolean; tokens: number } {
  const clone = messages.map((row) => ({ ...row }));
  const total = clone.reduce((sum, row) => sum + estimateTokens(row.content), 0);
  if (total <= budgetTokens) return { messages: clone, summarized: false, tokens: total };
  const kept: typeof clone = [];
  let used = 0;
  for (let i = clone.length - 1; i >= 0; i -= 1) {
    const row = clone[i];
    if (!row) continue;
    const cost = estimateTokens(row.content);
    if (kept.length > 0 && used + cost > Math.floor(budgetTokens / 2)) break;
    kept.unshift(row);
    used += cost;
  }
  const dropped = clone.slice(0, clone.length - kept.length);
  const raw = dropped.map((row) => `${row.role}: ${row.content}`).join('\n');
  const cap = Math.max(0, budgetTokens - used);
  const summary = raw.slice(0, cap * 4);
  const head = {
    role: 'user',
    content: `Compaction summary (${dropped.length} turns):\n${summary}`,
  };
  const messagesOut = [head, ...kept];
  let tokens = messagesOut.reduce((sum, row) => sum + estimateTokens(row.content), 0);
  if (tokens > budgetTokens) {
    const overflow = tokens - budgetTokens;
    head.content = head.content.slice(0, Math.max(0, head.content.length - overflow * 4));
    tokens = messagesOut.reduce((sum, row) => sum + estimateTokens(row.content), 0);
  }
  return { messages: messagesOut, summarized: true, tokens };
}

export function observeStreamSilence(
  state: AutonomyState,
  at: number,
  settings: AutonomySettings = DEFAULT_AUTONOMY,
): { state: AutonomyState; incident: AutonomyIncident } {
  const next = { ...state, streamRetries: state.streamRetries + 1 };
  const incident: AutonomyIncident = {
    action: 'retry',
    rule: 'stream_silence',
    detail: `No tokens for ${Math.round(settings.streamSilenceMs / 1000)}s; dropped stream.`,
    at,
  };
  next.lastIncident = incident;
  next.pending = incident;
  return { state: next, incident };
}

export function observeTimeLimit(
  state: AutonomyState,
  at: number,
  settings: AutonomySettings = DEFAULT_AUTONOMY,
): { state: AutonomyState; incident: AutonomyIncident } {
  const attempts = state.timeLimitAttempts + 1;
  const next = { ...state, timeLimitAttempts: attempts };
  const stop = attempts >= settings.timeLimitAttempts;
  const incident: AutonomyIncident = {
    action: stop ? 'stop' : 'retry',
    rule: 'time_limit',
    detail: stop
      ? `Hit the hard time limit ${attempts} times; stopping.`
      : `Hit the hard time limit (attempt ${attempts}/${settings.timeLimitAttempts}).`,
    at,
  };
  next.lastIncident = incident;
  next.pending = incident;
  return { state: next, incident };
}

export function observeTurn(
  state: AutonomyState,
  input: { visible: boolean },
  at: number,
  settings: AutonomySettings = DEFAULT_AUTONOMY,
): { state: AutonomyState; incident?: AutonomyIncident } {
  const emptyTurns = input.visible ? 0 : state.emptyTurns + 1;
  const next = { ...state, emptyTurns };
  if (emptyTurns < settings.emptyTurnsStop) return { state: next };
  const incident: AutonomyIncident = {
    action: 'stop',
    rule: 'empty_turns',
    detail: `${emptyTurns} consecutive turns with no visible output.`,
    at,
  };
  next.lastIncident = incident;
  next.pending = incident;
  return { state: next, incident };
}

export function toolKey(name: string, args: unknown): string {
  return `${name}:${stableJson(args)}`;
}

export function resultHash(result: string): string {
  return `h:${result.length}:${fnv1a(result)}`;
}

export function observeToolCall(
  state: AutonomyState,
  input: { name: string; args: unknown; result: string },
  at: number,
  settings: AutonomySettings = DEFAULT_AUTONOMY,
): { state: AutonomyState; incident?: AutonomyIncident } {
  const key = toolKey(input.name, input.args);
  const hash = resultHash(input.result);
  const sameCall = state.lastToolKey === key;
  const newResult = sameCall && state.lastToolResultHash !== hash;
  const identicalToolRuns = sameCall && !newResult ? state.identicalToolRuns + 1 : 1;
  const next: AutonomyState = {
    ...state,
    lastToolKey: key,
    lastToolResultHash: hash,
    identicalToolRuns,
  };
  if (newResult || !sameCall) return { state: next };
  if (identicalToolRuns === settings.identicalToolsNudge) {
    const incident: AutonomyIncident = {
      action: 'nudge',
      rule: 'repeat_tools',
      detail: `${identicalToolRuns} identical ${input.name} calls; nudging.`,
      at,
    };
    next.lastIncident = incident;
    next.pending = incident;
    return { state: next, incident };
  }
  if (identicalToolRuns >= settings.identicalToolsStop) {
    const incident: AutonomyIncident = {
      action: 'stop',
      rule: 'repeat_tools',
      detail: `${identicalToolRuns} identical ${input.name} calls; stopping.`,
      at,
    };
    next.lastIncident = incident;
    next.pending = incident;
    return { state: next, incident };
  }
  return { state: next };
}

export function markApplied(state: AutonomyState): AutonomyState {
  if (!state.pending) return state;
  return { ...state, pending: { ...state.pending, applied: true } };
}

export function evaluateAutonomy(worker: WorkerRecord, at: number): WatchdogFinding | undefined {
  const pending = worker.autonomy?.pending;
  if (!pending || pending.applied) return undefined;
  return {
    rule: pending.rule,
    tenantId: worker.tenantId,
    workerId: worker.workerId,
    action: pending.action,
    generation: worker.generation,
    detail: pending.detail,
  };
}

export function autonomyUsage(
  worker: Pick<WorkerRecord, 'tenantId' | 'workerId'>,
  incident: AutonomyIncident,
  wallMs = 0,
): UsageEntry {
  return {
    tenantId: worker.tenantId,
    workerId: worker.workerId,
    tokens: 0,
    usdMicros: 0,
    wallMs,
    at: incident.at,
    kind: AUTONOMY_LEDGER_KIND[incident.action],
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableJson(row)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`).join(',')}}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
