import type { IngestInput } from './events.js';
import { normalize } from './events.js';
import { defaultIds } from './ids.js';
import { admit, HeuristicJudge } from './router.js';
import { overBudget, Safety } from './safety.js';
import type { SuperagentStore } from './store.js';
import { MemorySuperagentStore } from './memory-store.js';
import {
  emptyUsage,
  isLiveState,
  type NormalizedEvent,
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
import { UnconfiguredOrgSecrets } from './secrets.js';
import { type StuckCard, stuckCardOf } from './stuck.js';
import { runWatchdog } from './watchdog.js';

export type IngestResult =
  | { result: 'rejected'; reason: string; judgeCalls: 0 }
  | { result: 'duplicate'; eventId: string; judgeCalls: 0 }
  | { result: 'ignored'; reason: string; eventId?: string; judgeCalls: number }
  | { result: 'passthrough'; eventId: string; workerIds: string[]; judgeCalls: 0 }
  | { result: 'answered'; eventId: string; text: string; judgeCalls: number }
  | { result: 'spawned'; eventId: string; workerId: string; judgeCalls: number };

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
  /** Interface only. Default refuses every inject. */
  orgSecrets?: OrgSecretPort;
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
  readonly escalations: StuckCard[] = [];
  judgeCalls = 0;
  private readonly now: () => number;
  private readonly onEscalate?: (card: StuckCard) => void;

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
      },
      at,
    );
    for (const found of findings) {
      if (found.action !== 'escalate' && found.action !== 'stop') continue;
      const worker = this.store.worker(found.tenantId, found.workerId);
      if (!worker) continue;
      const card = stuckCardOf(worker, found, at);
      this.escalations.push(card);
      this.onEscalate?.(card);
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
      plan: '',
      transcriptPointer: null,
      sandboxRef: null,
      workspaceRef: null,
      lastEventId: null,
      lastProgressAt: at,
      lastHeartbeatAt: at,
      lastStepSignature: null,
      stepRepeats: 0,
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
    if (worker.state === 'stuck') return;

    const pending = this.store.inbox(workerId).filter((item) => item.consumedAt === null);
    if (pending.length === 0) {
      if (worker.state === 'running' || worker.state === 'waking' || worker.state === 'spawning') {
        worker.state = 'sleeping';
        worker.updatedAt = this.now();
        this.store.putWorker(worker);
      }
      return;
    }

    setState(worker, 'running');
    for (const item of pending) {
      const event = this.store.event(tenantId, item.eventId);
      if (!event) {
        this.store.consume(workerId, item.seq, this.now());
        continue;
      }
      const at = this.now();
      worker.lastHeartbeatAt = at;
      worker.lastEventId = event.eventId;
      worker.updatedAt = at;
      if (event.closesSubject) {
        worker.subject = { ...worker.subject, closed: true };
        this.store.putWorker(worker);
        await this.finishClose(worker, event, at);
        this.store.consume(workerId, item.seq, at);
        return;
      }
      try {
        const result = await this.handler.handle({ worker: { ...worker }, event }, event);
        const halt = this.applyResult(worker, result, at);
        this.store.consume(workerId, item.seq, at);
        if (halt) {
          this.store.putWorker(worker);
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
    }
    if (worker.state === 'running') setState(worker, 'sleeping');
    worker.updatedAt = this.now();
    this.store.putWorker(worker);
  }

  private applyResult(worker: WorkerRecord, result: HandlerResult, at: number): boolean {
    if (result.memory !== undefined) worker.memory = result.memory;
    if (result.plan !== undefined) worker.plan = result.plan;
    if (result.transcriptPointer !== undefined) worker.transcriptPointer = result.transcriptPointer;
    if (result.progress) worker.lastProgressAt = at;
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
    if (result.action) {
      const gate = this.safety.gate(worker, result.action, at);
      if (!gate.allowed && gate.reason === 'intensity_observe') {
        this.audit(worker.tenantId, worker.workerId, 'action_refused', at, {
          kind: result.action.kind,
          reason: 'intensity_observe',
        });
      } else if (!gate.allowed && gate.reason === 'held') {
        worker.state = 'awaiting_approval';
        this.audit(worker.tenantId, worker.workerId, 'awaiting_approval', at, {
          approvalId: gate.approvalId,
          kind: result.action.kind,
        });
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
      const result = await this.handler.handle({ worker: { ...worker }, event }, event);
      this.applyResult(worker, result, at);
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
    if (!current || current.state === 'retired') return;
    current.state = 'retired';
    current.retiredAt = at;
    current.updatedAt = at;
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

  private markStuck(worker: WorkerRecord, at: number): void {
    const current = this.store.worker(worker.tenantId, worker.workerId);
    if (!current || !isLiveState(current.state)) return;
    current.state = 'stuck';
    current.updatedAt = at;
    this.store.putWorker(current);
    this.audit(current.tenantId, current.workerId, 'stuck', at, {});
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
