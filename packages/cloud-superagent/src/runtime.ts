import type { IngestInput } from './events.js';
import { normalize } from './events.js';
import { defaultIds } from './ids.js';
import {
  addCard,
  bandOf,
  emptyEscalateState,
  heuristicScore,
  loadEscalate,
  parseEscalateState,
  parseScore,
  patchEscalate,
  pendingCards,
  recordBand,
  resolveCard,
  saveEscalate,
  scorePrompt,
  type CardOption,
  type DecisionCard,
  type EscalateState,
  type Thresholds,
  ESCALATE_DOCUMENT,
} from './escalate.js';
import {
  applyMerge,
  extractSignals,
  findFuzzy,
  findProgrammatic,
  liveTickets,
  loadGraph,
  mergePrompt,
  noteCollision,
  parseGraphState,
  parseMergeJudgement,
  saveGraph,
  setGraphMode,
  splitMerge,
  unionSignals,
  upsertTicket,
  type GraphState,
  type GraphTicket,
  DEFAULT_MERGE_MODE,
  GRAPH_DOCUMENT,
} from './event-graph.js';
import {
  belowSensitivity,
  bumpIntake,
  classifyDecision,
  defaultTenantRouterConfig,
  fewShotPrompt,
  parseIntakeState,
  parseRouterCommand,
  parseRouterConfig,
  patchRouterConfig,
  recordDecision,
  recordFeedback,
  suggestedRuleLines,
  strengthFor,
  fastPathDrop,
  type IntakeState,
  type RouterClass,
  type RouterMode,
  type TenantRouterConfig,
  INTAKE_DOCUMENT,
  ROUTER_DOCUMENT,
} from './intake.js';
import { appendRecall, followRecallInStore, type RecallQuery } from './recall-chain.js';
import { admit, admitSpawn, HeuristicJudge, isStatusAsk, type JudgeClient } from './router.js';
import {
  estimateFootprint,
  estimatePriority,
  estimateSize,
  isHumanEvent,
  mergeSettings,
  Scheduler,
  type ScheduledTask,
  type ScheduledTaskState,
  type SchedulerSettings,
  type StartCondition,
  type TaskDependency,
  type TaskPriority,
  type TaskSize,
  waitMsOf,
} from './scheduler.js';
import { overBudget, Safety } from './safety.js';
import type { SuperagentStore } from './store.js';
import { MemorySuperagentStore } from './memory-store.js';
import {
  DEFAULT_AUTONOMY,
  emptyUsage,
  isLiveState,
  observeMandate,
  tenantBoxAsWorker,
  type AutonomyIncident,
  type AutonomySettings,
  type NormalizedEvent,
  type WorkerContext,
  type WorkerRecord,
  type WorkerState,
} from './types.js';

function setState(worker: WorkerRecord, state: WorkerState): void {
  worker.state = state;
}
import {
  DEFAULT_WATCHDOG,
  type AdmissionPolicy,
  type HandlerResult,
  type IdFactory,
  type MeteringHooks,
  type OrgSecretPort,
  type RouterJudge,
  type WatchdogFinding,
  type WatchdogSettings,
  type WorkerHandler,
} from './types.js';
import { mergeEvidence } from './evidence.js';
import { defaultDoneWorld, verifyDone, type DoneWorld } from './done.js';
import { formatLeadReport, freshnessOf, type LiveFacts } from './freshness.js';
import {
  applyProgressPatch,
  DEFAULT_PROGRESS,
  formatLeadProgress,
  formatProgressLine,
  nextLeadKind,
  startProgress,
  statusSnapshotOf,
  viewOf,
  type ProgressPatch,
  type ProgressSettings,
  type StatusSnapshot,
} from './progress.js';
import { SilentLead, workerOutboundText, type LeadPort } from './lead.js';
import { parseMergeBound } from './loop.js';
import { boxLooksRunning, isPauseActive, resumeState } from './pause.js';
import {
  hasClearReceipt,
  prRef,
  receiptFromReview,
  type ReviewReceipt,
  type ReviewerPort,
} from './review.js';
import { BoxPool } from './box-pool.js';
import { FakeSandbox, type SandboxPort } from './sandbox.js';
import { UnconfiguredOrgSecrets } from './secrets.js';
import {
  DefaultExecutionResolver,
  type ExecutionNeed,
  type ExecutionTargetResolver,
} from './execution-target.js';
import { DeviceOfflineError, type ByomHub } from './byom.js';
import { recallMemory, spillMemory } from './spill.js';
import {
  DEFAULT_SPECULATIVE,
  admitSpeculative,
  compareWorkerPriority,
  isSpeculativeShadow,
  isUnacceptedSpeculative,
  markSpeculativeReady,
  matchSpeculativeTrigger,
  snapshotSpeculativeCost,
  speculativeMandate,
  type SpeculativeCleanup,
  type SpeculativeSettings,
} from './speculative.js';
import { AUTONOMY_LEDGER_KIND, autonomyUsage, emptyAutonomy, markApplied } from './autonomy.js';

import { type StuckCard, stuckCardOf } from './stuck.js';
import { DUPLEX_ACK, isPreemptEvent, rememberEventIds } from './duplex.js';
import { runWatchdog } from './watchdog.js';
import {
  DEFAULT_LEARNING,
  formatLessonPrefix,
  isWatchdogCorrectAction,
  learningSettingsFrom,
  lessonAuditDetail,
  LessonBook,
  proposalAuditDetail,
  recallWithLessons,
  reviewBounceOf,
  stripLessonPrefix,
  type LearningSettings,
  type LessonRecord,
  type SkillProposal,
} from './lessons.js';
import {
  DEFAULT_PEER_REVIEW,
  peerReviewSettingsFrom,
  runPeerReview,
  type PeerReviewInput,
  type PeerReviewOutcome,
  type PeerReviewSettings,
} from './peer-review.js';
import {
  answerWatchdog,
  collectWatchdogContext,
  commandRefusedAsk,
  formatWatchdogAnswer,
  parseWatchdogText,
  type WatchdogActionResult,
  type WatchdogAnswer,
  type WatchdogNarrator,
} from './watchdog-query.js';

export type IngestResult =
  | { result: 'rejected'; reason: string; judgeCalls: 0 }
  | { result: 'duplicate'; eventId: string; judgeCalls: 0 }
  | { result: 'ignored'; reason: string; eventId?: string; judgeCalls: number }
  | { result: 'passthrough'; eventId: string; workerIds: string[]; judgeCalls: 0 }
  | { result: 'answered'; eventId: string; text: string; judgeCalls: number }
  | { result: 'spawned'; eventId: string; workerId: string; judgeCalls: number }
  | { result: 'speculative'; eventId: string; workerId: string; judgeCalls: 0 }
  | {
      result: 'queued';
      eventId: string;
      taskId: string;
      state: ScheduledTaskState;
      reason: string;
      waitMs: number;
      judgeCalls: number;
    }
  | {
      result: 'would_accept';
      eventId: string;
      classification: RouterClass;
      reason: string;
      confidence: number;
      judgeCalls: number;
    }
  | {
      result: 'merged';
      eventId: string;
      workerIds: string[];
      ticketId: string;
      mergeId: string;
      reason: string;
      judgeCalls: 0;
    }
  | {
      result: 'would_merge';
      eventId: string;
      ticketId: string;
      mergeId: string;
      reason: string;
      judgeCalls: number;
    }
  | { result: 'archived'; eventId: string; reason: string; band: 'low'; judgeCalls: number }
  | {
      result: 'escalated';
      eventId: string;
      cardId: string;
      band: 'high';
      reason: string;
      judgeCalls: number;
    };

/** Collapse a worker inbox into one event. Preempt, then approval, then latest. */
function handledIdsOf(event: NormalizedEvent): string[] {
  return [event.eventId, event.idempotencyKey];
}

export function coalesceInbox(events: NormalizedEvent[]): NormalizedEvent {
  if (events.length === 0) throw new Error('coalesceInbox needs events');
  const first = events[0];
  if (events.length === 1 && first) return first;
  const preempt = [...events].reverse().find(isPreemptEvent);
  const approval = [...events].reverse().find((row) => row.type === 'approval_granted');
  const primary = preempt ?? approval ?? events[events.length - 1] ?? first;
  if (!primary) throw new Error('coalesceInbox needs events');
  return {
    ...primary,
    summary: `${events.length} events: ${events.map((row) => row.type).join(', ')}`,
    fields: [
      ...primary.fields,
      ['coalesced', String(events.length)],
      ['coalescedTypes', events.map((row) => row.type).join(',')],
      ['coalescedIds', events.map((row) => row.eventId).join(',')],
    ],
  };
}

export class SilentHandler implements WorkerHandler {
  async handle(): Promise<HandlerResult> {
    return { progress: true };
  }
}

export class RecordingHandler implements WorkerHandler {
  readonly events: NormalizedEvent[] = [];
  script: (event: NormalizedEvent, worker: WorkerRecord) => HandlerResult | Promise<HandlerResult> =
    () => ({ progress: true });

  async handle(
    ctx: { worker: WorkerRecord; event: NormalizedEvent },
    event: NormalizedEvent,
  ): Promise<HandlerResult> {
    this.events.push(event);
    return this.script(event, ctx.worker);
  }
}

export interface SuperagentOptions {
  store?: SuperagentStore;
  judge?: RouterJudge;
  handler?: WorkerHandler;
  clock?: () => number;
  ids?: IdFactory;
  admission?: AdmissionPolicy;
  watchdog?: Partial<WatchdogSettings>;
  metering?: MeteringHooks;
  /** Host turns escalate/stop findings into a T33 stuck card. */
  onEscalate?: (card: StuckCard) => void;
  /** Interface + local/env implementation. Default refuses every inject. */
  orgSecrets?: OrgSecretPort;
  /** Instabox (or FakeSandbox). Sleep may suspend; wake calls ensureRunning. */
  sandbox?: SandboxPort;
  /** Default box id stored on new workers when the host has one machine. */
  sandboxRef?: string;
  /** Only the lead speaks to the human. Never injected into WorkerContext. */
  lead?: LeadPort;
  /** Fresh non-interactive reviewer. Missing VERDICT means no receipt. */
  reviewer?: ReviewerPort;
  /** Live readers for Done signals. Tests inject a fake world. */
  doneWorld?: DoneWorld;
  /** Re-read PR/CI for lead reports. Cached worker memory is not enough. */
  liveFacts?: (worker: WorkerRecord) => Promise<Partial<LiveFacts>>;
  /** Phase-change / still / looks-stuck cadence. Quiet otherwise. */
  progress?: Partial<ProgressSettings>;
  /**
   * Mistake book. Default off. Host passes this; the constructor never
   * reads environment variables.
   */
  learning?: Partial<LearningSettings> | LearningSettings;
  /**
   * Cross-model review before push / open-PR. Default off. Host passes
   * this; the constructor never reads environment variables.
   */
  peerReview?: Partial<PeerReviewSettings> | PeerReviewSettings;
  /** Cheap watchdog narrator. Absent → deterministic fallback. */
  watchdogNarrator?: WatchdogNarrator;
  /** Speculative attempts. Default off. */
  speculative?: Partial<SpeculativeSettings>;
  /** Optional cleanup of worktree/box state when a speculative run is discarded. */
  speculativeCleanup?: SpeculativeCleanup;
  /** BYOM hub. Default unset (disabled). */
  byom?: ByomHub;
  /** Instabox vs paired device. Default is Instabox only. */
  targets?: ExecutionTargetResolver;
  /**
   * Ingest default is `auto` so existing tests keep spawning. New persisted
   * tenant configs default to `observe` (`defaultTenantRouterConfig`).
   */
  router?: { mode?: RouterMode; sensitivity?: number };
  scheduler?: Partial<SchedulerSettings>;
  intake?: { maxUnownedPerMinute?: number };
  /** Merge default is observe: record a suggestion, do not attach. */
  merge?: { mode?: RouterMode };
  /** Scoring is off unless enabled. Thresholds stay configurable. */
  escalate?: { enabled?: boolean; thresholds?: Partial<Thresholds> };
  mergeClient?: JudgeClient;
  scoreClient?: JudgeClient;
  /** Stream silence / repeat / compaction thresholds. */
  autonomy?: Partial<AutonomySettings>;
  /**
   * One long-lived box per tenant, many workers via git worktrees.
   * Off by default so existing one-ref tests stay on the old suspend path.
   */
  sharedBox?: boolean;
  boxPool?: BoxPool;
}

export class Superagent {
  readonly store: SuperagentStore;
  readonly judge: RouterJudge;
  readonly handler: WorkerHandler;
  readonly ids: IdFactory;
  readonly admission: AdmissionPolicy;
  readonly watchdogSettings: WatchdogSettings;
  readonly metering: MeteringHooks;
  readonly safety: Safety;
  readonly orgSecrets: OrgSecretPort;
  readonly sandbox: SandboxPort;
  readonly boxPool: BoxPool | undefined;
  readonly lead: LeadPort;
  readonly reviewer: ReviewerPort | undefined;
  readonly doneWorld: DoneWorld;
  readonly progressSettings: ProgressSettings;
  readonly learning: LearningSettings;
  readonly peerReview: PeerReviewSettings;
  readonly lessonsBook: LessonBook;
  readonly speculativeSettings: SpeculativeSettings;
  readonly byom: ByomHub | undefined;
  readonly targets: ExecutionTargetResolver;
  private readonly speculativeCleanup?: SpeculativeCleanup;
  readonly scheduler: Scheduler;
  readonly routerDefaults: { mode: RouterMode; sensitivity?: number };
  readonly intakeLimits: { maxUnownedPerMinute?: number };
  readonly mergeDefaults: { mode: RouterMode };
  readonly escalateDefaults: { enabled: boolean; thresholds?: Partial<Thresholds> };
  readonly mergeClient: JudgeClient | undefined;
  readonly scoreClient: JudgeClient | undefined;
  private readonly liveFacts?: (worker: WorkerRecord) => Promise<Partial<LiveFacts>>;
  readonly escalations: StuckCard[] = [];
  /** Timer-loop findings the conversational watchdog can cite. */
  readonly incidents: WatchdogFinding[] = [];
  judgeCalls = 0;
  private readonly now: () => number;
  private readonly onEscalate?: (card: StuckCard) => void;
  private readonly defaultSandboxRef: string | null;
  private readonly watchdogNarrator?: WatchdogNarrator;
  private readonly draining = new Set<string>();
  private readonly duplexWaiters = new Map<string, Set<() => void>>();

  constructor(options: SuperagentOptions = {}) {
    this.store = options.store ?? new MemorySuperagentStore();
    this.judge = options.judge ?? new HeuristicJudge();
    this.handler = options.handler ?? new SilentHandler();
    this.ids = options.ids ?? defaultIds();
    this.now = options.clock ?? Date.now;
    this.admission = options.admission ?? {};
    this.watchdogSettings = {
      ...DEFAULT_WATCHDOG,
      ...options.watchdog,
      autonomy: {
        ...DEFAULT_AUTONOMY,
        ...options.watchdog?.autonomy,
        ...options.autonomy,
      },
    };
    this.metering = options.metering ?? { record() {} };
    this.safety = new Safety(this.store, this.ids, this.watchdogSettings.approvalTtlMs);
    this.onEscalate = options.onEscalate;
    this.orgSecrets = options.orgSecrets ?? new UnconfiguredOrgSecrets();
    this.sandbox = options.sandbox ?? new FakeSandbox();
    this.defaultSandboxRef = options.sandboxRef ?? null;
    this.boxPool =
      options.boxPool ??
      (options.sharedBox
        ? new BoxPool({
            sandbox: this.sandbox,
            store: this.store,
            now: this.now,
            maxWorkers: this.admission.maxWorkersPerBox,
            recordUsage: (entry) => this.metering.record(entry),
          })
        : undefined);
    this.boxPool?.setProgressReporter(async (tenantId, workerId, patch) => {
      const worker = this.store.worker(tenantId, workerId);
      if (worker) await this.recordProgress(worker, patch, this.now());
    });
    this.lead = options.lead ?? new SilentLead();
    this.reviewer = options.reviewer;
    this.doneWorld = defaultDoneWorld(options.doneWorld ?? {});
    this.progressSettings = { ...DEFAULT_PROGRESS, ...options.progress };
    this.liveFacts = options.liveFacts;
    this.learning = options.learning ? learningSettingsFrom(options.learning) : DEFAULT_LEARNING;
    this.peerReview = options.peerReview
      ? peerReviewSettingsFrom(options.peerReview)
      : DEFAULT_PEER_REVIEW;
    this.lessonsBook = new LessonBook();
    this.watchdogNarrator = options.watchdogNarrator;
    this.speculativeSettings = { ...DEFAULT_SPECULATIVE, ...options.speculative };
    if (options.speculative?.triggers) {
      this.speculativeSettings.triggers = options.speculative.triggers;
    }
    this.speculativeCleanup = options.speculativeCleanup;
    this.byom = options.byom;
    this.targets =
      options.targets ??
      new DefaultExecutionResolver(this.sandbox, this.defaultSandboxRef, options.byom);
    this.routerDefaults = {
      mode: options.router?.mode ?? 'auto',
      sensitivity: options.router?.sensitivity,
    };
    this.intakeLimits = { ...options.intake };
    this.mergeDefaults = { mode: options.merge?.mode ?? DEFAULT_MERGE_MODE };
    this.escalateDefaults = {
      enabled: options.escalate?.enabled === true,
      ...(options.escalate?.thresholds ? { thresholds: options.escalate.thresholds } : {}),
    };
    this.mergeClient = options.mergeClient;
    this.scoreClient = options.scoreClient;
    this.scheduler = new Scheduler(
      this.store,
      this.ids,
      this.now,
      mergeSettings(options.scheduler),
      (change) => {
        this.audit(change.tenantId, null, `scheduler_${change.state}`, change.at, {
          taskId: change.taskId,
          reason: change.reason ?? '',
          waitMs: change.waitMs,
        });
      },
    );
  }

  ledger(tenantId: string) {
    return this.store.tenantUsage(tenantId);
  }

  lessons(tenantId: string): LessonRecord[] {
    this.hydrateLessons(tenantId);
    return this.lessonsBook.list(tenantId);
  }

  lessonDocument(tenantId: string, repo = 'tenant'): string {
    this.hydrateLessons(tenantId);
    return this.lessonsBook.document(tenantId, repo);
  }

  proposals(tenantId: string): SkillProposal[] {
    this.hydrateLessons(tenantId);
    return this.lessonsBook.proposals(tenantId);
  }

  distillLessons(
    tenantId: string,
    repo = 'tenant',
  ): { document: string; proposals: SkillProposal[]; groups: number } {
    this.hydrateLessons(tenantId);
    const at = this.now();
    const result = this.lessonsBook.distill(tenantId, repo, at);
    for (const proposal of result.proposals) {
      this.audit(tenantId, null, 'lesson_proposed', at, {
        ...proposalAuditDetail(proposal, { document: result.document, scope: repo }),
      });
    }
    return result;
  }

  acceptLesson(
    tenantId: string,
    lessonId: string,
  ): { ok: true; lesson: LessonRecord } | { ok: false; reason: string } {
    this.hydrateLessons(tenantId);
    const lesson = this.lessonsBook.setStatus(tenantId, lessonId, 'accepted');
    if (!lesson) return { ok: false, reason: 'unknown_lesson' };
    const at = this.now();
    this.audit(tenantId, lesson.workerId, 'lesson_accepted', at, {
      lessonId,
      status: 'accepted',
    });
    return { ok: true, lesson };
  }

  rejectLesson(
    tenantId: string,
    lessonId: string,
  ): { ok: true; lesson: LessonRecord } | { ok: false; reason: string } {
    this.hydrateLessons(tenantId);
    const lesson = this.lessonsBook.setStatus(tenantId, lessonId, 'rejected');
    if (!lesson) return { ok: false, reason: 'unknown_lesson' };
    const at = this.now();
    this.audit(tenantId, lesson.workerId, 'lesson_rejected', at, {
      lessonId,
      status: 'rejected',
    });
    return { ok: true, lesson };
  }

  acceptProposal(
    tenantId: string,
    proposalId: string,
  ): { ok: true; proposal: SkillProposal } | { ok: false; reason: string } {
    this.hydrateLessons(tenantId);
    const proposal = this.lessonsBook.setProposalStatus(tenantId, proposalId, 'accepted');
    if (!proposal) return { ok: false, reason: 'unknown_proposal' };
    const at = this.now();
    this.audit(tenantId, null, 'lesson_accepted', at, {
      proposalId,
      status: 'accepted',
      applied: false,
    });
    return { ok: true, proposal };
  }

  rejectProposal(
    tenantId: string,
    proposalId: string,
  ): { ok: true; proposal: SkillProposal } | { ok: false; reason: string } {
    this.hydrateLessons(tenantId);
    const proposal = this.lessonsBook.setProposalStatus(tenantId, proposalId, 'rejected');
    if (!proposal) return { ok: false, reason: 'unknown_proposal' };
    const at = this.now();
    this.audit(tenantId, null, 'lesson_rejected', at, {
      proposalId,
      status: 'rejected',
    });
    return { ok: true, proposal };
  }

  recallLesson(tenantId: string, lessonId: string): string | undefined {
    this.hydrateLessons(tenantId);
    return this.lessonsBook.recall(tenantId, lessonId);
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const at = this.now();
    const normalized = normalize(input, at);
    if (!normalized.ok) return { result: 'rejected', reason: normalized.reason, judgeCalls: 0 };
    const event: NormalizedEvent = { ...normalized.event, eventId: this.ids.event() };
    const stored = this.store.putEvent(event);
    if (stored === 'duplicate') {
      const existing = this.store.eventByIdempotency(event.tenantId, event.idempotencyKey);
      this.recordIntake(
        event.tenantId,
        {
          layer: 'fast',
          reason: 'duplicate',
          kind: 'drop',
        },
        [event.idempotencyKey],
        at,
      );
      this.audit(event.tenantId, null, 'duplicate', at, {
        key: event.idempotencyKey,
        layer: 'fast',
      });
      return { result: 'duplicate', eventId: existing?.eventId ?? event.eventId, judgeCalls: 0 };
    }
    this.scheduler.noteEvent(event);
    if (event.type === 'ping' || event.subject === null) {
      const reason = event.type === 'ping' ? 'ping' : 'no_subject';
      this.recordIntake(
        event.tenantId,
        { layer: 'fast', reason, kind: 'drop' },
        handledIdsOf(event),
        at,
      );
      this.audit(event.tenantId, null, 'ignored', at, { reason, layer: 'fast' });
      return { result: 'ignored', reason, eventId: event.eventId, judgeCalls: 0 };
    }

    const subscribers = this.store.liveSubscribers(event.tenantId, event.subject.key);
    if (isStatusAsk(event)) {
      const owned =
        this.store.liveWorkerBySubject(event.tenantId, event.subject.key) ??
        (subscribers[0] ? this.store.worker(event.tenantId, subscribers[0].workerId) : undefined);
      if (owned) {
        const reported = await this.reportToLead(event.tenantId, owned.workerId);
        if (reported.ok) {
          this.linkRecall(event.tenantId, {
            triggerId: event.eventId,
            threadId: event.subject.key,
            workerId: owned.workerId,
            layer: 'passthrough',
            at,
          });
          this.audit(event.tenantId, owned.workerId, 'answered', at, { reason: 'status' });
          return {
            result: 'answered',
            eventId: event.eventId,
            text: reported.text,
            judgeCalls: 0,
          };
        }
      }
    }
    if (subscribers.length > 0) {
      const workerIds: string[] = [];
      for (const sub of subscribers) {
        this.store.enqueue(sub.workerId, event.eventId, at);
        if (this.draining.has(sub.workerId)) {
          await this.ackDuplexArrival(event.tenantId, sub.workerId, event, at);
          this.notifyDuplex(sub.workerId);
        } else {
          await this.drain(event.tenantId, sub.workerId);
        }
        workerIds.push(sub.workerId);
        this.linkRecall(event.tenantId, {
          triggerId: event.eventId,
          threadId: event.subject.key,
          workerId: sub.workerId,
          layer: 'passthrough',
          at,
        });
      }
      this.recordIntake(
        event.tenantId,
        { layer: 'passthrough', reason: 'subscribed', kind: 'passthrough' },
        handledIdsOf(event),
        at,
      );
      this.audit(event.tenantId, workerIds[0] ?? null, 'passthrough', at, {
        eventId: event.eventId,
        workers: workerIds.length,
        layer: 'passthrough',
        threadId: event.subject.key,
      });
      await this.admitTenant(event.tenantId);
      return { result: 'passthrough', eventId: event.eventId, workerIds, judgeCalls: 0 };
    }

    const speculated = await this.considerSpeculative(event, at);
    if (speculated) return speculated;

    const merged = await this.tryMerge(event, at);
    if (merged) return merged;

    const intake = this.intakeState(event.tenantId);
    const routerCfg = this.routerConfig(event.tenantId);

    const meter = this.metering.admit?.(event.tenantId) === 'stop';
    const fast = fastPathDrop({
      event,
      policy: this.admission,
      meteringStop: meter,
      rules: routerCfg.rules,
      mode: this.effectiveRouterMode(event.tenantId),
      handledIds: intake.handledIds,
      slowAt: intake.slowAt,
      maxUnownedPerMinute: this.intakeLimits.maxUnownedPerMinute,
      now: at,
    });
    if (fast.drop) {
      this.recordIntake(
        event.tenantId,
        { layer: 'fast', reason: fast.reason, kind: 'drop' },
        handledIdsOf(event),
        at,
      );
      this.audit(event.tenantId, null, 'filtered', at, { reason: fast.reason, layer: 'fast' });
      await this.admitTenant(event.tenantId);
      return { result: 'ignored', reason: fast.reason, eventId: event.eventId, judgeCalls: 0 };
    }

    const scored = await this.tryEscalate(event, at);
    if (scored) return scored;

    this.judgeCalls += 1;
    this.recordIntake(event.tenantId, { layer: 'slow', reason: 'call', kind: 'call' }, [], at);
    const decision = await this.judge.decide(event, {
      workers: this.store.workers(event.tenantId),
      fewShot: fewShotPrompt(routerCfg),
      suggestions: suggestedRuleLines(routerCfg),
      queue: this.scheduler
        .tasks(event.tenantId)
        .filter((row) => row.state !== 'done')
        .map((row) => `${row.taskId} ${row.state} ${row.title}`)
        .join('\n'),
    });
    const classified = classifyDecision(event, decision);
    const decisionId = this.ids.decision();
    this.linkRecall(event.tenantId, {
      triggerId: event.eventId,
      threadId: event.subject.key,
      workerId: null,
      decisionId,
      layer: 'slow',
      at,
    });

    if (
      decision.action === 'ignore' ||
      (classified.class === 'not_accepted' &&
        decision.action !== 'answer' &&
        decision.action !== 'spawn')
    ) {
      this.rememberDecision(event.tenantId, {
        decisionId,
        at,
        eventId: event.eventId,
        class: classified.class,
        action: 'ignore',
        confidence: classified.confidence,
        reason: classified.reason,
        mode: this.effectiveRouterMode(event.tenantId),
        summary: event.summary,
      });
      this.recordIntake(
        event.tenantId,
        { layer: 'slow', reason: classified.reason, kind: 'drop' },
        handledIdsOf(event),
        at,
      );
      this.audit(event.tenantId, null, 'ignored', at, {
        reason: classified.reason,
        layer: 'slow',
        decisionId,
      });
      return {
        result: 'ignored',
        reason: classified.reason,
        eventId: event.eventId,
        judgeCalls: 1,
      };
    }
    if (decision.action === 'answer') {
      this.rememberDecision(event.tenantId, {
        decisionId,
        at,
        eventId: event.eventId,
        class: classified.class,
        action: 'answer',
        confidence: classified.confidence,
        reason: classified.reason,
        mode: this.effectiveRouterMode(event.tenantId),
        summary: event.summary,
      });
      await this.lead.speak({ tenantId: event.tenantId, text: decision.text });
      this.audit(event.tenantId, null, 'answered', at, { layer: 'slow', decisionId });
      return { result: 'answered', eventId: event.eventId, text: decision.text, judgeCalls: 1 };
    }

    if (belowSensitivity(classified, routerCfg.sensitivity)) {
      this.rememberDecision(event.tenantId, {
        decisionId,
        at,
        eventId: event.eventId,
        class: 'not_accepted',
        action: 'ignore',
        confidence: classified.confidence,
        reason: 'below_sensitivity',
        mode: this.effectiveRouterMode(event.tenantId),
        summary: event.summary,
      });
      this.recordIntake(
        event.tenantId,
        { layer: 'slow', reason: 'below_sensitivity', kind: 'drop' },
        handledIdsOf(event),
        at,
      );
      this.audit(event.tenantId, null, 'ignored', at, {
        reason: 'below_sensitivity',
        layer: 'slow',
        decisionId,
      });
      return {
        result: 'ignored',
        reason: 'below_sensitivity',
        eventId: event.eventId,
        judgeCalls: 1,
      };
    }

    if (this.effectiveRouterMode(event.tenantId) === 'observe') {
      this.rememberDecision(event.tenantId, {
        decisionId,
        at,
        eventId: event.eventId,
        class: classified.class,
        action: 'would_accept',
        confidence: classified.confidence,
        reason: classified.reason,
        mode: 'observe',
        summary: event.summary,
      });
      this.recordIntake(
        event.tenantId,
        { layer: 'slow', reason: 'would_accept', kind: 'would_accept' },
        handledIdsOf(event),
        at,
      );
      this.audit(event.tenantId, null, 'would_accept', at, {
        reason: classified.reason,
        decisionId,
        class: classified.class,
        confidence: classified.confidence,
      });
      return {
        result: 'would_accept',
        eventId: event.eventId,
        classification: classified.class,
        reason: classified.reason,
        confidence: classified.confidence,
        judgeCalls: 1,
      };
    }

    const existing = this.store.liveWorkerBySubject(event.tenantId, event.subject.key);
    if (existing && !isSpeculativeShadow(existing)) {
      return {
        result: 'ignored',
        reason: 'already_owned',
        eventId: event.eventId,
        judgeCalls: 1,
      };
    }

    const boxedLive = this.boxPool
      ? this.store.allTenantBoxes().length
      : this.store.allWorkers().filter((row) => isLiveState(row.state) && row.sandboxRef).length;
    const spawnGate = admitSpawn({
      boxedLive,
      wouldBox: Boolean(this.boxPool || this.defaultSandboxRef),
      tenantUsdMicros: this.store.tenantUsage(event.tenantId).usdMicros,
      policy: this.admission,
      sharedBox: Boolean(this.boxPool),
      tenantBoxWorkers: this.store
        .workers(event.tenantId)
        .filter((row) => isLiveState(row.state) && row.sandboxRef).length,
      wouldCreateTenantBox: this.store.tenantBox(event.tenantId) === undefined,
    });
    if (!spawnGate.ok && spawnGate.reason === 'worker_cap') {
      return {
        result: 'ignored',
        reason: spawnGate.reason,
        eventId: event.eventId,
        judgeCalls: 1,
      };
    }
    const reserved = isHumanEvent(event);
    const task = this.scheduler.enqueue({
      tenantId: event.tenantId,

      eventId: event.eventId,
      subject: event.subject,
      title: decision.title,
      mandate: strengthFor(classified, decision.mandate),
      priority: estimatePriority(event, reserved),
      size: estimateSize(event),
      footprint: estimateFootprint(event, decision.mandate),
      reserved,
      source: event.source,
    });
    this.registerTicket(event, { taskId: task.taskId, workerId: task.workerId });
    this.rememberDecision(event.tenantId, {
      decisionId,
      at,
      eventId: event.eventId,
      class: classified.class,
      action: 'spawn',
      confidence: classified.confidence,
      reason: classified.reason,
      mode: this.effectiveRouterMode(event.tenantId),
      summary: event.summary,
    });
    this.linkRecall(event.tenantId, {
      triggerId: event.eventId,
      threadId: event.subject.key,
      workerId: null,
      taskId: task.taskId,
      decisionId,
      layer: 'slow',
      at,
    });
    await this.admitTenant(event.tenantId);
    const live = this.scheduler.task(event.tenantId, task.taskId);
    if (live) this.noteTaskCollision(event.tenantId, live);
    if (live?.workerId && (live.state === 'running' || live.state === 'done')) {
      this.recordIntake(
        event.tenantId,
        { layer: 'slow', reason: 'spawn', kind: 'accept' },
        handledIdsOf(event),
        at,
      );
      return {
        result: 'spawned',
        eventId: event.eventId,
        workerId: live.workerId,
        judgeCalls: 1,
      };
    }
    this.recordIntake(
      event.tenantId,
      { layer: 'slow', reason: live?.reason ?? 'queued', kind: 'accept' },
      handledIdsOf(event),
      at,
    );
    return {
      result: 'queued',
      eventId: event.eventId,
      taskId: task.taskId,
      state: live?.state ?? 'queued',
      reason: live?.reason ?? 'queued',
      waitMs: live ? waitMsOf(live, at) : 0,
      judgeCalls: 1,
    };
  }

  worker(tenantId: string, workerId: string): WorkerRecord | undefined {
    return this.store.worker(tenantId, workerId);
  }

  workers(tenantId: string): WorkerRecord[] {
    return this.store.workers(tenantId);
  }

  statusSnapshot(tenantId?: string): StatusSnapshot {
    const snap = statusSnapshotOf(
      this.store,
      this.now(),
      this.progressSettings,
      this.watchdogSettings,
      tenantId,
    );
    const queue =
      tenantId === undefined ? this.scheduler.allViews(this.now()) : this.scheduler.views(tenantId);
    const intake = tenantId ? this.intakeMetrics(tenantId) : undefined;
    const decisions = tenantId ? pendingCards(this.escalateState(tenantId)) : undefined;
    return {
      ...snap,
      queue,
      ...(intake ? { intake } : {}),
      ...(decisions && decisions.length > 0 ? { decisions } : {}),
    };
  }

  routerConfig(tenantId: string): TenantRouterConfig {
    return parseRouterConfig(this.store.getDocument(tenantId, ROUTER_DOCUMENT), tenantId);
  }

  effectiveRouterMode(tenantId: string): RouterMode {
    const stored = this.store.getDocument(tenantId, ROUTER_DOCUMENT);
    if (stored) return parseRouterConfig(stored, tenantId).mode;
    return this.routerDefaults.mode;
  }

  ensureRouterConfig(tenantId: string): TenantRouterConfig {
    const existing = this.store.getDocument(tenantId, ROUTER_DOCUMENT);
    if (existing) return parseRouterConfig(existing, tenantId);
    const created = defaultTenantRouterConfig(tenantId);
    this.store.putDocument(tenantId, ROUTER_DOCUMENT, JSON.stringify(created), this.now());
    return created;
  }

  setRouterConfig(
    tenantId: string,
    patch: Partial<Pick<TenantRouterConfig, 'mode' | 'sensitivity' | 'rules' | 'models'>>,
  ): TenantRouterConfig {
    const next = patchRouterConfig(this.routerConfig(tenantId), patch);
    this.store.putDocument(tenantId, ROUTER_DOCUMENT, JSON.stringify(next), this.now());
    return next;
  }

  intakeMetrics(tenantId: string) {
    return this.intakeState(tenantId).metrics;
  }

  followRecall(tenantId: string, query: RecallQuery) {
    return followRecallInStore(this.store, tenantId, query);
  }

  queueOf(tenantId: string) {
    return this.scheduler.views(tenantId);
  }

  recordRouterFeedback(
    tenantId: string,
    input: { decisionId: string; verdict: 'correct' | 'wrong'; note?: string },
  ) {
    const at = this.now();
    const next = recordFeedback(this.routerConfig(tenantId), {
      id: this.ids.decision(),
      at,
      decisionId: input.decisionId,
      verdict: input.verdict,
      ...(input.note ? { note: input.note } : {}),
    });
    this.store.putDocument(tenantId, ROUTER_DOCUMENT, JSON.stringify(next), at);
    this.audit(tenantId, null, 'router_feedback', at, {
      decisionId: input.decisionId,
      verdict: input.verdict,
    });
    return next;
  }

  handleRouterCommand(tenantId: string, text: string) {
    const parsed = parseRouterCommand(text);
    if (!parsed) return { ok: false as const, reason: 'unknown_command' };
    if (parsed.kind === 'feedback') {
      return {
        ok: true as const,
        config: this.recordRouterFeedback(tenantId, parsed),
      };
    }
    if (parsed.kind === 'mode') {
      return { ok: true as const, config: this.setRouterConfig(tenantId, { mode: parsed.mode }) };
    }
    return {
      ok: true as const,
      config: this.setRouterConfig(tenantId, { sensitivity: parsed.value }),
    };
  }

  graphOf(tenantId: string): GraphState {
    return this.syncGraph(tenantId);
  }

  mergeMode(tenantId: string): RouterMode {
    const stored = this.store.getDocument(tenantId, GRAPH_DOCUMENT);
    if (stored) {
      const parsed = parseGraphState(stored);
      if (parsed.modePinned) return parsed.mode;
    }
    return this.mergeDefaults.mode;
  }

  ensureMergeConfig(tenantId: string): GraphState {
    const existing = this.store.getDocument(tenantId, GRAPH_DOCUMENT);
    if (existing) return parseGraphState(existing);
    const created = { ...this.syncGraph(tenantId), mode: DEFAULT_MERGE_MODE, modePinned: true };
    saveGraph(this.store, tenantId, created, this.now());
    return created;
  }

  setMergeConfig(tenantId: string, patch: { mode: RouterMode }): GraphState {
    const next = setGraphMode(this.syncGraph(tenantId), patch.mode);
    saveGraph(this.store, tenantId, next, this.now());
    return next;
  }

  splitMerge(tenantId: string, mergeId: string): GraphState {
    const at = this.now();
    const before = this.syncGraph(tenantId);
    const edge = before.edges.find((row) => row.mergeId === mergeId);
    const next = splitMerge(before, mergeId, at);
    if (edge?.subscriptionId) {
      this.store.retireSubscription(tenantId, edge.subscriptionId, at);
    }
    saveGraph(this.store, tenantId, next, at);
    this.linkRecall(tenantId, {
      triggerId: edge?.fromTriggerId ?? mergeId,
      threadId: edge?.fromThreadId ?? mergeId,
      workerId: null,
      mergeId,
      fromThreadId: edge?.toThreadId,
      cause: 'split',
      layer: 'fast',
      at,
    });
    this.audit(tenantId, null, 'merge_split', at, { mergeId });
    return next;
  }

  collisions(tenantId: string) {
    return this.syncGraph(tenantId).collisions;
  }

  ensureEscalateConfig(tenantId: string): EscalateState {
    const existing = this.store.getDocument(tenantId, ESCALATE_DOCUMENT);
    if (existing) return parseEscalateState(existing);
    const created = patchEscalate(emptyEscalateState(), {
      enabled: true,
      ...(this.escalateDefaults.thresholds
        ? {
            thresholds: { ...emptyEscalateState().thresholds, ...this.escalateDefaults.thresholds },
          }
        : {}),
    });
    saveEscalate(this.store, tenantId, created, this.now());
    return created;
  }

  setEscalateConfig(
    tenantId: string,
    patch: Partial<Pick<EscalateState, 'enabled' | 'thresholds'>>,
  ): EscalateState {
    const next = patchEscalate(this.escalateState(tenantId), patch);
    saveEscalate(this.store, tenantId, next, this.now());
    return next;
  }

  escalateMetrics(tenantId: string) {
    return this.escalateState(tenantId).metrics;
  }

  decisionCards(tenantId: string): DecisionCard[] {
    return this.escalateState(tenantId).cards;
  }

  async resolveDecisionCard(
    tenantId: string,
    cardId: string,
    option: CardOption,
  ): Promise<{ ok: true; card?: DecisionCard } | { ok: false; reason: string }> {
    const at = this.now();
    const state = this.escalateState(tenantId);
    const card = state.cards.find((row) => row.cardId === cardId);
    if (!card || card.state !== 'pending') return { ok: false, reason: 'unknown_card' };
    const next = resolveCard(state, cardId, option, at);
    saveEscalate(this.store, tenantId, next, at);
    this.audit(tenantId, null, 'escalate_feedback', at, {
      cardId,
      option,
      value: card.score.value,
    });
    if (option === 'accept') {
      const event = this.store.event(tenantId, card.eventId);
      if (event?.subject) {
        const task = this.scheduler.enqueue({
          tenantId,
          eventId: event.eventId,
          subject: event.subject,
          title: card.title,
          mandate: observeMandate(event.subject.repo ? [event.subject.repo] : []),
        });
        this.registerTicket(event, { taskId: task.taskId, workerId: task.workerId });
        await this.admitTenant(tenantId);
      }
    }
    return { ok: true, card: next.cards.find((row) => row.cardId === cardId) };
  }

  async enqueueTask(input: {
    tenantId: string;
    eventId?: string;
    subject: import('./types.js').Subject;
    title: string;
    mandate: import('./types.js').Mandate;
    priority?: TaskPriority;
    size?: TaskSize;
    dependencies?: TaskDependency[];
    footprint?: string[];
    start?: StartCondition;
    reserved?: boolean;
    source?: import('./types.js').EventSource;
  }): Promise<ScheduledTask> {
    let eventId = input.eventId;
    if (!eventId) {
      const at = this.now();
      const event = {
        eventId: this.ids.event(),
        tenantId: input.tenantId,
        source: input.source ?? ('internal' as const),
        type: 'task_enqueued',
        subject: input.subject,
        idempotencyKey: `task:${input.tenantId}:${this.ids.task()}`,
        actor: { login: 'system', kind: 'system' as const },
        occurredAt: at,
        receivedAt: at,
        summary: input.title,
        fields: [],
        closesSubject: false,
      };
      this.store.putEvent(event);
      eventId = event.eventId;
    }
    const task = this.scheduler.enqueue({ ...input, eventId });
    const storedEvent = this.store.event(input.tenantId, eventId);
    if (storedEvent)
      this.registerTicket(storedEvent, { taskId: task.taskId, workerId: task.workerId });
    this.noteTaskCollision(input.tenantId, task);
    this.linkRecall(input.tenantId, {
      triggerId: eventId,
      threadId: input.subject.key,
      workerId: null,
      taskId: task.taskId,
      layer: 'slow',
      at: this.now(),
    });
    await this.admitTenant(input.tenantId);
    const live = this.scheduler.task(input.tenantId, task.taskId) ?? task;
    if (storedEvent)
      this.registerTicket(storedEvent, { taskId: live.taskId, workerId: live.workerId });
    this.noteTaskCollision(input.tenantId, live);
    return live;
  }

  async admitQueued(tenantId?: string): Promise<string[]> {
    if (tenantId) return this.admitTenant(tenantId);
    const ids: string[] = [];
    for (const id of this.scheduler.tenants()) {
      ids.push(...(await this.admitTenant(id)));
    }
    return ids;
  }

  async askWatchdog(tenantId: string, text: string): Promise<WatchdogAnswer> {
    const intent = parseWatchdogText(text);
    if (intent.kind === 'command') return commandRefusedAsk(intent);
    const ctx = collectWatchdogContext({
      store: this.store,
      tenantId,
      at: this.now(),
      incidents: this.incidents,
      snapshot: this.statusSnapshot(tenantId),
      settings: this.watchdogSettings,
    });
    return answerWatchdog(intent, ctx, this.watchdogNarrator);
  }

  async instructWatchdog(tenantId: string, text: string): Promise<WatchdogAnswer> {
    const intent = parseWatchdogText(text);
    if (intent.kind !== 'command') return this.askWatchdog(tenantId, text);
    const action = await this.applyWatchdogCommand(tenantId, intent.command, intent.workerId);
    const after = await this.askWatchdog(
      tenantId,
      intent.workerId ? `why is worker ${intent.workerId} stuck` : 'what is everyone doing',
    );
    const citations = [...(intent.workerId ? [intent.workerId] : []), ...after.citations];
    const textOut = `${formatWatchdogAnswer({ ...after, action, citations, intent })}`;
    return { ...after, action, citations, intent, text: textOut };
  }

  async nudgeWorker(
    tenantId: string,
    workerId: string,
    detail = 'owner instruct',
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    await this.nudge(worker, this.now(), detail);
    return { ok: true };
  }

  async cancel(
    tenantId: string,
    workerId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    if (worker.state === 'retired' || worker.state === 'retiring') {
      return { ok: false, reason: 'not_live' };
    }
    const at = this.now();
    worker.cancelRequested = true;
    worker.updatedAt = at;
    this.store.putWorker(worker);
    const event: NormalizedEvent = {
      eventId: this.ids.event(),
      tenantId,
      source: 'internal',
      type: 'user_cancel',
      subject: worker.subject,
      idempotencyKey: `cancel:${workerId}:${at}`,
      actor: { login: 'owner', kind: 'user' },
      occurredAt: at,
      receivedAt: at,
      summary: 'The owner cancelled the worker.',
      fields: [['text', 'cancel']],
      closesSubject: false,
    };
    this.store.putEvent(event);
    this.store.enqueue(worker.workerId, event.eventId, at);
    this.audit(tenantId, workerId, 'cancelled', at, { eventId: event.eventId });
    if (this.draining.has(workerId)) {
      await this.ackDuplexArrival(tenantId, workerId, event, at);
      this.notifyDuplex(workerId);
      return { ok: true };
    }
    await this.retire(worker, at, 'owner_cancel');
    return { ok: true };
  }

  async restore(): Promise<{ resumed: number }> {
    let resumed = 0;
    const live = this.store.allWorkers().sort(compareWorkerPriority);
    for (const worker of live) {
      if (worker.state === 'spawning' || worker.state === 'running' || worker.state === 'waking') {
        await this.drain(worker.tenantId, worker.workerId);
        resumed += 1;
      }
    }
    await this.admitQueued();
    return { resumed };
  }

  async tick(): Promise<WatchdogFinding[]> {
    const at = this.now();
    const findings = await runWatchdog(
      this.store,
      this.watchdogSettings,
      {
        restart: async (worker, when) => this.restart(worker, when),
        retire: async (worker, when, reason) => this.retire(worker, when, reason),
        stop: async (worker, when, reason) => this.stop(worker, when, reason),
        markStuck: (worker, when) => this.markStuck(worker, when),
        nudge: async (worker, when, detail) => this.nudge(worker, when, detail),
      },
      at,
    );
    for (const found of findings) this.incidents.push(found);
    if (this.incidents.length > 200) this.incidents.splice(0, this.incidents.length - 200);
    if (this.boxPool) await this.boxPool.tick(at);
    for (const found of findings) {
      if (
        found.rule === 'stream_silence' ||
        found.rule === 'time_limit' ||
        found.rule === 'empty_turns' ||
        found.rule === 'repeat_tools'
      ) {
        const worker = this.store.worker(found.tenantId, found.workerId);
        if (
          worker &&
          (found.action === 'retry' || found.action === 'nudge' || found.action === 'stop')
        ) {
          await this.surfaceAutonomy(
            worker,
            {
              action: found.action,
              rule: found.rule,
              detail: found.detail,
              at,
            },
            at,
          );
        }
      }
      if (found.rule === 'stuck' || found.rule === 'crashed') {
        const worker = this.store.worker(found.tenantId, found.workerId);
        if (worker) await this.speakProgress(worker, 'stuck', at);
      }
      if (found.action !== 'escalate' && found.action !== 'stop') continue;
      if (found.rule === 'box_stuck') {
        const box = this.store.tenantBox(found.tenantId);
        if (!box) continue;
        const card = stuckCardOf(tenantBoxAsWorker(box), found, at);
        this.escalations.push(card);
        this.onEscalate?.(card);
        continue;
      }
      const worker = this.store.worker(found.tenantId, found.workerId);
      if (!worker) continue;
      const card = stuckCardOf(worker, found, at);
      this.escalations.push(card);
      this.onEscalate?.(card);
    }
    for (const worker of this.store.allWorkers()) {
      if (!isLiveState(worker.state)) continue;
      await this.refreshProgressSpeak(worker, at);
    }
    await this.admitQueued();
    return findings;
  }

  async approve(
    tenantId: string,
    approvalId: string,
    boundText: string,
  ): Promise<{ ok: true; workerId: string } | { ok: false; reason: string }> {
    const at = this.now();
    const decided = this.safety.decide(tenantId, approvalId, boundText, 'approved', at);
    if (!decided.ok) return decided;
    const worker = this.store.worker(tenantId, decided.approval.workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    worker.state = 'running';
    worker.updatedAt = at;
    this.store.putWorker(worker);
    const grant: NormalizedEvent = {
      eventId: this.ids.event(),
      tenantId,
      source: 'internal',
      type: 'approval_granted',
      subject: worker.subject,
      idempotencyKey: `approval:${approvalId}:granted`,
      actor: { login: 'owner', kind: 'user' },
      occurredAt: at,
      receivedAt: at,
      summary: 'The owner approved a held action.',
      fields: [
        ['kind', decided.approval.kind],
        ['boundText', decided.approval.boundText],
      ],
      closesSubject: false,
    };
    this.store.putEvent(grant);
    this.store.enqueue(worker.workerId, grant.eventId, at);
    await this.drain(tenantId, worker.workerId);
    this.audit(tenantId, worker.workerId, 'approved', at, { approvalId });
    return { ok: true, workerId: worker.workerId };
  }

  async deny(
    tenantId: string,
    approvalId: string,
    boundText: string,
  ): Promise<{ ok: true; workerId: string } | { ok: false; reason: string }> {
    const at = this.now();
    const decided = this.safety.decide(tenantId, approvalId, boundText, 'denied', at);
    if (!decided.ok) return decided;
    const worker = this.store.worker(tenantId, decided.approval.workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    if (this.learning.enabled) {
      this.recordLesson({
        tenantId,
        triggerEventId: this.putInternalEvent(worker, 'approval_denied', at, [
          ['kind', decided.approval.kind],
          ['boundText', decided.approval.boundText],
        ]),
        cause: 'approval_denied',
        mistake: `Owner denied ${decided.approval.kind}: ${decided.approval.boundText}`,
        correct: 'Ask before irreversible work; wait for an exact-text grant.',
        scope: worker.subject.repo ?? 'tenant',
        workerId: worker.workerId,
        at,
      });
    }
    await this.retire(worker, at, 'approval_denied');
    this.audit(tenantId, worker.workerId, 'denied', at, { approvalId });
    return { ok: true, workerId: worker.workerId };
  }

  async review(
    tenantId: string,
    workerId: string,
    input: { repo: string; number: number; sha: string },
  ): Promise<{ ok: true; receipt: ReviewReceipt } | { ok: false; reason: string }> {
    if (!this.reviewer) return { ok: false, reason: 'no_reviewer' };
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    const at = this.now();
    const { text } = await this.reviewer.review(input);
    const receipt = receiptFromReview(text, { ...input, at });
    if (!receipt) {
      this.audit(tenantId, workerId, 'review_no_verdict', at, {
        sha: input.sha,
        pr: prRef(input.repo, input.number),
      });
      return { ok: false, reason: 'no_verdict' };
    }
    worker.reviewReceipts = [...(worker.reviewReceipts ?? []), receipt];
    worker.updatedAt = at;
    this.store.putWorker(worker);
    this.audit(tenantId, workerId, 'review_receipt', at, {
      pr: receipt.pr,
      sha: receipt.sha,
      verdict: receipt.verdict,
    });
    if (receipt.verdict === 'BLOCK' && this.learning.enabled) {
      this.recordLesson({
        tenantId,
        triggerEventId: worker.lastEventId ?? this.ids.event(),
        cause: 'review_rejected',
        mistake: receipt.summary,
        correct: 'Address every BLOCK finding before proposing merge.',
        scope: worker.subject.repo ?? 'tenant',
        workerId,
        at,
      });
    }
    return { ok: true, receipt };
  }

  async pause(
    tenantId: string,
    workerId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    if (worker.state === 'retired' || worker.state === 'retiring') {
      return { ok: false, reason: 'not_live' };
    }
    if (worker.mandate.ownerPause === false) {
      return { ok: false, reason: 'owner_pause_disabled' };
    }
    if (worker.state === 'paused' && worker.pausedVerified) return { ok: true };
    const at = this.now();
    if (worker.sandboxRef) {
      const first = await this.sandbox.getMachine(worker.sandboxRef);
      if (boxLooksRunning(first.state)) await this.suspendBox(worker);
      const after = await this.sandbox.getMachine(worker.sandboxRef);
      if (boxLooksRunning(after.state)) {
        this.audit(tenantId, workerId, 'pause_refused', at, { reason: 'box_still_running' });
        return { ok: false, reason: 'box_still_running' };
      }
    } else if (isPauseActive(worker.state)) {
      this.audit(tenantId, workerId, 'pause_refused', at, { reason: 'still_active' });
      return { ok: false, reason: 'still_active' };
    }
    worker.pausedFrom = worker.state === 'paused' ? worker.pausedFrom : worker.state;
    worker.state = 'paused';
    worker.pausedVerified = true;
    worker.updatedAt = at;
    this.store.putWorker(worker);
    this.audit(tenantId, workerId, 'paused', at, { from: worker.pausedFrom ?? 'sleeping' });
    return { ok: true };
  }

  async resume(
    tenantId: string,
    workerId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    if (worker.state !== 'paused') return { ok: false, reason: 'not_paused' };
    const at = this.now();
    worker.state = resumeState(worker.pausedFrom);
    worker.pausedFrom = undefined;
    worker.pausedVerified = false;
    worker.nudges = 0;
    worker.updatedAt = at;
    this.store.putWorker(worker);
    this.audit(tenantId, workerId, 'resumed', at, { state: worker.state });
    await this.drain(tenantId, workerId);
    return { ok: true };
  }

  async reportToLead(
    tenantId: string,
    workerId: string,
  ): Promise<{ ok: true; stale: boolean; text: string } | { ok: false; reason: string }> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    const at = this.now();
    const live = await this.readLive(worker, at);
    const freshness = freshnessOf(live, worker.lastLive ?? {}, at);
    const text = formatLeadReport({
      workerId: worker.workerId,
      live,
      freshness,
      plan: worker.plan,
      progress: formatProgressLine(
        this.progressView(this.store.worker(tenantId, workerId) ?? worker, at),
      ),
    });
    worker.lastLive = live;
    worker.updatedAt = at;
    this.store.putWorker(worker);
    await this.lead.speak({
      tenantId,
      workerId,
      text,
      stale: freshness.stale,
    });
    this.audit(tenantId, workerId, 'lead_report', at, {
      stale: freshness.stale,
      sha: live.sha ?? '',
      ci: live.ci ?? '',
    });
    return { ok: true, stale: freshness.stale, text };
  }

  async acceptSpeculative(
    tenantId: string,
    workerId: string,
  ): Promise<{ ok: true; workerId: string } | { ok: false; reason: string }> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    if (!isUnacceptedSpeculative(worker) || !worker.speculative) {
      return { ok: false, reason: 'not_speculative' };
    }
    const at = this.now();
    const cost = snapshotSpeculativeCost(worker);
    worker.speculative = {
      ...worker.speculative,
      status: 'accepted',
      acceptedAt: at,
      cost,
    };
    worker.updatedAt = at;
    this.store.putWorker(worker);
    const already = this.store
      .liveSubscribers(tenantId, worker.subject.key)
      .some((sub) => sub.workerId === worker.workerId);
    if (!already) {
      this.store.putSubscription({
        subscriptionId: this.ids.subscription(),
        tenantId,
        subjectKey: worker.subject.key,
        workerId: worker.workerId,
        createdAt: at,
        retiredAt: null,
      });
    }
    this.audit(tenantId, workerId, 'speculative_accepted', at, {
      trigger: worker.speculative.trigger,
      tokens: cost.tokens,
      usdMicros: cost.usdMicros,
    });
    return { ok: true, workerId };
  }

  async discardSpeculative(
    tenantId: string,
    workerId: string,
  ): Promise<{ ok: true; workerId: string } | { ok: false; reason: string }> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return { ok: false, reason: 'worker_gone' };
    if (!worker.speculative || worker.speculative.status === 'discarded') {
      return { ok: false, reason: 'not_speculative' };
    }
    const at = this.now();
    const cost = snapshotSpeculativeCost(worker);
    worker.speculative = {
      ...worker.speculative,
      status: 'discarded',
      discardedAt: at,
      cost,
    };
    worker.updatedAt = at;
    this.store.putWorker(worker);
    if (this.speculativeCleanup) {
      await this.speculativeCleanup.discard(worker);
    } else if (worker.workspaceRef) {
      worker.workspaceRef = null;
    }
    worker.sandboxRef = null;
    await this.retire(worker, at, 'speculative_discarded');
    this.audit(tenantId, workerId, 'speculative_discarded', at, {
      trigger: worker.speculative.trigger,
      tokens: cost.tokens,
      usdMicros: cost.usdMicros,
    });
    return { ok: true, workerId };
  }

  createByomPairing(
    tenantId: string,
    options?: { allowShell?: boolean },
  ): { ok: true; code: string; expiresAt: number } | { ok: false; reason: string } {
    if (!this.byom) return { ok: false, reason: 'disabled' };
    const out = this.byom.createPairing(tenantId, options);
    if (out.ok && options?.allowShell) {
      this.audit(tenantId, null, 'byom_allow_shell', this.now(), {
        allowShell: true,
        via: 'pairing',
      });
    }
    return out;
  }

  async setByomAllowShell(
    tenantId: string,
    deviceId: string,
    allowShell: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.byom) return { ok: false, reason: 'disabled' };
    const device = this.byom.deviceOf(deviceId);
    if (!device || device.tenantId !== tenantId) return { ok: false, reason: 'unknown_device' };
    const out = this.byom.setAllowShell(deviceId, allowShell);
    if (!out.ok) return out;
    const at = this.now();
    this.audit(tenantId, null, 'byom_allow_shell', at, { deviceId, allowShell });
    for (const worker of this.store.workers(tenantId)) {
      if (worker.retiredAt != null) continue;
      if (worker.executionTarget?.id !== deviceId) continue;
      worker.executionTarget = { ...worker.executionTarget, allowShell };
      await this.recordProgress(
        worker,
        { activity: allowShell ? 'allowShell' : 'allowShell_off' },
        at,
      );
    }
    return { ok: true };
  }

  close(): void {
    this.store.close();
  }

  private async considerSpeculative(
    event: NormalizedEvent,
    at: number,
  ): Promise<IngestResult | undefined> {
    if (!event.subject) return undefined;
    const trigger = matchSpeculativeTrigger(event, this.speculativeSettings);
    if (!trigger) return undefined;
    const meter = this.metering.admit?.(event.tenantId) === 'stop';
    if (event.type === 'ci_failed' || event.type === 'ci_passed') {
      if (meter) return undefined;
    } else {
      const admission = admit(event, this.admission, meter);
      if (!admission.ok) return undefined;
    }
    const existing = this.store
      .workers(event.tenantId)
      .find((row) => row.subject.key === event.subject?.key && isUnacceptedSpeculative(row));
    if (existing) {
      this.store.enqueue(existing.workerId, event.eventId, at);
      await this.drain(event.tenantId, existing.workerId);
      this.audit(event.tenantId, existing.workerId, 'speculative_passthrough', at, {
        eventId: event.eventId,
      });
      return {
        result: 'speculative',
        eventId: event.eventId,
        workerId: existing.workerId,
        judgeCalls: 0,
      };
    }
    const gate = admitSpeculative(
      this.store,
      event.tenantId,
      event.subject.key,
      this.speculativeSettings,
      at,
    );
    if (!gate.ok) {
      this.audit(event.tenantId, null, 'speculative_refused', at, { reason: gate.reason });
      return undefined;
    }
    const repos = event.subject.repo ? [event.subject.repo] : [];
    const worker = await this.spawn(event, speculativeMandate(repos), at, {
      subscribe: false,
      speculative: {
        status: 'running',
        trigger: trigger.kind,
        priority: this.speculativeSettings.priority,
      },
    });
    this.store.enqueue(worker.workerId, event.eventId, at);
    await this.drain(event.tenantId, worker.workerId);
    this.audit(event.tenantId, worker.workerId, 'speculative_started', at, {
      trigger: trigger.kind,
      subject: event.subject.key,
    });
    return {
      result: 'speculative',
      eventId: event.eventId,
      workerId: worker.workerId,
      judgeCalls: 0,
    };
  }

  private async admitTenant(tenantId: string): Promise<string[]> {
    const picked = this.scheduler.pickAdmittable(tenantId, this.admitContext(tenantId));
    const workerIds: string[] = [];
    for (const task of picked) {
      const event = this.store.event(tenantId, task.eventId);
      if (!event?.subject) {
        this.scheduler.markBlocked(tenantId, task.taskId, 'missing_event');
        continue;
      }
      if (this.store.liveWorkerBySubject(tenantId, event.subject.key)) {
        this.scheduler.markBlocked(tenantId, task.taskId, 'already_owned');
        continue;
      }
      const at = this.now();
      const worker = await this.spawn(event, task.mandate, at);
      this.registerTicket(event, { taskId: task.taskId, workerId: worker.workerId });
      this.scheduler.markRunning(tenantId, task.taskId, worker.workerId);
      this.linkRecall(tenantId, {
        triggerId: event.eventId,
        threadId: event.subject.key,
        workerId: worker.workerId,
        taskId: task.taskId,
        layer: 'slow',
        at,
      });
      this.store.enqueue(worker.workerId, event.eventId, at);
      await this.drain(tenantId, worker.workerId);
      this.audit(tenantId, worker.workerId, 'spawned', at, {
        subject: event.subject.key,
        taskId: task.taskId,
      });
      workerIds.push(worker.workerId);
    }
    return workerIds;
  }

  private admitContext(tenantId: string) {
    return {
      boxedLive: this.boxPool
        ? this.store.allTenantBoxes().length
        : this.store.allWorkers().filter((row) => isLiveState(row.state) && row.sandboxRef).length,
      wouldBox: Boolean(this.boxPool || this.defaultSandboxRef),
      tenantUsage: this.store.tenantUsage(tenantId),
      usageEvents: this.store.usageEvents(tenantId),
      policy: this.admission,
    };
  }

  private intakeState(tenantId: string): IntakeState {
    return parseIntakeState(this.store.getDocument(tenantId, INTAKE_DOCUMENT));
  }

  private async tryMerge(event: NormalizedEvent, at: number): Promise<IngestResult | undefined> {
    if (!event.subject) return undefined;
    if (this.mergeMode(event.tenantId) === 'off') return undefined;
    this.syncGraph(event.tenantId);
    const graph = loadGraph(this.store, event.tenantId);
    const tickets = liveTickets(graph);
    const hard = findProgrammatic(event, tickets);
    let hit = hard;
    let judgeCalls = 0;
    if (!hit && this.mergeClient) {
      const fuzzy = findFuzzy(event, tickets);
      if (fuzzy.length > 0) {
        const raw = await this.mergeClient.complete(mergePrompt(event, fuzzy));
        const judged = parseMergeJudgement(raw, fuzzy);
        if (judged) {
          const ticket = fuzzy.find((row) => row.ticketId === judged.ticketId);
          if (ticket) hit = { ticket, reason: judged.reason, layer: 'slow' };
        }
        judgeCalls = 1;
      }
    }
    if (!hit) return undefined;
    const mode = this.mergeMode(event.tenantId);
    const worker = this.liveTicketWorker(event.tenantId, hit.ticket);
    const apply = mode === 'auto' && worker !== undefined;
    let subscriptionId: string | undefined;
    if (apply && worker) {
      subscriptionId = this.ids.subscription();
      this.store.putSubscription({
        subscriptionId,
        tenantId: event.tenantId,
        subjectKey: event.subject.key,
        workerId: worker.workerId,
        createdAt: at,
        retiredAt: null,
      });
      this.store.enqueue(worker.workerId, event.eventId, at);
      await this.drain(event.tenantId, worker.workerId);
    }
    const mergeId = this.ids.merge();
    const next = applyMerge(loadGraph(this.store, event.tenantId), {
      mergeId,
      tenantId: event.tenantId,
      event,
      ticket: {
        ...hit.ticket,
        workerId: worker?.workerId ?? hit.ticket.workerId,
      },
      reason: hit.reason,
      layer: hit.layer,
      mode,
      applied: apply,
      ...(subscriptionId ? { subscriptionId } : {}),
      at,
    });
    saveGraph(this.store, event.tenantId, next, at);
    this.linkRecall(event.tenantId, {
      triggerId: event.eventId,
      threadId: hit.ticket.subjectKey,
      workerId: worker?.workerId ?? null,
      mergeId,
      fromThreadId: event.subject.key,
      cause: hit.reason,
      layer: hit.layer === 'programmatic' ? 'passthrough' : 'slow',
      at,
    });
    this.audit(event.tenantId, worker?.workerId ?? null, apply ? 'merged' : 'would_merge', at, {
      mergeId,
      reason: hit.reason,
      layer: hit.layer,
    });
    if (apply && worker) {
      return {
        result: 'merged',
        eventId: event.eventId,
        workerIds: [worker.workerId],
        ticketId: hit.ticket.ticketId,
        mergeId,
        reason: hit.reason,
        judgeCalls: 0,
      };
    }
    return {
      result: 'would_merge',
      eventId: event.eventId,
      ticketId: hit.ticket.ticketId,
      mergeId,
      reason: hit.reason,
      judgeCalls,
    };
  }

  private async tryEscalate(event: NormalizedEvent, at: number): Promise<IngestResult | undefined> {
    const state = this.escalateState(event.tenantId);
    if (!state.enabled && !this.escalateDefaults.enabled) return undefined;
    const enabled = state.enabled || this.escalateDefaults.enabled;
    if (!enabled) return undefined;
    let score = heuristicScore(event);
    let scoreCalls = 0;
    let tokens = 0;
    let usdMicros = 0;
    if (this.scoreClient) {
      const detailed = this.scoreClient.completeDetailed
        ? await this.scoreClient.completeDetailed(scorePrompt(event))
        : { text: await this.scoreClient.complete(scorePrompt(event)) };
      const parsed = parseScore(detailed.text);
      if (parsed) score = parsed;
      scoreCalls = 1;
      const usage = 'usage' in detailed ? detailed.usage : undefined;
      tokens = usage?.tokens ?? 0;
      usdMicros = usage?.usdMicros ?? 0;
    }
    const band = bandOf(score, state.thresholds);
    if (band === 'medium') {
      saveEscalate(
        this.store,
        event.tenantId,
        recordBand(state, { band, kind: 'assign', scoreCalls, tokens, usdMicros }),
        at,
      );
      return undefined;
    }
    if (band === 'low') {
      saveEscalate(
        this.store,
        event.tenantId,
        recordBand(state, { band, kind: 'archive', scoreCalls, tokens, usdMicros }),
        at,
      );
      this.audit(event.tenantId, null, 'archived', at, { reason: score.reason, band });
      return {
        result: 'archived',
        eventId: event.eventId,
        reason: score.reason,
        band: 'low',
        judgeCalls: 0,
      };
    }
    const card: DecisionCard = {
      cardId: this.ids.card(),
      tenantId: event.tenantId,
      eventId: event.eventId,
      threadId: event.subject?.key ?? event.eventId,
      title: event.summary,
      reason: score.reason,
      band: 'high',
      score,
      state: 'pending',
      at,
    };
    saveEscalate(
      this.store,
      event.tenantId,
      addCard(recordBand(state, { band, kind: 'escalate', scoreCalls, tokens, usdMicros }), card),
      at,
    );
    this.audit(event.tenantId, null, 'escalated', at, {
      cardId: card.cardId,
      reason: score.reason,
    });
    return {
      result: 'escalated',
      eventId: event.eventId,
      cardId: card.cardId,
      band: 'high',
      reason: score.reason,
      judgeCalls: 0,
    };
  }

  private syncGraph(tenantId: string): GraphState {
    let state = loadGraph(this.store, tenantId);
    const at = this.now();
    let dirty = false;
    for (const worker of this.store.workers(tenantId)) {
      if (!isLiveState(worker.state)) continue;
      const existing = state.tickets.find((row) => row.subjectKey === worker.subject.key);
      if (existing) {
        if (existing.workerId !== worker.workerId) {
          state = upsertTicket(state, { ...existing, workerId: worker.workerId });
          dirty = true;
        }
        continue;
      }
      dirty = true;
      state = upsertTicket(state, {
        ticketId: worker.subject.key,
        tenantId,
        subjectKey: worker.subject.key,
        workerId: worker.workerId,
        signals: extractSignals({
          eventId: worker.lastEventId ?? worker.workerId,
          tenantId,
          source: 'internal',
          type: 'ticket',
          subject: worker.subject,
          idempotencyKey: worker.workerId,
          actor: { login: 'system', kind: 'system' },
          occurredAt: at,
          receivedAt: at,
          summary: worker.plan,
          fields: [
            ...(worker.subject.repo
              ? ([['repo', worker.subject.repo]] as Array<[string, string]>)
              : []),
          ],
          closesSubject: false,
        }),
        members: [worker.subject.key],
        blocked: [],
        at,
      });
    }
    if (dirty) saveGraph(this.store, tenantId, state, at);
    return state;
  }

  private registerTicket(
    event: NormalizedEvent,
    ids: { taskId?: string; workerId?: string },
  ): void {
    if (!event.subject) return;
    const at = this.now();
    const state = loadGraph(this.store, event.tenantId);
    const existing = state.tickets.find((row) => row.subjectKey === event.subject?.key);
    const incoming = extractSignals(event);
    const ticket: GraphTicket = {
      ticketId: existing?.ticketId ?? event.subject.key,
      tenantId: event.tenantId,
      subjectKey: event.subject.key,
      workerId: ids.workerId ?? existing?.workerId ?? null,
      ...(ids.taskId
        ? { taskId: ids.taskId }
        : existing?.taskId
          ? { taskId: existing.taskId }
          : {}),
      signals: existing ? unionSignals(existing.signals, incoming) : incoming,
      members: existing?.members ?? [event.subject.key],
      blocked: existing?.blocked ?? [],
      at: existing?.at ?? at,
    };
    saveGraph(this.store, event.tenantId, upsertTicket(state, ticket), at);
  }

  private noteTaskCollision(
    tenantId: string,
    task: {
      taskId: string;
      state: string;
      reason?: string;
      subjectKey: string;
      repo?: string;
      footprint: string[];
    },
  ): void {
    if (task.reason !== 'footprint' && task.state !== 'blocked') return;
    if (task.reason !== 'footprint') return;
    const at = this.now();
    const others = this.scheduler
      .tasks(tenantId)
      .filter(
        (row) =>
          row.taskId !== task.taskId && (row.state === 'running' || row.state === 'admitted'),
      );
    const other = others.find(
      (row) => (row.repo ?? '') === (task.repo ?? '') || row.subjectKey === task.subjectKey,
    );
    const left = other?.taskId ?? task.subjectKey;
    const state = noteCollision(loadGraph(this.store, tenantId), {
      id: this.ids.decision(),
      tenantId,
      leftId: left,
      rightId: task.taskId,
      kind: other?.subjectKey === task.subjectKey ? 'subject' : 'footprint',
      detail: `scheduler serialized ${task.taskId} (${task.reason})`,
      at,
    });
    saveGraph(this.store, tenantId, state, at);
  }

  private liveTicketWorker(tenantId: string, ticket: GraphTicket): WorkerRecord | undefined {
    if (ticket.workerId) {
      const worker = this.store.worker(tenantId, ticket.workerId);
      if (worker && isLiveState(worker.state)) return worker;
    }
    return this.store.liveWorkerBySubject(tenantId, ticket.subjectKey);
  }

  private escalateState(tenantId: string): EscalateState {
    const stored = loadEscalate(this.store, tenantId);
    if (this.store.getDocument(tenantId, ESCALATE_DOCUMENT)) return stored;
    if (!this.escalateDefaults.enabled && !this.escalateDefaults.thresholds) return stored;
    return patchEscalate(stored, {
      enabled: this.escalateDefaults.enabled,
      ...(this.escalateDefaults.thresholds
        ? { thresholds: { ...stored.thresholds, ...this.escalateDefaults.thresholds } }
        : {}),
    });
  }

  private recordIntake(
    tenantId: string,
    event: Parameters<typeof bumpIntake>[1],
    ids: string[],
    at: number,
  ): void {
    const next = bumpIntake(this.intakeState(tenantId), event, ids, at);
    this.store.putDocument(tenantId, INTAKE_DOCUMENT, JSON.stringify(next), at);
  }

  private rememberDecision(tenantId: string, row: Parameters<typeof recordDecision>[1]): void {
    const stored = this.store.getDocument(tenantId, ROUTER_DOCUMENT);
    const base = stored
      ? parseRouterConfig(stored, tenantId)
      : { ...defaultTenantRouterConfig(tenantId), mode: this.effectiveRouterMode(tenantId) };
    const next = recordDecision(base, row);
    this.store.putDocument(tenantId, ROUTER_DOCUMENT, JSON.stringify(next), row.at);
  }

  private linkRecall(tenantId: string, link: Parameters<typeof appendRecall>[2]): void {
    appendRecall(this.store, tenantId, link);
  }

  private async spawn(
    event: NormalizedEvent,
    mandate: WorkerRecord['mandate'],
    at: number,
    extras: {
      subscribe?: boolean;
      speculative?: WorkerRecord['speculative'];
      need?: ExecutionNeed;
    } = {},
  ): Promise<WorkerRecord> {
    const subject = event.subject;
    if (!subject) throw new Error('Cannot spawn without a subject.');
    const resolved = await this.targets.resolve({
      tenantId: event.tenantId,
      repo: subject.repo,
      need: extras.need,
    });
    let sandboxRef = this.defaultSandboxRef;
    let executionTarget: WorkerRecord['executionTarget'] = {
      kind: 'instabox',
      id: sandboxRef ?? undefined,
    };
    if (resolved.ok) {
      executionTarget = { kind: resolved.target.kind, id: resolved.target.id };
      if (resolved.target.kind === 'device') {
        sandboxRef = resolved.target.id;
        const device = this.byom?.deviceOf(resolved.target.id);
        if (device?.allowShell) executionTarget.allowShell = true;
      }
    } else {
      executionTarget = {
        kind: resolved.kind ?? 'device',
        waitReason: resolved.waitReason ?? resolved.reason,
      };
      sandboxRef = null;
    }
    const worker: WorkerRecord = {
      workerId: this.ids.worker(),
      tenantId: event.tenantId,
      subject: { ...subject },
      state: 'spawning',
      generation: 1,
      mandate,
      memory: '',
      spills: [],
      plan: '',
      transcriptPointer: null,
      sandboxRef,
      workspaceRef: null,
      lastEventId: null,
      lastProgressAt: at,
      lastHeartbeatAt: at,
      lastStepSignature: null,
      stepRepeats: 0,
      seenEventIds: [],
      progress: startProgress(at),
      executionTarget,
      speculative: extras.speculative,
      usage: emptyUsage(),
      evidence: [],
      createdAt: at,
      updatedAt: at,
      retiredAt: null,
    };
    if (this.learning.enabled) this.injectLessons(worker);
    this.store.putWorker(worker);
    if (extras.subscribe !== false) {
      this.store.putSubscription({
        subscriptionId: this.ids.subscription(),
        tenantId: event.tenantId,
        subjectKey: subject.key,
        workerId: worker.workerId,
        createdAt: at,
        retiredAt: null,
      });
    }
    if (executionTarget.waitReason) {
      await this.recordProgress(
        worker,
        {
          waiting: { kind: 'human', detail: executionTarget.waitReason },
          activity: executionTarget.waitReason,
        },
        at,
      );
    } else if (executionTarget.allowShell) {
      await this.recordProgress(worker, { activity: 'allowShell' }, at);
    }
    return worker;
  }

  private async applyWatchdogCommand(
    tenantId: string,
    command: WatchdogActionResult['kind'],
    workerId?: string,
  ): Promise<WatchdogActionResult> {
    if (command !== 'stuck_check' && !workerId) {
      return { kind: command, ok: false, reason: 'worker_required' };
    }
    if (command === 'nudge' && workerId) {
      const nudged = await this.nudgeWorker(tenantId, workerId);
      return { kind: 'nudge', workerId, ...nudged };
    }
    if (command === 'pause' && workerId) {
      const paused = await this.pause(tenantId, workerId);
      return { kind: 'pause', workerId, ...paused };
    }
    if (command === 'resume' && workerId) {
      const resumed = await this.resume(tenantId, workerId);
      return { kind: 'resume', workerId, ...resumed };
    }
    if (command === 'cancel' && workerId) {
      const cancelled = await this.cancel(tenantId, workerId);
      return { kind: 'cancel', workerId, ...cancelled };
    }
    const findings = await this.tick();
    const scoped = workerId ? findings.filter((row) => row.workerId === workerId) : findings;
    return {
      kind: 'stuck_check',
      ...(workerId ? { workerId } : {}),
      ok: true,
      reason: scoped.length > 0 ? scoped.map((row) => row.rule).join(',') : 'clear',
    };
  }

  private async drain(tenantId: string, workerId: string): Promise<void> {
    if (this.draining.has(workerId)) {
      const worker = this.store.worker(tenantId, workerId);
      const pending = this.store.inbox(workerId).filter((item) => item.consumedAt === null);
      const last = pending[pending.length - 1];
      const event = last && worker ? this.store.event(tenantId, last.eventId) : undefined;
      if (worker && event) await this.ackDuplexArrival(tenantId, workerId, event, this.now());
      this.notifyDuplex(workerId);
      return;
    }
    this.draining.add(workerId);
    try {
      await this.drainBody(tenantId, workerId);
    } finally {
      this.draining.delete(workerId);
    }
  }

  private async drainBody(tenantId: string, workerId: string): Promise<void> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return;
    if (worker.state === 'retired' || worker.state === 'retiring') return;
    if (worker.state === 'awaiting_approval') return;
    if (worker.state === 'paused') return;
    if (worker.state === 'stuck') return;

    const pending = this.store.inbox(workerId).filter((item) => item.consumedAt === null);
    if (pending.length === 0) {
      if (worker.state === 'running' || worker.state === 'waking' || worker.state === 'spawning') {
        worker.state = 'sleeping';
        worker.updatedAt = this.now();
        this.store.putWorker(worker);
        await this.suspendBox(worker);
      }
      return;
    }

    const woke = await this.wakeBox(worker);
    if (woke === 'wait') {
      worker.state = 'waking';
      worker.updatedAt = this.now();
      this.store.putWorker(worker);
      return;
    }
    setState(worker, 'running');
    const items: typeof pending = [];
    const events: NormalizedEvent[] = [];
    for (const item of pending) {
      const event = this.store.event(tenantId, item.eventId);
      if (!event) {
        this.store.consume(workerId, item.seq, this.now());
        continue;
      }
      items.push(item);
      events.push(event);
    }
    if (events.length === 0) {
      if (worker.state === 'running') setState(worker, 'sleeping');
      worker.updatedAt = this.now();
      this.store.putWorker(worker);
      if (worker.state === 'sleeping') await this.suspendBox(worker);
      return;
    }

    const closer = events.find((event) => event.closesSubject);
    const at = this.now();
    worker.lastHeartbeatAt = at;
    worker.updatedAt = at;
    if (closer) {
      worker.lastEventId = closer.eventId;
      worker.subject = { ...worker.subject, closed: true };
      this.store.putWorker(worker);
      await this.finishClose(worker, closer, at);
      for (const item of items) this.store.consume(workerId, item.seq, at);
      return;
    }

    const event = coalesceInbox(events);
    worker.lastEventId = event.eventId;
    if (this.learning.enabled) this.noteBounce(worker, event, at);
    try {
      const result = await this.handler.handle(this.context(worker, event), event);
      const halt = await this.applyResult(worker, result, at);
      for (const item of items) this.store.consume(workerId, item.seq, at);
      const live = this.store.worker(tenantId, workerId);
      if (live?.cancelRequested) {
        await this.retire(live, at, 'owner_cancel');
        return;
      }
      if (halt) {
        if (worker.retiredAt == null) this.store.putWorker(worker);
        return;
      }
    } catch (error) {
      worker.state = 'crashed';
      worker.updatedAt = at;
      this.store.putWorker(worker);
      this.audit(tenantId, workerId, 'crashed', at, {
        message: error instanceof Error ? error.message : 'handler',
      });
      return;
    }
    if (worker.state === 'running') setState(worker, 'sleeping');
    worker.updatedAt = this.now();
    this.store.putWorker(worker);
    if (worker.state === 'sleeping') await this.suspendBox(worker);
  }

  private async applyResult(
    worker: WorkerRecord,
    result: HandlerResult,
    at: number,
  ): Promise<boolean> {
    if (result.memory !== undefined) {
      const body = stripLessonPrefix(worker.lessonPrefix, result.memory);
      const spilled = spillMemory(body, worker.spills ?? [], at);
      worker.memory = spilled.inline;
      worker.spills = spilled.spills;
      if (this.learning.enabled) {
        const pushed = /(?:^|\s)pushed ([0-9a-f]{7,40})\b/i.exec(result.memory);
        if (pushed?.[1]) worker.lastPushSha = pushed[1];
      }
    }
    if (result.plan !== undefined) worker.plan = result.plan;
    if (result.progressUpdate) await this.recordProgress(worker, result.progressUpdate, at);
    if (result.autonomy) worker.autonomy = result.autonomy;
    if (result.incident) {
      await this.surfaceAutonomy(worker, result.incident, at);
      if (result.incident.action === 'stop') {
        await this.stop(worker, at, result.incident.detail);
        return true;
      }
      if (result.incident.action === 'nudge') {
        await this.nudge(worker, at, result.incident.detail);
      }
    }
    if (result.transcriptPointer !== undefined) worker.transcriptPointer = result.transcriptPointer;
    if (result.workspaceRef !== undefined) worker.workspaceRef = result.workspaceRef;
    if (result.sandboxRef !== undefined) worker.sandboxRef = result.sandboxRef;
    if (result.progress) {
      worker.lastProgressAt = at;
      worker.nudges = 0;
    }
    if (result.stepSignature) {
      if (result.stepSignature === worker.lastStepSignature) worker.stepRepeats += 1;
      else {
        worker.lastStepSignature = result.stepSignature;
        worker.stepRepeats = 1;
      }
    }
    if (result.evidence && result.evidence.length > 0) {
      worker.evidence = mergeEvidence(worker.evidence ?? [], result.evidence);
    }
    if (result.usage) {
      const delta = {
        tokens: result.usage.tokens ?? 0,
        usdMicros: result.usage.usdMicros ?? 0,
        wallMs: result.usage.wallMs ?? 0,
      };
      worker.usage = {
        tokens: worker.usage.tokens + delta.tokens,
        usdMicros: worker.usage.usdMicros + delta.usdMicros,
        wallMs: worker.usage.wallMs + delta.wallMs,
        inputTokens: (worker.usage.inputTokens ?? 0) + (result.usage.inputTokens ?? 0),
        outputTokens: (worker.usage.outputTokens ?? 0) + (result.usage.outputTokens ?? 0),
      };
      this.store.putUsage(worker.tenantId, worker.workerId, worker.usage, at);
      this.store.appendUsageEvent({
        tenantId: worker.tenantId,
        workerId: worker.workerId,
        ...delta,
        at,
      });
      this.metering.record({
        tenantId: worker.tenantId,
        workerId: worker.workerId,
        ...delta,
        at,
      });
      const budget = overBudget(worker);
      if (budget) {
        worker.state = 'stuck';
        this.audit(worker.tenantId, worker.workerId, 'over_budget', at, { budget });
        return true;
      }
    }
    const outbound = workerOutboundText(result);
    if (outbound) {
      this.audit(worker.tenantId, worker.workerId, 'worker_outbound_refused', at, {
        chars: outbound.length,
      });
    }
    if (result.done) {
      worker.doneClaim = result.done;
      const verified = await verifyDone(result.done, this.doneWorld);
      this.audit(
        worker.tenantId,
        worker.workerId,
        verified.ok ? 'done_verified' : 'done_refused',
        at,
        {
          reasons: verified.reasons.join('; ') || 'ok',
        },
      );
      if (verified.ok) {
        await this.retire(worker, at, 'done_verified');
        return true;
      }
    }
    if (result.action?.kind === 'merge') {
      const parsed = parseMergeBound(result.action.boundText);
      if (
        parsed &&
        this.reviewer &&
        !hasClearReceipt(worker.reviewReceipts, prRef(parsed.repo, parsed.number), parsed.sha)
      ) {
        await this.collectReview(worker, parsed, at);
      }
    }
    if (result.action) {
      const gate = this.safety.gate(worker, result.action, at);
      if (!gate.allowed && gate.reason === 'intensity_observe') {
        this.audit(worker.tenantId, worker.workerId, 'action_refused', at, {
          kind: result.action.kind,
          reason: 'intensity_observe',
        });
      } else if (!gate.allowed && gate.reason === 'review_required') {
        this.audit(worker.tenantId, worker.workerId, 'action_refused', at, {
          kind: result.action.kind,
          reason: 'review_required',
        });
      } else if (!gate.allowed && gate.reason === 'speculative_blocked') {
        this.audit(worker.tenantId, worker.workerId, 'action_refused', at, {
          kind: result.action.kind,
          reason: 'speculative_blocked',
        });
      } else if (!gate.allowed && gate.reason === 'held') {
        worker.state = 'awaiting_approval';
        this.audit(worker.tenantId, worker.workerId, 'awaiting_approval', at, {
          approvalId: gate.approvalId,
          kind: result.action.kind,
        });
        await this.recordProgress(
          worker,
          {
            phase: result.action.kind === 'merge' ? 'merge-held' : worker.progress?.phase,
            waiting: { kind: 'human', detail: result.action.kind },
            activity: `held ${result.action.kind}`,
          },
          at,
        );
        worker.lastHeartbeatAt = at;
        return true;
      }
    }
    markSpeculativeReady(worker);
    worker.lastHeartbeatAt = at;
    return false;
  }

  private async finishClose(
    worker: WorkerRecord,
    event: NormalizedEvent,
    at: number,
  ): Promise<void> {
    worker.state = 'retiring';
    this.store.putWorker(worker);
    try {
      const result = await this.handler.handle(this.context(worker, event), event);
      await this.applyResult(worker, result, at);
    } catch {
      // A close note is best-effort.
    }
    await this.retire(worker, at, 'subject_closed');
  }

  private async restart(worker: WorkerRecord, at: number): Promise<void> {
    const current = this.store.worker(worker.tenantId, worker.workerId);
    if (!current) return;
    current.generation += 1;
    current.state = 'running';
    current.lastHeartbeatAt = at;
    current.updatedAt = at;
    this.store.putWorker(current);
    this.audit(current.tenantId, current.workerId, 'restart', at, {
      generation: current.generation,
    });
    this.recordWatchdogLesson(current, 'restart', 'Watchdog restarted the worker.', at);
    await this.drain(current.tenantId, current.workerId);
  }

  private async retire(worker: WorkerRecord, at: number, reason: string): Promise<void> {
    const current = this.store.worker(worker.tenantId, worker.workerId);
    if (!current || current.state === 'retired') {
      worker.state = 'retired';
      worker.retiredAt = current?.retiredAt ?? worker.retiredAt ?? at;
      worker.updatedAt = current?.updatedAt ?? at;
      return;
    }
    current.state = 'retired';
    current.retiredAt = at;
    current.updatedAt = at;
    worker.state = 'retired';
    worker.retiredAt = at;
    worker.updatedAt = at;
    this.store.putWorker(current);
    for (const sub of this.store.liveSubscribers(current.tenantId, current.subject.key)) {
      if (sub.workerId === current.workerId) {
        this.store.retireSubscription(current.tenantId, sub.subscriptionId, at);
      }
    }
    this.audit(current.tenantId, current.workerId, 'retired', at, { reason });
    this.scheduler.markDone(current.tenantId, current.workerId);
    await this.admitTenant(current.tenantId);
  }

  private async stop(worker: WorkerRecord, at: number, reason: string): Promise<void> {
    const current = this.store.worker(worker.tenantId, worker.workerId) ?? worker;
    current.state = 'stuck';
    current.updatedAt = at;
    worker.state = 'stuck';
    worker.updatedAt = at;
    this.store.putWorker(current);
    this.audit(current.tenantId, current.workerId, 'stopped', at, { reason });
    this.recordWatchdogLesson(current, 'stop', reason, at);
  }

  private async nudge(worker: WorkerRecord, at: number, detail: string): Promise<void> {
    const current = this.store.worker(worker.tenantId, worker.workerId);
    if (!current || !isLiveState(current.state)) return;
    current.nudges = (current.nudges ?? 0) + 1;
    current.updatedAt = at;
    this.store.putWorker(current);
    const event: NormalizedEvent = {
      eventId: this.ids.event(),
      tenantId: current.tenantId,
      source: 'internal',
      type: 'watchdog_nudge',
      subject: current.subject,
      idempotencyKey: `nudge:${current.workerId}:${current.nudges}`,
      actor: { login: 'watchdog', kind: 'system' },
      occurredAt: at,
      receivedAt: at,
      summary: 'Watchdog nudged the worker.',
      fields: [['detail', detail]],
      closesSubject: false,
    };
    this.store.putEvent(event);
    this.store.enqueue(current.workerId, event.eventId, at);
    this.audit(current.tenantId, current.workerId, 'nudged', at, {
      nudges: current.nudges,
      detail,
    });
    if (this.learning.enabled) {
      this.recordLesson({
        tenantId: current.tenantId,
        triggerEventId: event.eventId,
        cause: 'watchdog_correct',
        mistake: `Watchdog nudged: ${detail}`,
        correct: 'Make visible progress or declare a wait (CI/review/human).',
        scope: current.subject.repo ?? 'tenant',
        workerId: current.workerId,
        at,
      });
    }
  }

  private markStuck(worker: WorkerRecord, at: number): void {
    const current = this.store.worker(worker.tenantId, worker.workerId);
    if (!current || !isLiveState(current.state)) return;
    current.state = 'stuck';
    current.updatedAt = at;
    this.store.putWorker(current);
    this.audit(current.tenantId, current.workerId, 'stuck', at, {});
    this.recordWatchdogLesson(current, 'escalate', 'Watchdog marked the worker stuck.', at);
  }

  private async collectReview(
    worker: WorkerRecord,
    parsed: { repo: string; number: number; sha: string },
    at: number,
  ): Promise<void> {
    if (!this.reviewer) return;
    const { text } = await this.reviewer.review(parsed);
    const receipt = receiptFromReview(text, { ...parsed, at });
    if (!receipt) {
      this.audit(worker.tenantId, worker.workerId, 'review_no_verdict', at, {
        sha: parsed.sha,
        pr: prRef(parsed.repo, parsed.number),
      });
      return;
    }
    worker.reviewReceipts = [...(worker.reviewReceipts ?? []), receipt];
    this.audit(worker.tenantId, worker.workerId, 'review_receipt', at, {
      pr: receipt.pr,
      sha: receipt.sha,
      verdict: receipt.verdict,
    });
    if (receipt.verdict === 'BLOCK' && this.learning.enabled) {
      this.recordLesson({
        tenantId: worker.tenantId,
        triggerEventId: worker.lastEventId ?? this.ids.event(),
        cause: 'review_rejected',
        mistake: receipt.summary,
        correct: 'Address every BLOCK finding before proposing merge.',
        scope: worker.subject.repo ?? 'tenant',
        workerId: worker.workerId,
        at,
      });
    }
  }

  private async readLive(worker: WorkerRecord, at: number): Promise<LiveFacts> {
    const extra = this.liveFacts ? await this.liveFacts(worker) : {};
    let prMerged = extra.prMerged;
    let sha = extra.sha;
    const repo = worker.subject.repo;
    const number = worker.subject.number;
    if (repo && number !== undefined && this.doneWorld.pull) {
      const pull = await this.doneWorld.pull(repo, number);
      prMerged = pull.merged;
      sha = sha ?? pull.mergeSha;
    }
    return { sha, ci: extra.ci, prMerged, at };
  }

  private sandboxFor(worker: WorkerRecord): SandboxPort {
    if (worker.executionTarget?.kind === 'device' && worker.executionTarget.id && this.byom) {
      return this.byom.sandboxFor(
        worker.executionTarget.id,
        worker.tenantId,
        worker.workerId,
        worker.subject.repo,
      );
    }
    return this.sandbox;
  }

  private context(worker: WorkerRecord, event: NormalizedEvent): WorkerContext {
    return {
      worker: { ...worker },
      event,
      sandbox: this.sandboxFor(worker),
      orgSecrets: this.orgSecrets,
      recall: () => recallWithLessons(worker, recallMemory),
      recallLesson: (lessonId) => this.recallLesson(worker.tenantId, lessonId),
      peerReview: this.peerReview.enabled
        ? (input) => this.reviewBeforePublish(worker, input)
        : undefined,
      reportProgress: async (patch) => {
        const live = this.store.worker(worker.tenantId, worker.workerId);
        if (!live) return;
        await this.recordProgress(live, patch, this.now());
        worker.progress = live.progress;
        worker.lastHeartbeatAt = live.lastHeartbeatAt;
        worker.lastProgressAt = live.lastProgressAt;
      },
      pollInbox: () => this.pollDuplexInbox(worker.tenantId, worker.workerId),
      ackInbox: (eventIds) => this.ackDuplexInbox(worker, eventIds),
    };
  }

  private pollDuplexInbox(tenantId: string, workerId: string): NormalizedEvent[] {
    const live = this.store.worker(tenantId, workerId);
    const seen = new Set(live?.seenEventIds ?? []);
    const out: NormalizedEvent[] = [];
    for (const item of this.store.inbox(workerId)) {
      if (item.consumedAt !== null || seen.has(item.eventId)) continue;
      const event = this.store.event(tenantId, item.eventId);
      if (event) out.push(event);
    }
    return out.sort((a, b) => a.receivedAt - b.receivedAt || a.eventId.localeCompare(b.eventId));
  }

  private ackDuplexInbox(worker: WorkerRecord, eventIds: string[]): void {
    const live = this.store.worker(worker.tenantId, worker.workerId);
    if (!live) return;
    const at = this.now();
    const seen = new Set(live.seenEventIds ?? []);
    for (const item of this.store.inbox(worker.workerId)) {
      if (!eventIds.includes(item.eventId) || item.consumedAt !== null) continue;
      this.store.consume(worker.workerId, item.seq, at);
      seen.add(item.eventId);
    }
    live.seenEventIds = rememberEventIds([...seen], eventIds);
    live.updatedAt = at;
    this.store.putWorker(live);
    worker.seenEventIds = live.seenEventIds;
  }

  private async ackDuplexArrival(
    tenantId: string,
    workerId: string,
    event: NormalizedEvent,
    at: number,
  ): Promise<void> {
    const worker = this.store.worker(tenantId, workerId);
    if (!worker) return;
    await this.recordProgress(worker, { activity: DUPLEX_ACK }, at);
    this.audit(tenantId, workerId, 'duplex_ack', at, { eventId: event.eventId });
  }

  private notifyDuplex(workerId: string): void {
    for (const wake of this.duplexWaiters.get(workerId) ?? []) wake();
  }

  private progressView(worker: WorkerRecord, at: number) {
    return viewOf(worker, at, this.store, this.progressSettings, this.watchdogSettings);
  }

  private async surfaceAutonomy(
    worker: WorkerRecord,
    incident: AutonomyIncident,
    at: number,
  ): Promise<void> {
    const live = this.store.worker(worker.tenantId, worker.workerId) ?? worker;
    const next = markApplied({
      ...(live.autonomy ?? worker.autonomy ?? emptyAutonomy()),
      lastIncident: incident,
      pending: { ...incident, applied: true },
    });
    live.autonomy = next;
    worker.autonomy = next;
    const entry = autonomyUsage(live, incident);
    this.store.appendUsageEvent(entry);
    this.metering.record(entry);
    this.audit(live.tenantId, live.workerId, AUTONOMY_LEDGER_KIND[incident.action], at, {
      rule: incident.rule,
      detail: incident.detail,
    });
    await this.recordProgress(
      live,
      {
        activity: incident.detail,
        reason: incident.detail,
      },
      at,
    );
    await this.lead.speak({
      tenantId: live.tenantId,
      workerId: live.workerId,
      text: `Worker ${incident.action}: ${incident.detail}`,
    });
    this.store.putWorker(this.store.worker(live.tenantId, live.workerId) ?? live);
  }

  private async recordProgress(
    worker: WorkerRecord,
    patch: ProgressPatch,
    at: number,
  ): Promise<void> {
    const previous = worker.progress;
    const { progress, phaseChanged } = applyProgressPatch(previous, patch, at);
    worker.progress = progress;
    worker.lastHeartbeatAt = at;
    if (phaseChanged || patch.activity !== undefined) {
      worker.lastProgressAt = at;
      worker.nudges = 0;
    }
    worker.updatedAt = at;
    this.store.putWorker(worker);
    const view = this.progressView(worker, at);
    const kind = nextLeadKind(previous, progress, view, at, this.progressSettings, phaseChanged);
    if (kind) await this.speakProgress(worker, kind, at);
  }

  private async refreshProgressSpeak(worker: WorkerRecord, at: number): Promise<void> {
    const live = this.store.worker(worker.tenantId, worker.workerId);
    if (!live?.progress) return;
    const view = this.progressView(live, at);
    const kind = nextLeadKind(live.progress, live.progress, view, at, this.progressSettings, false);
    if (kind) await this.speakProgress(live, kind, at);
  }

  private async speakProgress(
    worker: WorkerRecord,
    kind: 'phase' | 'still' | 'stuck',
    at: number,
  ): Promise<void> {
    const live = this.store.worker(worker.tenantId, worker.workerId) ?? worker;
    const view = this.progressView(live, at);
    if (kind === 'stuck' && live.progress?.stuckSpoken) return;
    const text = formatLeadProgress(kind, view);
    const progress = live.progress ?? startProgress(at);
    progress.lastLeadAt = at;
    progress.lastLeadKind = kind;
    if (kind === 'stuck') progress.stuckSpoken = true;
    live.progress = progress;
    live.updatedAt = at;
    this.store.putWorker(live);
    await this.lead.speak({ tenantId: live.tenantId, workerId: live.workerId, text });
    this.audit(live.tenantId, live.workerId, `progress_${kind}`, at, {
      phase: view.phase,
      look: view.look,
    });
  }

  private async wakeBox(worker: WorkerRecord): Promise<'ready' | 'wait'> {
    if (worker.executionTarget?.waitReason === 'device_offline') {
      await this.recordProgress(
        worker,
        {
          waiting: { kind: 'human', detail: 'device_offline' },
          activity: 'waiting for paired device',
        },
        this.now(),
      );
      return 'wait';
    }
    if (this.boxPool) {
      try {
        setState(worker, 'waking');
        this.store.putWorker(worker);
        const slot = await this.boxPool.wake(worker.tenantId, worker.workerId, worker.mandate);
        const live = this.store.worker(worker.tenantId, worker.workerId);
        worker.sandboxRef = slot.boxId;
        worker.workspaceRef = slot.workDir;
        if (live?.progress) worker.progress = live.progress;
        this.store.putWorker(worker);
      } catch (error) {
        this.audit(worker.tenantId, worker.workerId, 'sandbox_wake_failed', this.now(), {
          message: error instanceof Error ? error.message : 'shared box wake',
        });
      }
      return 'ready';
    }
    if (!worker.sandboxRef) return 'ready';
    const box = this.sandboxFor(worker);
    try {
      const machine = await box.getMachine(worker.sandboxRef);
      if (machine.state === 'offline') {
        worker.executionTarget = {
          kind: worker.executionTarget?.kind ?? 'device',
          id: worker.sandboxRef,
          waitReason: 'device_offline',
          allowShell: worker.executionTarget?.allowShell,
        };
        await this.recordProgress(
          worker,
          {
            waiting: { kind: 'human', detail: 'device_offline' },
            activity: 'waiting for paired device',
          },
          this.now(),
        );
        this.store.putWorker(worker);
        this.audit(worker.tenantId, worker.workerId, 'device_offline', this.now(), {
          deviceId: worker.sandboxRef,
        });
        return 'wait';
      }
      await box.ensureRunning(worker.sandboxRef);
    } catch (error) {
      if (error instanceof DeviceOfflineError) {
        worker.executionTarget = {
          kind: 'device',
          id: worker.sandboxRef,
          waitReason: 'device_offline',
          allowShell: worker.executionTarget?.allowShell,
        };
        await this.recordProgress(
          worker,
          {
            waiting: { kind: 'human', detail: 'device_offline' },
            activity: 'waiting for paired device',
          },
          this.now(),
        );
        this.store.putWorker(worker);
        this.audit(worker.tenantId, worker.workerId, 'device_offline', this.now(), {
          deviceId: worker.sandboxRef,
        });
        return 'wait';
      }
      this.audit(worker.tenantId, worker.workerId, 'sandbox_wake_failed', this.now(), {
        message: error instanceof Error ? error.message : 'ensureRunning',
      });
    }
    return 'ready';
  }

  private async suspendBox(worker: WorkerRecord): Promise<void> {
    if (this.boxPool) {
      await this.boxPool.release(worker.tenantId, worker.workerId);
      return;
    }
    if (!worker.sandboxRef || this.sandbox.suspend === undefined) return;
    try {
      await this.sandbox.suspend(worker.sandboxRef);
    } catch (error) {
      this.audit(worker.tenantId, worker.workerId, 'sandbox_suspend_failed', this.now(), {
        message: error instanceof Error ? error.message : 'suspend',
      });
    }
  }

  private hydrateLessons(tenantId: string): void {
    if (this.lessonsBook.hydrated(tenantId)) return;
    this.lessonsBook.loadFromAudit(this.store.audit(tenantId));
    this.lessonsBook.markHydrated(tenantId);
  }

  private injectLessons(worker: WorkerRecord): void {
    this.hydrateLessons(worker.tenantId);
    const accepted = this.lessonsBook.acceptedFor(worker.tenantId, worker.subject.repo);
    const { prefix } = formatLessonPrefix(accepted, this.learning.injectBudget);
    if (!prefix) return;
    worker.lessonPrefix = prefix;
    worker.lessonRefs = accepted.map((row) => row.lessonId);
  }

  private noteBounce(worker: WorkerRecord, event: NormalizedEvent, at: number): void {
    const review = reviewBounceOf(event);
    if (review) {
      this.recordLesson({
        tenantId: worker.tenantId,
        triggerEventId: event.eventId,
        cause: review,
        mistake: fieldLabel(event, 'comment') || event.summary,
        correct: 'Address the review findings before pushing again.',
        scope: worker.subject.repo ?? 'tenant',
        workerId: worker.workerId,
        at,
      });
      return;
    }
    if (event.type === 'ci_failed' && (worker.lastPushSha || /pushed /i.test(worker.memory))) {
      worker.ciFailedEventId = event.eventId;
      return;
    }
    if (event.type === 'ci_passed' && worker.ciFailedEventId) {
      this.recordLesson({
        tenantId: worker.tenantId,
        triggerEventId: worker.ciFailedEventId,
        cause: 'ci_failed_then_fixed',
        mistake: `CI failed after push ${worker.lastPushSha ?? ''}`.trim(),
        correct: fieldLabel(event, 'sha')
          ? `Landed a fix that made CI pass at ${fieldLabel(event, 'sha')}.`
          : 'Re-run the repo tests on the box before pushing.',
        scope: worker.subject.repo ?? 'tenant',
        workerId: worker.workerId,
        at,
      });
      worker.ciFailedEventId = null;
    }
  }

  private recordWatchdogLesson(
    worker: WorkerRecord,
    action: string,
    detail: string,
    at: number,
  ): void {
    if (!this.learning.enabled || !isWatchdogCorrectAction(action)) return;
    this.recordLesson({
      tenantId: worker.tenantId,
      triggerEventId: this.putInternalEvent(worker, 'watchdog_correct', at, [
        ['action', action],
        ['detail', detail],
      ]),
      cause: 'watchdog_correct',
      mistake: `Watchdog ${action}: ${detail}`,
      correct: 'Keep a heartbeat, declare waits, and stay inside the mandate budget.',
      scope: worker.subject.repo ?? 'tenant',
      workerId: worker.workerId,
      at,
    });
  }

  private recordLesson(draft: Parameters<LessonBook['record']>[0]): LessonRecord | undefined {
    if (!this.learning.enabled) return undefined;
    this.hydrateLessons(draft.tenantId);
    const lesson = this.lessonsBook.record(draft, this.learning.scrub);
    const already = this.store
      .audit(draft.tenantId)
      .some(
        (row) =>
          row.kind === 'lesson_recorded' && row.detail.triggerEventId === draft.triggerEventId,
      );
    if (!already) {
      this.audit(draft.tenantId, draft.workerId ?? null, 'lesson_recorded', draft.at, {
        ...lessonAuditDetail(lesson),
      });
    }
    if (
      this.learning.distillAfter > 0 &&
      this.lessonsBook.recordedCount(draft.tenantId) % this.learning.distillAfter === 0
    ) {
      this.distillLessons(draft.tenantId, draft.scope || 'tenant');
    }
    return lesson;
  }

  private putInternalEvent(
    worker: WorkerRecord,
    type: string,
    at: number,
    fields: Array<[string, string]>,
  ): string {
    const eventId = this.ids.event();
    this.store.putEvent({
      eventId,
      tenantId: worker.tenantId,
      source: 'internal',
      type,
      subject: worker.subject,
      idempotencyKey: `${type}:${worker.workerId}:${eventId}`,
      actor: { login: 'system', kind: 'system' },
      occurredAt: at,
      receivedAt: at,
      summary: type.replaceAll('_', ' '),
      fields,
      closesSubject: false,
    });
    return eventId;
  }

  private async reviewBeforePublish(
    worker: WorkerRecord,
    input: PeerReviewInput,
  ): Promise<PeerReviewOutcome> {
    const live = this.store.worker(worker.tenantId, worker.workerId) ?? worker;
    const at = this.now();
    const outcome = await runPeerReview({
      settings: this.peerReview,
      diff: input.diff,
      repo: input.repo ?? live.subject.repo,
      currentRounds: live.peerReviewRounds ?? 0,
    });
    if (outcome.usage && !outcome.skipped) {
      this.chargeUsage(live, outcome.usage, at);
      worker.usage = live.usage;
    }
    if (outcome.skipped) {
      this.audit(live.tenantId, live.workerId, 'peer_review_skipped', at, {
        reason: outcome.skipped,
      });
      return outcome;
    }
    live.peerReviewRounds = outcome.rounds;
    worker.peerReviewRounds = outcome.rounds;
    this.store.putWorker(live);
    this.audit(live.tenantId, live.workerId, 'peer_review', at, {
      severity: outcome.severity,
      waiting: outcome.waiting,
      rounds: outcome.rounds,
      tokens: outcome.usage?.tokens ?? 0,
      usdMicros: outcome.usage?.usdMicros ?? 0,
    });
    if (outcome.severity === 'block' && this.learning.enabled) {
      this.recordLesson({
        tenantId: live.tenantId,
        triggerEventId: this.putInternalEvent(live, 'peer_review_block', at, [
          ['severity', outcome.severity],
          ['feedback', outcome.feedback.slice(0, 400)],
        ]),
        cause: 'peer_review',
        mistake: outcome.feedback,
        correct: outcome.correct ?? 'Fix blocking peer-review findings before push.',
        scope: live.subject.repo ?? input.repo ?? 'tenant',
        workerId: live.workerId,
        at,
      });
    }
    return outcome;
  }

  private chargeUsage(
    worker: WorkerRecord,
    usage: Partial<WorkerRecord['usage']>,
    at: number,
  ): void {
    const delta = {
      tokens: usage.tokens ?? 0,
      usdMicros: usage.usdMicros ?? 0,
      wallMs: usage.wallMs ?? 0,
    };
    worker.usage = {
      tokens: worker.usage.tokens + delta.tokens,
      usdMicros: worker.usage.usdMicros + delta.usdMicros,
      wallMs: worker.usage.wallMs + delta.wallMs,
      inputTokens: (worker.usage.inputTokens ?? 0) + (usage.inputTokens ?? 0),
      outputTokens: (worker.usage.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    };
    this.store.putUsage(worker.tenantId, worker.workerId, worker.usage, at);
    this.store.appendUsageEvent({
      tenantId: worker.tenantId,
      workerId: worker.workerId,
      ...delta,
      at,
    });
    this.metering.record({
      tenantId: worker.tenantId,
      workerId: worker.workerId,
      ...delta,
      at,
    });
  }

  private audit(
    tenantId: string,
    workerId: string | null,
    kind: string,
    at: number,
    detail: Record<string, string | number | boolean | null>,
  ): void {
    this.store.appendAudit({
      auditId: this.ids.audit(),
      tenantId,
      workerId,
      kind,
      at,
      detail,
    });
  }
}

function fieldLabel(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}
