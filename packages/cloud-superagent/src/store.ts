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
  /** Append-only per-tenant usage (T17). Package-local; not a cloud-server migration. */
  appendUsageEvent(entry: UsageEntry): void;
  usageEvents(tenantId: string): UsageEntry[];
  tenantUsage(tenantId: string): {
    tenantId: string;
    tokens: number;
    usdMicros: number;
    wallMs: number;
    events: number;
  };

  /**
   * Tenant JSON documents (scheduler queue, router config). Not a schema
   * migration: sqlite uses `documents` created IF NOT EXISTS, no user_version bump.
   */
  putDocument(tenantId: string, kind: string, json: string, at: number): void;
  getDocument(tenantId: string, kind: string): string | undefined;
  listDocumentTenants(kind?: string): string[];

  /** Tenant box JSON. No sqlite schema bump — reserved retired worker row. */
  putTenantBox(box: TenantBoxRecord): void;
  tenantBox(tenantId: string): TenantBoxRecord | undefined;
  allTenantBoxes(): TenantBoxRecord[];

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
      box: worker.mandate.box ? { ...worker.mandate.box } : undefined,
    },
    usage: { ...worker.usage },
    box: worker.box ? cloneTenantBox(worker.box) : undefined,
    evidence: (worker.evidence ?? []).map((block) => ({ ...block })),
    spills: (worker.spills ?? []).map((row) => ({ ...row })),
    reviewReceipts: (worker.reviewReceipts ?? []).map((row) => ({ ...row })),
    lessonRefs: worker.lessonRefs?.slice(),
    doneClaim: worker.doneClaim
      ? { ...worker.doneClaim, signals: worker.doneClaim.signals.map((row) => ({ ...row })) }
      : undefined,
    lastLive: worker.lastLive ? { ...worker.lastLive } : undefined,
    routeRule: worker.routeRule
      ? { ...worker.routeRule, skills: worker.routeRule.skills?.slice() }
      : undefined,
    peerReviewStats: worker.peerReviewStats
      ? {
          ...worker.peerReviewStats,
          openFindings: [...worker.peerReviewStats.openFindings],
        }
      : undefined,
    releaseVerify: worker.releaseVerify ? { ...worker.releaseVerify } : undefined,
    seenEventIds: worker.seenEventIds ? [...worker.seenEventIds] : undefined,
    executionTarget: worker.executionTarget ? { ...worker.executionTarget } : undefined,
    speculative: worker.speculative
      ? {
          ...worker.speculative,
          cost: worker.speculative.cost ? { ...worker.speculative.cost } : undefined,
        }
      : undefined,
    autonomy: worker.autonomy
      ? {
          ...worker.autonomy,
          lastIncident: worker.autonomy.lastIncident
            ? { ...worker.autonomy.lastIncident }
            : undefined,
          pending: worker.autonomy.pending ? { ...worker.autonomy.pending } : undefined,
        }
      : undefined,
    progress: worker.progress
      ? {
          ...worker.progress,
          phases: [...worker.progress.phases],
          waiting: worker.progress.waiting ? { ...worker.progress.waiting } : undefined,
          samples: worker.progress.samples
            ? Object.fromEntries(
                Object.entries(worker.progress.samples).map(([phase, rows]) => [
                  phase,
                  [...(rows ?? [])],
                ]),
              )
            : undefined,
        }
      : undefined,
  };
}

export function cloneTenantBox(box: TenantBoxRecord): TenantBoxRecord {
  return { ...box, activeWorkers: [...box.activeWorkers] };
}

export const TERMINAL_OR_HELD: readonly WorkerState[] = [
  'retired',
  'retiring',
  'awaiting_approval',
];
