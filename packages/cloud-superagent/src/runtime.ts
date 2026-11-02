import type { IngestInput } from './events.js';
import { normalize } from './events.js';
import { defaultIds } from './ids.js';
import { admit, admitSpawn, HeuristicJudge, isStatusAsk } from './router.js';
import { overBudget, Safety } from './safety.js';
import type { SuperagentStore } from './store.js';
import { MemorySuperagentStore } from './memory-store.js';
import {
  emptyUsage,
  isLiveState,
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
import { FakeSandbox, type SandboxPort } from './sandbox.js';
import { UnconfiguredOrgSecrets } from './secrets.js';
import { recallMemory, spillMemory } from './spill.js';
import { type StuckCard, stuckCardOf } from './stuck.js';
import { runWatchdog } from './watchdog.js';

export type IngestResult =
  | { result: 'rejected'; reason: string; judgeCalls: 0 }
  | { result: 'duplicate'; eventId: string; judgeCalls: 0 }
  | { result: 'ignored'; reason: string; eventId?: string; judgeCalls: number }
  | { result: 'passthrough'; eventId: string; workerIds: string[]; judgeCalls: 0 }
  | { result: 'answered'; eventId: string; text: string; judgeCalls: number }
  | { result: 'spawned'; eventId: string; workerId: string; judgeCalls: number };

/** Collapse a worker inbox into one event. Approval wins over the latest row. */
export function coalesceInbox(events: NormalizedEvent[]): NormalizedEvent {
  if (events.length === 0) throw new Error('coalesceInbox needs events');
  const first = events[0];
  if (events.length === 1 && first) return first;
  const approval = [...events].reverse().find((row) => row.type === 'approval_granted');
  const primary = approval ?? events[events.length - 1] ?? first;
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
  readonly lead: LeadPort;
  readonly reviewer: ReviewerPort | undefined;
  readonly doneWorld: DoneWorld;
  readonly progressSettings: ProgressSettings;
  private readonly liveFacts?: (worker: WorkerRecord) => Promise<Partial<LiveFacts>>;
  readonly escalations: StuckCard[] = [];
  judgeCalls = 0;
  private readonly now: () => number;
  private readonly onEscalate?: (card: StuckCard) => void;
  private readonly defaultSandboxRef: string | null;

  constructor(options: SuperagentOptions = {}) {
    this.store = options.store ?? new MemorySuperagentStore();
    this.judge = options.judge ?? new HeuristicJudge();
    this.handler = options.handler ?? new SilentHandler();
    this.ids = options.ids ?? defaultIds();
    this.now = options.clock ?? Date.now;
    this.admission = options.admission ?? {};
    this.watchdogSettings = { ...DEFAULT_WATCHDOG, ...options.watchdog };
    this.metering = options.metering ?? { record() {} };
    this.safety = new Safety(this.store, this.ids, this.watchdogSettings.approvalTtlMs);
    this.onEscalate = options.onEscalate;
    this.orgSecrets = options.orgSecrets ?? new UnconfiguredOrgSecrets();
    this.sandbox = options.sandbox ?? new FakeSandbox();
    this.defaultSandboxRef = options.sandboxRef ?? null;
    this.lead = options.lead ?? new SilentLead();
    this.reviewer = options.reviewer;
    this.doneWorld = defaultDoneWorld(options.doneWorld ?? {});
    this.progressSettings = { ...DEFAULT_PROGRESS, ...options.progress };
    this.liveFacts = options.liveFacts;
  }

  ledger(tenantId: string) {
    return this.store.tenantUsage(tenantId);
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const at = this.now();
    const normalized = normalize(input, at);
    if (!normalized.ok) return { result: 'rejected', reason: normalized.reason, judgeCalls: 0 };
    const event: NormalizedEvent = { ...normalized.event, eventId: this.ids.event() };
    const stored = this.store.putEvent(event);
    if (stored === 'duplicate') {
      const existing = this.store.eventByIdempotency(event.tenantId, event.idempotencyKey);
      this.audit(event.tenantId, null, 'duplicate', at, { key: event.idempotencyKey });
      return { result: 'duplicate', eventId: existing?.eventId ?? event.eventId, judgeCalls: 0 };
    }
    if (event.type === 'ping' || event.subject === null) {
      this.audit(event.tenantId, null, 'ignored', at, {
        reason: event.type === 'ping' ? 'ping' : 'no_subject',
      });
      return {
        result: 'ignored',
        reason: event.type === 'ping' ? 'ping' : 'no_subject',
        eventId: event.eventId,
        judgeCalls: 0,
      };
    }

    const subscribers = this.store.liveSubscribers(event.tenantId, event.subject.key);
    if (isStatusAsk(event)) {
      const owned =
        this.store.liveWorkerBySubject(event.tenantId, event.subject.key) ??
        (subscribers[0] ? this.store.worker(event.tenantId, subscribers[0].workerId) : undefined);
      if (owned) {
        const reported = await this.reportToLead(event.tenantId, owned.workerId);
        if (reported.ok) {
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
        await this.drain(event.tenantId, sub.workerId);
        workerIds.push(sub.workerId);
      }
      this.audit(event.tenantId, workerIds[0] ?? null, 'passthrough', at, {
        eventId: event.eventId,
        workers: workerIds.length,
      });
      return { result: 'passthrough', eventId: event.eventId, workerIds, judgeCalls: 0 };
    }

    const meter = this.metering.admit?.(event.tenantId) === 'stop';
    const admission = admit(event, this.admission, meter);
    if (!admission.ok) {
      this.audit(event.tenantId, null, 'filtered', at, { reason: admission.reason });
      return { result: 'ignored', reason: admission.reason, eventId: event.eventId, judgeCalls: 0 };
    }

    this.judgeCalls += 1;
    const decision = await this.judge.decide(event, {
      workers: this.store.workers(event.tenantId),
    });
    if (decision.action === 'ignore') {
      this.audit(event.tenantId, null, 'ignored', at, { reason: decision.reason });
      return { result: 'ignored', reason: decision.reason, eventId: event.eventId, judgeCalls: 1 };
    }
    if (decision.action === 'answer') {
      await this.lead.speak({ tenantId: event.tenantId, text: decision.text });
      this.audit(event.tenantId, null, 'answered', at, {});
      return { result: 'answered', eventId: event.eventId, text: decision.text, judgeCalls: 1 };
    }

    const existing = this.store.liveWorkerBySubject(event.tenantId, event.subject.key);
    if (existing) {
      return {
        result: 'ignored',
        reason: 'already_owned',
        eventId: event.eventId,
        judgeCalls: 1,
      };
    }

    const boxedLive = this.store
      .allWorkers()
      .filter((row) => isLiveState(row.state) && row.sandboxRef).length;
    const spawnGate = admitSpawn({
      boxedLive,
      wouldBox: Boolean(this.defaultSandboxRef),
      tenantUsdMicros: this.store.tenantUsage(event.tenantId).usdMicros,
      policy: this.admission,
    });
    if (!spawnGate.ok) {
      this.audit(event.tenantId, null, 'filtered', at, { reason: spawnGate.reason });
      return {
        result: 'ignored',
        reason: spawnGate.reason,
        eventId: event.eventId,
        judgeCalls: 1,
      };
    }

    const worker = this.spawn(event, decision.mandate, at);
    this.store.enqueue(worker.workerId, event.eventId, at);
    await this.drain(event.tenantId, worker.workerId);
    this.audit(event.tenantId, worker.workerId, 'spawned', at, { subject: event.subject.key });
    return {
      result: 'spawned',
      eventId: event.eventId,
      workerId: worker.workerId,
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
    return statusSnapshotOf(
      this.store,
      this.now(),
      this.progressSettings,
      this.watchdogSettings,
      tenantId,
    );
  }

  async restore(): Promise<{ resumed: number }> {
    let resumed = 0;
    for (const worker of this.store.allWorkers()) {
      if (worker.state === 'spawning' || worker.state === 'running' || worker.state === 'waking') {
        await this.drain(worker.tenantId, worker.workerId);
        resumed += 1;
      }
    }
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
    for (const found of findings) {
      if (found.rule === 'stuck' || found.rule === 'crashed') {
        const worker = this.store.worker(found.tenantId, found.workerId);
        if (worker) await this.speakProgress(worker, 'stuck', at);
      }
      if (found.action !== 'escalate' && found.action !== 'stop') continue;
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

  close(): void {
    this.store.close();
  }

  private spawn(
    event: NormalizedEvent,
    mandate: WorkerRecord['mandate'],
    at: number,
  ): WorkerRecord {
    const subject = event.subject;
    if (!subject) throw new Error('Cannot spawn without a subject.');
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
      sandboxRef: this.defaultSandboxRef,
      workspaceRef: null,
      lastEventId: null,
      lastProgressAt: at,
      lastHeartbeatAt: at,
      lastStepSignature: null,
      stepRepeats: 0,
      progress: startProgress(at),
      usage: emptyUsage(),
      evidence: [],
      createdAt: at,
      updatedAt: at,
      retiredAt: null,
    };
    this.store.putWorker(worker);
    this.store.putSubscription({
      subscriptionId: this.ids.subscription(),
      tenantId: event.tenantId,
      subjectKey: subject.key,
      workerId: worker.workerId,
      createdAt: at,
      retiredAt: null,
    });
    return worker;
  }

  private async drain(tenantId: string, workerId: string): Promise<void> {
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

    await this.wakeBox(worker);
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
    try {
      const result = await this.handler.handle(this.context(worker, event), event);
      const halt = await this.applyResult(worker, result, at);
      for (const item of items) this.store.consume(workerId, item.seq, at);
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
      const spilled = spillMemory(result.memory, worker.spills ?? [], at);
      worker.memory = spilled.inline;
      worker.spills = spilled.spills;
    }
    if (result.plan !== undefined) worker.plan = result.plan;
    if (result.progressUpdate) await this.recordProgress(worker, result.progressUpdate, at);
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
  }

  private async stop(worker: WorkerRecord, at: number, reason: string): Promise<void> {
    const current = this.store.worker(worker.tenantId, worker.workerId);
    if (!current) return;
    current.state = 'stuck';
    current.updatedAt = at;
    this.store.putWorker(current);
    this.audit(current.tenantId, current.workerId, 'stopped', at, { reason });
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
  }

  private markStuck(worker: WorkerRecord, at: number): void {
    const current = this.store.worker(worker.tenantId, worker.workerId);
    if (!current || !isLiveState(current.state)) return;
    current.state = 'stuck';
    current.updatedAt = at;
    this.store.putWorker(current);
    this.audit(current.tenantId, current.workerId, 'stuck', at, {});
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

  private context(worker: WorkerRecord, event: NormalizedEvent): WorkerContext {
    return {
      worker: { ...worker },
      event,
      sandbox: this.sandbox,
      orgSecrets: this.orgSecrets,
      recall: () => recallMemory(worker),
      reportProgress: async (patch) => {
        const live = this.store.worker(worker.tenantId, worker.workerId);
        if (!live) return;
        await this.recordProgress(live, patch, this.now());
        worker.progress = live.progress;
        worker.lastHeartbeatAt = live.lastHeartbeatAt;
        worker.lastProgressAt = live.lastProgressAt;
      },
    };
  }

  private progressView(worker: WorkerRecord, at: number) {
    return viewOf(worker, at, this.store, this.progressSettings, this.watchdogSettings);
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

  private async wakeBox(worker: WorkerRecord): Promise<void> {
    if (!worker.sandboxRef) return;
    try {
      await this.sandbox.ensureRunning(worker.sandboxRef);
    } catch (error) {
      this.audit(worker.tenantId, worker.workerId, 'sandbox_wake_failed', this.now(), {
        message: error instanceof Error ? error.message : 'ensureRunning',
      });
    }
  }

  private async suspendBox(worker: WorkerRecord): Promise<void> {
    if (!worker.sandboxRef || this.sandbox.suspend === undefined) return;
    try {
      await this.sandbox.suspend(worker.sandboxRef);
    } catch (error) {
      this.audit(worker.tenantId, worker.workerId, 'sandbox_suspend_failed', this.now(), {
        message: error instanceof Error ? error.message : 'suspend',
      });
    }
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
