/**
 * Super-agent domain types. Terms align with the DeepSeek Harness article and
 * dsh-superagent-prototype (MIT, ideas only): Trigger → NormalizedEvent,
 * Thread → Subject, Ticket → Worker, Eval → Router.
 */

export const POLICY_VERSION = 'maka-superagent.1';

export const EVENT_SOURCES = ['github', 'chat', 'timer', 'internal'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const ACTOR_KINDS = ['user', 'bot', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const SUBJECT_KINDS = ['pull_request', 'issue', 'conversation', 'check'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const WORKER_STATES = [
  'spawning',
  'running',
  'sleeping',
  'waking',
  'awaiting_approval',
  'stuck',
  'crashed',
  'retiring',
  'retired',
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export const INTENSITIES = ['observe', 'act', 'autofix'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const AUTHORITIES = ['read-only', 'open-pr', 'merge-when-green'] as const;
export type Authority = (typeof AUTHORITIES)[number];

export const STRENGTHS = ['explicit', 'inferred'] as const;
export type Strength = (typeof STRENGTHS)[number];

export const APPROVAL_KINDS = [
  'merge',
  'push_protected',
  'secrets',
  'deploy',
  'spend',
  'other_irreversible',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATES = ['pending', 'approved', 'denied', 'expired'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const WATCHDOG_RULES = [
  'crashed',
  'stuck',
  'looping',
  'over_budget',
  'subject_closed',
  'awaiting_expired',
] as const;
export type WatchdogRule = (typeof WATCHDOG_RULES)[number];

export interface Actor {
  login: string;
  kind: ActorKind;
}

export interface Subject {
  kind: SubjectKind;
  tenantId: string;
  key: string;
  repo?: string;
  number?: number;
  conversationId?: string;
  branch?: string;
  closed?: boolean;
}

export interface NormalizedEvent {
  eventId: string;
  tenantId: string;
  source: EventSource;
  type: string;
  subject: Subject | null;
  idempotencyKey: string;
  actor: Actor;
  occurredAt: number;
  receivedAt: number;
  summary: string;
  fields: Array<[string, string]>;
  closesSubject: boolean;
}

export interface Mandate {
  policyVersion: string;
  scope: { repos: string[]; paths?: string[] };
  intensity: Intensity;
  authority: Authority;
  budgets: { tokens?: number; usd?: number; wallMs?: number };
  strength: Strength;
}

export interface Usage {
  tokens: number;
  usdMicros: number;
  wallMs: number;
}

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  subject: Subject;
  state: WorkerState;
  generation: number;
  mandate: Mandate;
  memory: string;
  plan: string;
  transcriptPointer: string | null;
  sandboxRef: string | null;
  workspaceRef: string | null;
  lastEventId: string | null;
  lastProgressAt: number;
  lastHeartbeatAt: number;
  lastStepSignature: string | null;
  stepRepeats: number;
  usage: Usage;
  createdAt: number;
  updatedAt: number;
  retiredAt: number | null;
}

export interface Subscription {
  subscriptionId: string;
  tenantId: string;
  subjectKey: string;
  workerId: string;
  createdAt: number;
  retiredAt: number | null;
}

export interface InboxItem {
  workerId: string;
  seq: number;
  eventId: string;
  deliveredAt: number;
  consumedAt: number | null;
}

export interface ApprovalRecord {
  approvalId: string;
  tenantId: string;
  workerId: string;
  kind: ApprovalKind;
  boundText: string;
  state: ApprovalState;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

export interface AuditRecord {
  auditId: string;
  tenantId: string;
  workerId: string | null;
  kind: string;
  at: number;
  detail: Record<string, string | number | boolean | null>;
}

export interface UsageEntry {
  tenantId: string;
  workerId: string;
  tokens: number;
  usdMicros: number;
  wallMs: number;
  at: number;
}

export interface ProposedAction {
  kind: ApprovalKind;
  boundText: string;
}

export interface HandlerResult {
  memory?: string;
  plan?: string;
  transcriptPointer?: string;
  progress?: boolean;
  stepSignature?: string;
  usage?: Partial<Usage>;
  action?: ProposedAction;
}

export interface WorkerContext {
  worker: WorkerRecord;
  event: NormalizedEvent;
}

export interface WorkerHandler {
  handle(ctx: WorkerContext, event: NormalizedEvent): Promise<HandlerResult>;
}

export type RouterDecision =
  | { action: 'ignore'; reason: string }
  | { action: 'answer'; text: string }
  | { action: 'spawn'; mandate: Mandate; title: string };

export interface RouterJudge {
  decide(event: NormalizedEvent, ctx: { workers: WorkerRecord[] }): Promise<RouterDecision>;
}

export interface AdmissionPolicy {
  allowActors?: string[];
  selfLogins?: string[];
  denyUnownedBots?: boolean;
  allowSources?: EventSource[];
}

export interface WatchdogSettings {
  stallAfterMs: number;
  heartbeatAfterMs: number;
  loopRepeat: number;
  maxRestarts: number;
  approvalTtlMs: number;
}

export interface WatchdogFinding {
  rule: WatchdogRule;
  tenantId: string;
  workerId: string;
  action: 'restart' | 'escalate' | 'retire' | 'stop';
  generation: number;
  detail: string;
}

export interface MeteringHooks {
  record(entry: UsageEntry): void;
  /** Return `stop` to refuse new unowned work for this tenant. */
  admit?(tenantId: string): 'ok' | 'stop';
}

export interface IdFactory {
  event(): string;
  worker(): string;
  subscription(): string;
  approval(): string;
  audit(): string;
}

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  stallAfterMs: 15 * 60_000,
  heartbeatAfterMs: 2 * 60_000,
  loopRepeat: 3,
  maxRestarts: 3,
  approvalTtlMs: 24 * 60 * 60_000,
};

export const LIVE_STATES: readonly WorkerState[] = [
  'spawning',
  'running',
  'sleeping',
  'waking',
  'awaiting_approval',
  'stuck',
  'crashed',
];

export function isLiveState(state: WorkerState): boolean {
  return (LIVE_STATES as readonly string[]).includes(state);
}

export function emptyUsage(): Usage {
  return { tokens: 0, usdMicros: 0, wallMs: 0 };
}

export function observeMandate(repos: string[], strength: Strength = 'inferred'): Mandate {
  return {
    policyVersion: POLICY_VERSION,
    scope: { repos },
    intensity: 'observe',
    authority: 'read-only',
    budgets: { usd: 5, tokens: 200_000, wallMs: 30 * 60_000 },
    strength,
  };
}

export function actMandate(repos: string[], strength: Strength = 'explicit'): Mandate {
  return {
    policyVersion: POLICY_VERSION,
    scope: { repos },
    intensity: 'act',
    authority: 'open-pr',
    budgets: { usd: 10, tokens: 400_000, wallMs: 60 * 60_000 },
    strength,
  };
}
