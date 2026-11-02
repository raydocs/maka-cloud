import type { SandboxPort } from './sandbox.js';

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
  'paused',
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
  /**
   * When true, mergeGate treats an empty Checks/Statuses list as green.
   * Scratch / no-CI repos only. Default is refuse (`no-checks` is not green).
   */
  allowNoCi?: boolean;
  /** Owner may pause this worker. Default true. Set false to refuse pause. */
  ownerPause?: boolean;
}

export interface Usage {
  tokens: number;
  usdMicros: number;
  wallMs: number;
  /** Messages API `usage.input_tokens` when a model call recorded them. */
  inputTokens?: number;
  /** Messages API `usage.output_tokens` when a model call recorded them. */
  outputTokens?: number;
}

export interface MemorySpill {
  id: string;
  at: number;
  text: string;
}

export interface WorkerRecord {
  workerId: string;
  tenantId: string;
  subject: Subject;
  state: WorkerState;
  generation: number;
  mandate: Mandate;
  memory: string;
  /** Older memory chunks spilled off the inline window. Stored in worker json (no schema bump). */
  spills: MemorySpill[];
  plan: string;
  transcriptPointer: string | null;
  sandboxRef: string | null;
  workspaceRef: string | null;
  lastEventId: string | null;
  lastProgressAt: number;
  lastHeartbeatAt: number;
  lastStepSignature: string | null;
  stepRepeats: number;
  /** W2 nudges already delivered. One nudge, then escalate. JSON only; no schema bump. */
  nudges?: number;
  /** Done is a claim until signals read back live. JSON only; no schema bump. */
  doneClaim?: import('./done.js').DoneClaim;
  /** CLEAR/BLOCK receipts pinned to a head SHA. JSON only; no schema bump. */
  reviewReceipts?: import('./review.js').ReviewReceipt[];
  pausedFrom?: WorkerState;
  /** Pause is recorded only after the worker is verified stopped. */
  pausedVerified?: boolean;
  lastLive?: { sha?: string; ci?: string; prMerged?: boolean; at: number };
  /** Named step plan + heartbeat. JSON only; no schema bump. */
  progress?: import('./progress.js').WorkerProgress;
  usage: Usage;
  evidence: EvidenceBlock[];
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

export type EvidenceKind = 'patch' | 'log' | 'artifact' | 'step' | 'test';

/** One proof line a worker may emit. Never a secret. */
export interface EvidenceBlock {
  kind: EvidenceKind;
  label: string;
  body: string;
  path?: string;
}

export interface TenantUsage {
  tenantId: string;
  tokens: number;
  usdMicros: number;
  wallMs: number;
  events: number;
}

export interface OrgSecretRef {
  tenantId: string;
  name: string;
}

export type OrgSecretDestination =
  | { kind: 'header'; name: string; headers?: Record<string, string> }
  | { kind: 'env'; name: string; env?: Record<string, string | undefined> };

export type OrgSecretResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'unknown' | 'refused' };

/** Interface only (P4). Never returns a raw secret. */
export interface OrgSecretPort {
  has(ref: OrgSecretRef): Promise<boolean>;
  inject(ref: OrgSecretRef, dest: OrgSecretDestination): Promise<OrgSecretResult>;
}

export interface ProposedAction {
  kind: ApprovalKind;
  boundText: string;
}

export interface HandlerResult {
  memory?: string;
  plan?: string;
  transcriptPointer?: string;
  workspaceRef?: string | null;
  sandboxRef?: string | null;
  progress?: boolean;
  stepSignature?: string;
  usage?: Partial<Usage>;
  evidence?: EvidenceBlock[];
  action?: ProposedAction;
  /** Mid-run phase / activity. Superagent persists it on the worker JSON. */
  progressUpdate?: import('./progress.js').ProgressPatch;
  /** Claim only. Superagent re-reads signals before retiring. */
  done?: import('./done.js').DoneClaim;
  /**
   * Forbidden. Workers have no outbound user channel. Superagent drops this
   * and audits `worker_outbound_refused`.
   */
  userMessage?: string;
}

export interface WorkerContext {
  worker: WorkerRecord;
  event: NormalizedEvent;
  sandbox: SandboxPort;
  orgSecrets: OrgSecretPort;
  /** Chain of Recall: spilled chunks plus the inline window. */
  recall: () => string;
  /**
   * Persist a phase / activity / waiting heartbeat. Not a user channel —
   * Superagent may speak through `LeadPort` after it writes the store.
   */
  reportProgress?: (patch: import('./progress.js').ProgressPatch) => Promise<void>;
  /**
   * Intentionally absent: workers have no outbound user channel.
   * `LeadPort.speak` lives on Superagent, never here.
   */
}

export interface WorkerHandler {
  handle(ctx: WorkerContext, event: NormalizedEvent): Promise<HandlerResult>;
}

export type RouterDecision =
  | { action: 'ignore'; reason: string; confidence?: number }
  | { action: 'answer'; text: string; confidence?: number }
  | { action: 'spawn'; mandate: Mandate; title: string; confidence?: number };

export interface JudgeLogEntry {
  at: number;
  eventType: string;
  action: 'ignore' | 'answer' | 'spawn';
  source: 'heuristic' | 'model' | 'prefilter';
  confidence?: number;
  reason?: string;
}

export interface RouterJudge {
  decide(event: NormalizedEvent, ctx: { workers: WorkerRecord[] }): Promise<RouterDecision>;
}

export interface AdmissionPolicy {
  allowActors?: string[];
  selfLogins?: string[];
  denyUnownedBots?: boolean;
  allowSources?: EventSource[];
  /** Live workers with a sandboxRef (or about to get one) allowed at once. */
  maxBoxes?: number;
  /** Tenant ledger cap in USD. Spawn is refused when usage already meets it. */
  spendCapUsd?: number;
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
  action: 'restart' | 'escalate' | 'retire' | 'stop' | 'nudge';
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
  'paused',
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
