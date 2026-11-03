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
  'stream_silence',
  'time_limit',
  'empty_turns',
  'repeat_tools',
  'box_stuck',
] as const;
export type WatchdogRule = (typeof WATCHDOG_RULES)[number];

export const AUTONOMY_RULES = [
  'stream_silence',
  'time_limit',
  'empty_turns',
  'repeat_tools',
] as const;
export type AutonomyRule = (typeof AUTONOMY_RULES)[number];

/** Factory Droid 1.0 bounded-autonomy defaults. */
export const DEFAULT_AUTONOMY = {
  streamSilenceMs: 4 * 60_000,
  timeLimitAttempts: 2,
  emptyTurnsStop: 3,
  identicalToolsNudge: 3,
  identicalToolsStop: 6,
  compactionSummaryTokens: 16_000,
} as const;

export type AutonomySettings = {
  streamSilenceMs: number;
  timeLimitAttempts: number;
  emptyTurnsStop: number;
  identicalToolsNudge: number;
  identicalToolsStop: number;
  compactionSummaryTokens: number;
};

export type AutonomyAction = 'continue' | 'retry' | 'nudge' | 'stop';

export interface AutonomyIncident {
  action: Exclude<AutonomyAction, 'continue'>;
  rule: AutonomyRule;
  detail: string;
  at: number;
  applied?: boolean;
}

/** Per-worker bounded-autonomy + cache counters. JSON only; no schema bump. */
export interface AutonomyState {
  emptyTurns: number;
  lastToolKey: string | null;
  lastToolResultHash: string | null;
  identicalToolRuns: number;
  timeLimitAttempts: number;
  streamRetries: number;
  cacheBreaks: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  lastIncident?: AutonomyIncident;
  pending?: AutonomyIncident;
}

export const TENANT_BOX_STATES = [
  'creating',
  'running',
  'suspending',
  'suspended',
  'resuming',
  'waking',
  'rebuilding',
  'gone',
] as const;
export type TenantBoxState = (typeof TENANT_BOX_STATES)[number];

/** One long-lived Instabox box per tenant. JSON on the store; no sqlite bump. */
export interface TenantBoxRecord {
  tenantId: string;
  boxId: string;
  state: TenantBoxState;
  snapshotId: string | null;
  vcpus: number;
  memMiB: number;
  activeWorkers: string[];
  idleSince: number | null;
  lastWakeAt: number | null;
  lastSuspendAt: number | null;
  lastCreateAt: number | null;
  lastRestoreAt: number | null;
  leaseHolder: string | null;
  leaseRenewedAt: number | null;
  /** Backstop only (default 7 days). Idle suspend is the normal path. */
  deleteAfterSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export const TENANT_BOX_PREFIX = '__tenant_box__:';

export function tenantBoxWorkerId(tenantId: string): string {
  return `${TENANT_BOX_PREFIX}${tenantId}`;
}

export function isTenantBoxWorkerId(workerId: string): boolean {
  return workerId.startsWith(TENANT_BOX_PREFIX);
}

/** Default shared-box size. Mandate may raise it; Instabox Pro allows 4/8192. */
export const DEFAULT_SHARED_BOX = { vcpus: 4, memMiB: 8192 } as const;
export const DEFAULT_WORKERS_PER_BOX = 4;
export const DEFAULT_IDLE_SUSPEND_MS = 5 * 60_000;
export const DEFAULT_BOX_LEASE_TTL_MS = 60_000;
export const DEFAULT_BOX_LEASE_RENEW_MS = 30_000;
export const DEFAULT_BOX_DELETE_AFTER_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_BOX_STUCK_AFTER_MS = 10 * 60_000;

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
  /** Shared-box size. Default 4 vCPU / 8192 MiB. */
  box?: { vcpus?: number; memMiB?: number };
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
  /** Bounded autonomy + prompt-cache counters. JSON only; no schema bump. */
  autonomy?: AutonomyState;
  /** Copy of the tenant box (JSON). Source of truth is SuperagentStore.tenantBox. */
  box?: TenantBoxRecord;
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
  /** Memory/tests: `autonomy_retry|nudge|stop`. Sqlite stores the numeric columns only. */
  kind?: string;
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
  /** Bounded-autonomy counters. Superagent persists them on the worker JSON. */
  autonomy?: AutonomyState;
  /** Stop / retry / nudge from the worker loop. Superagent records ledger + watchdog. */
  incident?: AutonomyIncident;
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

export interface RouterJudgeContext {
  workers: WorkerRecord[];
  /** Feedback few-shots and rule suggestions for a model Router. */
  fewShot?: string;
  suggestions?: string;
  /** Queued / running task titles for cross-task coordination. */
  queue?: string;
}

export interface RouterJudge {
  decide(event: NormalizedEvent, ctx: RouterJudgeContext): Promise<RouterDecision>;
}

export interface AdmissionPolicy {
  allowActors?: string[];
  selfLogins?: string[];
  denyUnownedBots?: boolean;
  allowSources?: EventSource[];
  /** Live workers with a sandboxRef (or about to get one) allowed at once. */
  maxBoxes?: number;
  /** Concurrent workers on one tenant box. Default 4 when sharedBox is on. */
  maxWorkersPerBox?: number;
  /** Tenant ledger cap in USD. Spawn is refused when usage already meets it. */
  spendCapUsd?: number;
}

export interface WatchdogSettings {
  stallAfterMs: number;
  heartbeatAfterMs: number;
  loopRepeat: number;
  maxRestarts: number;
  approvalTtlMs: number;
  autonomy: AutonomySettings;
}

export interface WatchdogFinding {
  rule: WatchdogRule;
  tenantId: string;
  workerId: string;
  action: 'restart' | 'escalate' | 'retire' | 'stop' | 'nudge' | 'retry';
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
  task(): string;
  decision(): string;
  merge(): string;
  card(): string;
}

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  stallAfterMs: 15 * 60_000,
  heartbeatAfterMs: 2 * 60_000,
  loopRepeat: 3,
  maxRestarts: 3,
  approvalTtlMs: 24 * 60 * 60_000,
  autonomy: { ...DEFAULT_AUTONOMY },
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

/** Reserved retired row that carries tenant box JSON through sqlite replay. */
export function tenantBoxAsWorker(box: TenantBoxRecord): WorkerRecord {
  const at = box.updatedAt;
  return {
    workerId: tenantBoxWorkerId(box.tenantId),
    tenantId: box.tenantId,
    subject: {
      kind: 'conversation',
      tenantId: box.tenantId,
      key: tenantBoxWorkerId(box.tenantId),
    },
    state: 'retired',
    generation: 1,
    mandate: observeMandate([]),
    memory: '',
    spills: [],
    plan: '',
    transcriptPointer: null,
    sandboxRef: box.boxId,
    workspaceRef: null,
    lastEventId: null,
    lastProgressAt: at,
    lastHeartbeatAt: at,
    lastStepSignature: null,
    stepRepeats: 0,
    box,
    usage: emptyUsage(),
    evidence: [],
    createdAt: box.createdAt,
    updatedAt: at,
    retiredAt: at,
  };
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
