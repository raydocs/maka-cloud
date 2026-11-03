import { cloneTenantBox, cloneWorker, type SuperagentStore } from './store.js';
import type {
  ApprovalRecord,
  AuditRecord,
  InboxItem,
  NormalizedEvent,
  Subscription,
  TenantBoxRecord,
  Usage,
  UsageEntry,
  WorkerRecord,
} from './types.js';
import { emptyUsage, isLiveState, isTenantBoxWorkerId } from './types.js';

function sameTenant<T extends { tenantId: string }>(
  row: T | undefined,
  tenantId: string,
): T | undefined {
  return row && row.tenantId === tenantId ? row : undefined;
}

export class MemorySuperagentStore implements SuperagentStore {
  private readonly events = new Map<string, NormalizedEvent>();
  private readonly eventsByIdem = new Map<string, string>();
  private readonly workerRows = new Map<string, WorkerRecord>();
  private readonly subs = new Map<string, Subscription>();
  private readonly inboxRows = new Map<string, InboxItem[]>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly audits: AuditRecord[] = [];
  private readonly usageRows = new Map<string, Usage>();
  private readonly usageEventRows: UsageEntry[] = [];
  private readonly boxRows = new Map<string, TenantBoxRecord>();

  putEvent(event: NormalizedEvent): 'stored' | 'duplicate' {
    const idem = `${event.tenantId}:${event.idempotencyKey}`;
    if (this.eventsByIdem.has(idem)) return 'duplicate';
    this.events.set(event.eventId, structuredClone(event));
    this.eventsByIdem.set(idem, event.eventId);
    return 'stored';
  }

  event(tenantId: string, eventId: string): NormalizedEvent | undefined {
    return sameTenant(this.events.get(eventId), tenantId);
  }

  eventByIdempotency(tenantId: string, key: string): NormalizedEvent | undefined {
    const id = this.eventsByIdem.get(`${tenantId}:${key}`);
    return id === undefined ? undefined : this.event(tenantId, id);
  }

  putWorker(worker: WorkerRecord): void {
    this.workerRows.set(worker.workerId, cloneWorker(worker));
    if (worker.box && isTenantBoxWorkerId(worker.workerId)) {
      this.boxRows.set(worker.tenantId, cloneTenantBox(worker.box));
    }
  }

  worker(tenantId: string, workerId: string): WorkerRecord | undefined {
    const row = sameTenant(this.workerRows.get(workerId), tenantId);
    return row ? cloneWorker(row) : undefined;
  }

  liveWorkerBySubject(tenantId: string, subjectKey: string): WorkerRecord | undefined {
    for (const row of this.workerRows.values()) {
      if (row.tenantId === tenantId && row.subject.key === subjectKey && isLiveState(row.state)) {
        return cloneWorker(row);
      }
    }
    return undefined;
  }

  workers(tenantId: string): WorkerRecord[] {
    return [...this.workerRows.values()]
      .filter((row) => row.tenantId === tenantId && !isTenantBoxWorkerId(row.workerId))
      .map(cloneWorker);
  }

  allWorkers(): WorkerRecord[] {
    return [...this.workerRows.values()]
      .filter((row) => !isTenantBoxWorkerId(row.workerId))
      .map(cloneWorker);
  }

  putSubscription(sub: Subscription): void {
    this.subs.set(sub.subscriptionId, { ...sub });
  }

  liveSubscribers(tenantId: string, subjectKey: string): Subscription[] {
    return [...this.subs.values()].filter(
      (sub) => sub.tenantId === tenantId && sub.subjectKey === subjectKey && sub.retiredAt === null,
    );
  }

  retireSubscription(tenantId: string, subscriptionId: string, at: number): void {
    const sub = this.subs.get(subscriptionId);
    if (!sub || sub.tenantId !== tenantId) return;
    sub.retiredAt = at;
  }

  enqueue(workerId: string, eventId: string, at: number): number {
    const list = this.inboxRows.get(workerId) ?? [];
    const seq = list.length === 0 ? 1 : list[list.length - 1].seq + 1;
    list.push({ workerId, seq, eventId, deliveredAt: at, consumedAt: null });
    this.inboxRows.set(workerId, list);
    return seq;
  }

  putInbox(item: InboxItem): void {
    const list = this.inboxRows.get(item.workerId) ?? [];
    list.push({ ...item });
    list.sort((a, b) => a.seq - b.seq);
    this.inboxRows.set(item.workerId, list);
  }

  inbox(workerId: string): InboxItem[] {
    return (this.inboxRows.get(workerId) ?? []).map((item) => ({ ...item }));
  }

  consume(workerId: string, seq: number, at: number): void {
    const item = (this.inboxRows.get(workerId) ?? []).find((row) => row.seq === seq);
    if (item && item.consumedAt === null) item.consumedAt = at;
  }

  putApproval(row: ApprovalRecord): void {
    this.approvals.set(row.approvalId, { ...row });
  }

  approval(tenantId: string, approvalId: string): ApprovalRecord | undefined {
    const row = sameTenant(this.approvals.get(approvalId), tenantId);
    return row ? { ...row } : undefined;
  }

  approvalsFor(tenantId: string, workerId: string): ApprovalRecord[] {
    return [...this.approvals.values()]
      .filter((row) => row.tenantId === tenantId && row.workerId === workerId)
      .map((row) => ({ ...row }));
  }

  pendingApprovals(tenantId: string, workerId?: string): ApprovalRecord[] {
    return [...this.approvals.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        row.state === 'pending' &&
        (workerId === undefined || row.workerId === workerId),
    );
  }

  appendAudit(row: AuditRecord): void {
    this.audits.push({ ...row, detail: { ...row.detail } });
  }

  audit(tenantId: string): AuditRecord[] {
    return this.audits.filter((row) => row.tenantId === tenantId).map((row) => ({ ...row }));
  }

  putUsage(tenantId: string, workerId: string, usage: Usage, _at: number): void {
    this.usageRows.set(`${tenantId}:${workerId}`, { ...usage });
  }

  usage(tenantId: string, workerId: string): Usage | undefined {
    const row = this.usageRows.get(`${tenantId}:${workerId}`);
    return row ? { ...row } : emptyUsage();
  }

  appendUsageEvent(entry: UsageEntry): void {
    this.usageEventRows.push({ ...entry });
  }

  usageEvents(tenantId: string): UsageEntry[] {
    return this.usageEventRows
      .filter((row) => row.tenantId === tenantId)
      .map((row) => ({ ...row }));
  }

  tenantUsage(tenantId: string): {
    tenantId: string;
    tokens: number;
    usdMicros: number;
    wallMs: number;
    events: number;
  } {
    const events = this.usageEvents(tenantId);
    return {
      tenantId,
      tokens: events.reduce((sum, row) => sum + row.tokens, 0),
      usdMicros: events.reduce((sum, row) => sum + row.usdMicros, 0),
      wallMs: events.reduce((sum, row) => sum + row.wallMs, 0),
      events: events.length,
    };
  }

  putTenantBox(box: TenantBoxRecord): void {
    this.boxRows.set(box.tenantId, cloneTenantBox(box));
  }

  tenantBox(tenantId: string): TenantBoxRecord | undefined {
    const row = this.boxRows.get(tenantId);
    return row ? cloneTenantBox(row) : undefined;
  }

  allTenantBoxes(): TenantBoxRecord[] {
    return [...this.boxRows.values()].map(cloneTenantBox);
  }

  close(): void {
    this.events.clear();
    this.workerRows.clear();
    this.boxRows.clear();
  }
}
