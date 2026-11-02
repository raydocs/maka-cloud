import type {
  ApprovalRecord,
  AuditRecord,
  InboxItem,
  NormalizedEvent,
  Subscription,
  Usage,
  WorkerRecord,
  WorkerState,
} from './types.js';

export interface SuperagentStore {
  putEvent(event: NormalizedEvent): 'stored' | 'duplicate';
  event(tenantId: string, eventId: string): NormalizedEvent | undefined;
  eventByIdempotency(tenantId: string, key: string): NormalizedEvent | undefined;

  putWorker(worker: WorkerRecord): void;
  worker(tenantId: string, workerId: string): WorkerRecord | undefined;
  liveWorkerBySubject(tenantId: string, subjectKey: string): WorkerRecord | undefined;
  workers(tenantId: string): WorkerRecord[];
  allWorkers(): WorkerRecord[];

  putSubscription(sub: Subscription): void;
  liveSubscribers(tenantId: string, subjectKey: string): Subscription[];
  retireSubscription(tenantId: string, subscriptionId: string, at: number): void;

  enqueue(workerId: string, eventId: string, at: number): number;
  putInbox(item: InboxItem): void;
  inbox(workerId: string): InboxItem[];
  consume(workerId: string, seq: number, at: number): void;

  putApproval(row: ApprovalRecord): void;
  approval(tenantId: string, approvalId: string): ApprovalRecord | undefined;
  approvalsFor(tenantId: string, workerId: string): ApprovalRecord[];
  pendingApprovals(tenantId: string, workerId?: string): ApprovalRecord[];

  appendAudit(row: AuditRecord): void;
  audit(tenantId: string): AuditRecord[];

  putUsage(tenantId: string, workerId: string, usage: Usage, at: number): void;
  usage(tenantId: string, workerId: string): Usage | undefined;

  close(): void;
  backupTo?(destination: string): Promise<void>;
}

export function cloneWorker(worker: WorkerRecord): WorkerRecord {
  return {
    ...worker,
    subject: { ...worker.subject },
    mandate: {
      ...worker.mandate,
      scope: { repos: [...worker.mandate.scope.repos], paths: worker.mandate.scope.paths?.slice() },
      budgets: { ...worker.mandate.budgets },
    },
    usage: { ...worker.usage },
  };
}

export const TERMINAL_OR_HELD: readonly WorkerState[] = [
  'retired',
  'retiring',
  'awaiting_approval',
];
