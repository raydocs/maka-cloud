import { recallMemory } from './spill.js';
import type { SuperagentStore } from './store.js';
import type {
  AuditRecord,
  NormalizedEvent,
  TenantUsage,
  WatchdogFinding,
  WorkerRecord,
} from './types.js';
import type { WatchdogSettings } from './types.js';
import { evaluateWorker } from './watchdog.js';
import type { ProgressView, StatusSnapshot } from './progress.js';

export const WATCHDOG_COMMANDS = ['nudge', 'pause', 'resume', 'cancel', 'stuck_check'] as const;
export type WatchdogCommandKind = (typeof WATCHDOG_COMMANDS)[number];

export type WatchdogAskTopic = 'stuck' | 'happened' | 'everyone' | 'free';

export type WatchdogIntent =
  | {
      kind: 'ask';
      topic: WatchdogAskTopic;
      text: string;
      workerId?: string;
      issue?: number;
      when?: 'yesterday' | 'today';
    }
  | {
      kind: 'command';
      command: WatchdogCommandKind;
      text: string;
      workerId?: string;
    };

export interface WatchdogNarrator {
  narrate(prompt: string): Promise<string>;
}

export interface WatchdogActionResult {
  kind: WatchdogCommandKind;
  ok: boolean;
  workerId?: string;
  reason?: string;
}

export interface WatchdogAnswer {
  text: string;
  citations: string[];
  source: 'model' | 'fallback';
  intent: WatchdogIntent;
  action?: WatchdogActionResult;
}

export interface RecallLink {
  triggerId: string | null;
  subjectKey: string;
  workerId: string;
  subscriptionId?: string;
}

export interface WatchdogQueryContext {
  at: number;
  tenantId: string;
  workers: WorkerRecord[];
  views: ProgressView[];
  incidents: WatchdogFinding[];
  audits: AuditRecord[];
  ledger: TenantUsage;
  events: NormalizedEvent[];
  chain: RecallLink[];
  liveFindings: WatchdogFinding[];
}

const WORKER_ID_RE = /\bwrk_[a-z0-9]+\b/i;
const ISSUE_RE = /\b(?:issue|pr|pull request|#)\s*#?\s*(\d+)\b/i;
const ID_RE = /\b(?:wrk|evt|aud|sub|apr|job)_[a-z0-9]+\b/gi;
const COMMAND_HEAD =
  /^(please\s+)?(nudge|pause|resume|cancel|abort|stop|re-?run\s+stuck-?check|run\s+stuck-?check|stuck-?check)\b/i;

export function parseWatchdogText(text: string): WatchdogIntent {
  const trimmed = text.trim();
  const workerId = matchWorkerId(trimmed);
  const issue = matchIssue(trimmed);
  const when = /yesterday/i.test(trimmed)
    ? 'yesterday'
    : /today/i.test(trimmed)
      ? 'today'
      : undefined;
  const question = isQuestion(trimmed);
  const command = matchCommand(trimmed);
  if (command && !question) {
    return { kind: 'command', command, text: trimmed, ...(workerId ? { workerId } : {}) };
  }
  if (/everyone|all workers|what is everyone/i.test(trimmed)) {
    return { kind: 'ask', topic: 'everyone', text: trimmed, ...(workerId ? { workerId } : {}) };
  }
  if (/\bstuck\b/i.test(trimmed) || /why is worker/i.test(trimmed)) {
    return {
      kind: 'ask',
      topic: 'stuck',
      text: trimmed,
      ...(workerId ? { workerId } : {}),
      ...(issue !== undefined ? { issue } : {}),
      ...(when ? { when } : {}),
    };
  }
  if (
    /what happened/i.test(trimmed) ||
    (issue !== undefined && (when || /issue|pr/i.test(trimmed)))
  ) {
    return {
      kind: 'ask',
      topic: 'happened',
      text: trimmed,
      ...(workerId ? { workerId } : {}),
      ...(issue !== undefined ? { issue } : {}),
      ...(when ? { when } : {}),
    };
  }
  return {
    kind: 'ask',
    topic: 'free',
    text: trimmed,
    ...(workerId ? { workerId } : {}),
    ...(issue !== undefined ? { issue } : {}),
    ...(when ? { when } : {}),
  };
}

export function isQuestion(text: string): boolean {
  return /\?/.test(text) || /^(why|what|how|where|who|when)\b/i.test(text.trim());
}

export function matchWorkerId(text: string): string | undefined {
  const direct = WORKER_ID_RE.exec(text);
  if (direct?.[0]) return direct[0].toLowerCase();
  const named = /\bworker\s+([a-z0-9_:-]+)/i.exec(text);
  const token = named?.[1];
  if (token && /^wrk_/i.test(token)) return token.toLowerCase();
  return undefined;
}

export function matchIssue(text: string): number | undefined {
  const match = ISSUE_RE.exec(text);
  if (!match?.[1]) return undefined;
  const number = Number(match[1]);
  return Number.isInteger(number) ? number : undefined;
}

export function matchCommand(text: string): WatchdogCommandKind | undefined {
  const match = COMMAND_HEAD.exec(text.trim());
  if (!match?.[2]) return undefined;
  const verb = match[2].toLowerCase().replace(/\s+/g, ' ');
  if (verb === 'nudge') return 'nudge';
  if (verb === 'pause') return 'pause';
  if (verb === 'resume') return 'resume';
  if (verb === 'cancel' || verb === 'abort' || verb === 'stop') return 'cancel';
  return 'stuck_check';
}

export function listStoreEvents(store: SuperagentStore, tenantId: string): NormalizedEvent[] {
  const extra = store as SuperagentStore & { listEvents?: (id: string) => NormalizedEvent[] };
  if (typeof extra.listEvents === 'function') return extra.listEvents(tenantId);
  const seen = new Set<string>();
  const out: NormalizedEvent[] = [];
  const add = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    const event = store.event(tenantId, id);
    if (!event) return;
    seen.add(id);
    out.push(event);
  };
  for (const worker of store.allWorkers()) {
    if (worker.tenantId !== tenantId) continue;
    add(worker.lastEventId);
    for (const item of store.inbox(worker.workerId)) add(item.eventId);
  }
  return out.sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId));
}

export function recallChain(store: SuperagentStore, tenantId: string): RecallLink[] {
  const links: RecallLink[] = [];
  for (const worker of store.allWorkers()) {
    if (worker.tenantId !== tenantId) continue;
    const inbox = store.inbox(worker.workerId);
    const first = inbox[0] ? store.event(tenantId, inbox[0].eventId) : undefined;
    const trigger =
      first ?? (worker.lastEventId ? store.event(tenantId, worker.lastEventId) : undefined);
    const sub = store
      .liveSubscribers(tenantId, worker.subject.key)
      .find((row) => row.workerId === worker.workerId);
    links.push({
      triggerId: trigger?.eventId ?? worker.lastEventId,
      subjectKey: worker.subject.key,
      workerId: worker.workerId,
      ...(sub ? { subscriptionId: sub.subscriptionId } : {}),
    });
  }
  return links;
}

export function collectWatchdogContext(input: {
  store: SuperagentStore;
  tenantId: string;
  at: number;
  incidents: readonly WatchdogFinding[];
  snapshot: StatusSnapshot;
  settings: WatchdogSettings;
}): WatchdogQueryContext {
  const workers = input.store.allWorkers().filter((row) => row.tenantId === input.tenantId);
  const liveFindings: WatchdogFinding[] = [];
  for (const worker of workers) {
    const expired = input.store
      .pendingApprovals(worker.tenantId, worker.workerId)
      .some((row) => row.expiresAt <= input.at);
    const found = evaluateWorker(worker, input.settings, input.at, expired);
    if (found) liveFindings.push(found);
  }
  return {
    at: input.at,
    tenantId: input.tenantId,
    workers,
    views: input.snapshot.workers,
    incidents: input.incidents.filter((row) => row.tenantId === input.tenantId),
    audits: input.store.audit(input.tenantId),
    ledger: input.store.tenantUsage(input.tenantId),
    events: listStoreEvents(input.store, input.tenantId),
    chain: recallChain(input.store, input.tenantId),
    liveFindings,
  };
}

export function dayWindow(
  at: number,
  when: 'yesterday' | 'today' | undefined,
): { start: number; end: number } | undefined {
  if (!when) return undefined;
  const date = new Date(at);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (when === 'today') return { start: today, end: today + 86_400_000 };
  return { start: today - 86_400_000, end: today };
}

export function extractIds(text: string): string[] {
  return unique((text.match(ID_RE) ?? []).map((id) => id.toLowerCase()));
}

export function unique(ids: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

export function formatWatchdogFallback(
  intent: Extract<WatchdogIntent, { kind: 'ask' }>,
  ctx: WatchdogQueryContext,
): { text: string; citations: string[] } {
  const citations: string[] = [];
  const cite = (id?: string | null) => {
    if (id) citations.push(id);
  };
  const lines: string[] = [];
  const window = dayWindow(ctx.at, intent.when);
  const workers = ctx.workers.filter((worker) => matchWorker(worker, intent, window, ctx));

  if (intent.topic === 'everyone') {
    lines.push(everyoneLines(ctx, cite));
  } else if (intent.topic === 'stuck') {
    const target = pickStuck(workers, ctx, intent.workerId);
    if (!target) {
      lines.push('No stuck worker matches that question.');
    } else {
      lines.push(stuckLines(target, ctx, cite));
    }
  } else if (intent.topic === 'happened') {
    if (workers.length === 0 && ctx.events.length === 0) {
      lines.push('No matching issue or worker in the ledger.');
    } else {
      for (const worker of workers.slice(0, 8)) {
        lines.push(happenedLines(worker, ctx, window, cite));
      }
      if (workers.length === 0) {
        lines.push(eventOnlyLines(ctx, intent, window, cite));
      }
    }
  } else {
    if (intent.workerId || intent.issue !== undefined) {
      for (const worker of workers.slice(0, 8)) {
        lines.push(happenedLines(worker, ctx, window, cite));
        if (
          worker.state === 'stuck' ||
          ctx.liveFindings.some((row) => row.workerId === worker.workerId)
        ) {
          lines.push(stuckLines(worker, ctx, cite));
        }
      }
      if (workers.length === 0) lines.push('No matching worker.');
    } else {
      lines.push(everyoneLines(ctx, cite));
    }
  }

  const cited = unique(citations);
  if (cited.length === 0 && ctx.ledger.events > 0) {
    // Ledger has no row ids; cite the live chain if any.
    for (const link of ctx.chain) {
      cite(link.workerId);
      cite(link.triggerId);
    }
  }
  const ids = unique(citations);
  const body = lines.filter(Boolean).join('\n') || 'Nothing recorded.';
  return {
    text: `${body}\nids: ${ids.length > 0 ? ids.join(' ') : 'none'}`,
    citations: ids,
  };
}

export function formatWatchdogAnswer(answer: WatchdogAnswer): string {
  const ids = answer.citations.length > 0 ? answer.citations.join(' ') : 'none';
  const action = answer.action
    ? `\naction: ${answer.action.kind}${answer.action.workerId ? ` ${answer.action.workerId}` : ''} ${answer.action.ok ? 'ok' : 'refused'}${answer.action.reason ? ` (${answer.action.reason})` : ''}`
    : '';
  if (/\bids:/i.test(answer.text)) return `${answer.text}${action}`;
  return `${answer.text}\nids: ${ids}${action}`;
}

export async function answerWatchdog(
  intent: Extract<WatchdogIntent, { kind: 'ask' }>,
  ctx: WatchdogQueryContext,
  narrator?: WatchdogNarrator,
): Promise<WatchdogAnswer> {
  const fallback = formatWatchdogFallback(intent, ctx);
  if (!narrator) {
    return { text: fallback.text, citations: fallback.citations, source: 'fallback', intent };
  }
  try {
    const prompt = [
      'You are the Super-agent watchdog. Answer only from the context.',
      'Cite wrk_ / evt_ / aud_ / sub_ ids. Do not invent ids. Do not take actions.',
      `Question: ${intent.text}`,
      `Deterministic draft:\n${fallback.text}`,
      `Context JSON:\n${JSON.stringify(compactContext(ctx, intent))}`,
    ].join('\n\n');
    const narrated = (await narrator.narrate(prompt)).trim();
    const citations = unique([...extractIds(narrated), ...fallback.citations]);
    const text = narrated.length > 0 ? ensureIdsLine(narrated, citations) : fallback.text;
    return { text, citations, source: 'model', intent };
  } catch {
    return { text: fallback.text, citations: fallback.citations, source: 'fallback', intent };
  }
}

export function commandRefusedAsk(
  intent: Extract<WatchdogIntent, { kind: 'command' }>,
): WatchdogAnswer {
  const citations = intent.workerId ? [intent.workerId] : [];
  return {
    text: `That looks like a command (${intent.command}). POST instruct or pass --instruct to apply it; ask is read-only.\nids: ${citations.join(' ') || 'none'}`,
    citations,
    source: 'fallback',
    intent,
  };
}

export function createWatchdogNarratorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): WatchdogNarrator | undefined {
  const model = env.MAKA_CLOUD_WATCHDOG_MODEL?.trim();
  if (!model) return undefined;
  const apiKey =
    env.MAKA_CLOUD_WATCHDOG_API_KEY?.trim() ||
    env.MAKA_CLOUD_JUDGE_API_KEY?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() ||
    '';
  if (!apiKey) return undefined;
  return {
    async narrate(prompt: string): Promise<string> {
      const { FetchJudgeClient } = await import('./judge-client.js');
      const client = new FetchJudgeClient({
        apiKey,
        model,
        fetch: fetchImpl,
        maxTokens: 512,
        baseUrl:
          (
            env.MAKA_CLOUD_WATCHDOG_BASE_URL?.trim() ||
            env.MAKA_CLOUD_JUDGE_BASE_URL?.trim() ||
            env.ANTHROPIC_BASE_URL?.trim() ||
            ''
          ).replace(/\/+$/, '') || undefined,
      });
      return client.complete(prompt);
    },
  };
}

function matchWorker(
  worker: WorkerRecord,
  intent: Extract<WatchdogIntent, { kind: 'ask' }>,
  window: { start: number; end: number } | undefined,
  ctx: WatchdogQueryContext,
): boolean {
  if (intent.workerId && worker.workerId !== intent.workerId) return false;
  if (intent.issue !== undefined && worker.subject.number !== intent.issue) return false;
  if (window) {
    const stamp = worker.createdAt;
    const eventHit = ctx.events.some(
      (event) =>
        event.subject?.key === worker.subject.key &&
        event.occurredAt >= window.start &&
        event.occurredAt < window.end,
    );
    const inWindow = (stamp >= window.start && stamp < window.end) || eventHit;
    if (!inWindow) return false;
  }
  return true;
}

function pickStuck(
  workers: WorkerRecord[],
  ctx: WatchdogQueryContext,
  workerId?: string,
): WorkerRecord | undefined {
  if (workerId)
    return (
      workers.find((row) => row.workerId === workerId) ??
      ctx.workers.find((row) => row.workerId === workerId)
    );
  return (
    workers.find((row) => row.state === 'stuck') ??
    workers.find((row) => ctx.liveFindings.some((found) => found.workerId === row.workerId)) ??
    ctx.workers.find((row) => row.state === 'stuck') ??
    ctx.workers.find((row) => ctx.liveFindings.some((found) => found.workerId === row.workerId))
  );
}

function everyoneLines(ctx: WatchdogQueryContext, cite: (id?: string | null) => void): string {
  if (ctx.workers.length === 0) return 'No workers.';
  const live = ctx.workers.filter((row) => row.retiredAt == null);
  const rows = (live.length > 0 ? live : ctx.workers).map((worker) => {
    cite(worker.workerId);
    const link = ctx.chain.find((row) => row.workerId === worker.workerId);
    cite(link?.triggerId);
    cite(link?.subscriptionId);
    const view = ctx.views.find((row) => row.workerId === worker.workerId);
    const phase = view ? `${view.look} ${view.phase} ${view.k}/${view.n}` : worker.state;
    return `${worker.workerId} ${phase} ${worker.subject.key} plan=${clip(worker.plan)} last=${worker.lastEventId ?? 'none'}`;
  });
  const ledger = `ledger tokens=${ctx.ledger.tokens} usdMicros=${ctx.ledger.usdMicros} events=${ctx.ledger.events}`;
  return [`Everyone (${rows.length}):`, ...rows, ledger].join('\n');
}

function stuckLines(
  worker: WorkerRecord,
  ctx: WatchdogQueryContext,
  cite: (id?: string | null) => void,
): string {
  cite(worker.workerId);
  cite(worker.lastEventId);
  const link = ctx.chain.find((row) => row.workerId === worker.workerId);
  cite(link?.triggerId);
  cite(link?.subscriptionId);
  const live = ctx.liveFindings.find((row) => row.workerId === worker.workerId);
  const incident = [...ctx.incidents].reverse().find((row) => row.workerId === worker.workerId);
  const audits = ctx.audits.filter(
    (row) =>
      row.workerId === worker.workerId &&
      (row.kind === 'stuck' ||
        row.kind === 'nudged' ||
        row.kind === 'stopped' ||
        row.kind === 'restart' ||
        row.kind === 'over_budget'),
  );
  for (const row of audits) cite(row.auditId);
  const finding = live ?? incident;
  const reason = finding
    ? `${finding.rule} → ${finding.action}: ${finding.detail}`
    : worker.state === 'stuck'
      ? 'state is stuck; no live finding'
      : `state is ${worker.state}; not a live W2/W3 finding`;
  const waiting = worker.progress?.waiting ? ` waiting on ${worker.progress.waiting.kind}` : '';
  const recall = clip(recallMemory(worker), 180);
  return [
    `${worker.workerId} on ${worker.subject.key} is ${worker.state}.${waiting}`,
    reason,
    `step=${worker.lastStepSignature ?? 'none'} repeats=${worker.stepRepeats} nudges=${worker.nudges ?? 0}`,
    `chain trigger=${link?.triggerId ?? 'none'} → ${worker.subject.key} → ${worker.workerId}`,
    recall ? `recall: ${recall}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function happenedLines(
  worker: WorkerRecord,
  ctx: WatchdogQueryContext,
  window: { start: number; end: number } | undefined,
  cite: (id?: string | null) => void,
): string {
  cite(worker.workerId);
  const link = ctx.chain.find((row) => row.workerId === worker.workerId);
  cite(link?.triggerId);
  cite(link?.subscriptionId);
  cite(worker.lastEventId);
  const events = ctx.events.filter((event) => {
    if (event.subject?.key !== worker.subject.key) return false;
    if (!window) return true;
    return event.occurredAt >= window.start && event.occurredAt < window.end;
  });
  for (const event of events) cite(event.eventId);
  const usage = ctx.ledger;
  return [
    `${worker.subject.key} owned by ${worker.workerId} (${worker.state})`,
    `chain ${link?.triggerId ?? 'none'} → ${worker.subject.key} → ${worker.workerId}`,
    events.length > 0
      ? `events: ${events.map((event) => `${event.eventId} ${event.type}`).join(', ')}`
      : 'events: none in window',
    `plan=${clip(worker.plan)} usage tokens=${worker.usage.tokens} ledgerEvents=${usage.events}`,
  ].join('\n');
}

function eventOnlyLines(
  ctx: WatchdogQueryContext,
  intent: Extract<WatchdogIntent, { kind: 'ask' }>,
  window: { start: number; end: number } | undefined,
  cite: (id?: string | null) => void,
): string {
  const events = ctx.events.filter((event) => {
    if (intent.issue !== undefined && event.subject?.number !== intent.issue) return false;
    if (!window) return true;
    return event.occurredAt >= window.start && event.occurredAt < window.end;
  });
  for (const event of events) cite(event.eventId);
  if (events.length === 0) return 'No events in that window.';
  return `events: ${events.map((event) => `${event.eventId} ${event.type} ${event.subject?.key ?? ''}`).join(', ')}`;
}

function compactContext(
  ctx: WatchdogQueryContext,
  intent: Extract<WatchdogIntent, { kind: 'ask' }>,
): Record<string, unknown> {
  return {
    at: ctx.at,
    intent,
    workers: ctx.workers.map((worker) => ({
      workerId: worker.workerId,
      state: worker.state,
      subject: worker.subject,
      plan: clip(worker.plan, 240),
      lastEventId: worker.lastEventId,
      lastStepSignature: worker.lastStepSignature,
      stepRepeats: worker.stepRepeats,
      nudges: worker.nudges ?? 0,
      progress: worker.progress
        ? {
            phase: worker.progress.phase,
            lastActivity: worker.progress.lastActivity,
            waiting: worker.progress.waiting,
          }
        : undefined,
      usage: worker.usage,
    })),
    views: ctx.views,
    incidents: ctx.incidents,
    liveFindings: ctx.liveFindings,
    audits: ctx.audits.slice(-40).map((row) => ({
      auditId: row.auditId,
      workerId: row.workerId,
      kind: row.kind,
      at: row.at,
      detail: row.detail,
    })),
    events: ctx.events.slice(-40).map((event) => ({
      eventId: event.eventId,
      type: event.type,
      subject: event.subject?.key,
      number: event.subject?.number,
      occurredAt: event.occurredAt,
      summary: event.summary,
    })),
    chain: ctx.chain,
    ledger: ctx.ledger,
  };
}

function ensureIdsLine(text: string, citations: string[]): string {
  if (/\bids:/i.test(text)) return text;
  return `${text}\nids: ${citations.length > 0 ? citations.join(' ') : 'none'}`;
}

function clip(text: string, max = 120): string {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
