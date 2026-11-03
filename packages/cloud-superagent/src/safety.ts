import type { SuperagentStore } from './store.js';
import { parseMergeBound } from './loop.js';
import { hasClearReceipt, prRef } from './review.js';
import { speculativeBlocksOutbound } from './speculative.js';
import type {
  ApprovalKind,
  ApprovalRecord,
  IdFactory,
  ProposedAction,
  WorkerRecord,
} from './types.js';

export const RISKY_ACTIONS: readonly ApprovalKind[] = [
  'merge',
  'push_protected',
  'secrets',
  'deploy',
  'spend',
  'other_irreversible',
];

export type GateResult =
  | { allowed: true }
  | { allowed: false; reason: 'intensity_observe' }
  | { allowed: false; reason: 'review_required' }
  | { allowed: false; reason: 'speculative_blocked' }
  | { allowed: false; reason: 'held'; approvalId: string };

export function isRisky(kind: ApprovalKind): boolean {
  return (RISKY_ACTIONS as readonly string[]).includes(kind);
}

export function overBudget(worker: WorkerRecord): string | undefined {
  const { budgets } = worker.mandate;
  if (budgets.usd !== undefined && worker.usage.usdMicros >= Math.round(budgets.usd * 1_000_000)) {
    return 'usd';
  }
  if (budgets.tokens !== undefined && worker.usage.tokens >= budgets.tokens) return 'tokens';
  if (budgets.wallMs !== undefined && worker.usage.wallMs >= budgets.wallMs) return 'wallMs';
  return undefined;
}

export class Safety {
  constructor(
    private readonly store: SuperagentStore,
    private readonly ids: IdFactory,
    private readonly approvalTtlMs: number,
  ) {}

  gate(worker: WorkerRecord, action: ProposedAction, at: number): GateResult {
    if (speculativeBlocksOutbound(worker, action)) {
      return { allowed: false, reason: 'speculative_blocked' };
    }
    if (!isRisky(action.kind)) return { allowed: true };
    if (worker.mandate.intensity === 'observe') {
      return { allowed: false, reason: 'intensity_observe' };
    }
    if (action.kind === 'merge' && !mergeReceiptOk(worker, action)) {
      return { allowed: false, reason: 'review_required' };
    }
    if (this.approvedFor(worker, action)) return { allowed: true };
    const existing = this.store
      .pendingApprovals(worker.tenantId, worker.workerId)
      .find((row) => row.kind === action.kind && row.boundText === action.boundText);
    if (existing) return { allowed: false, reason: 'held', approvalId: existing.approvalId };
    const row: ApprovalRecord = {
      approvalId: this.ids.approval(),
      tenantId: worker.tenantId,
      workerId: worker.workerId,
      kind: action.kind,
      boundText: action.boundText,
      state: 'pending',
      createdAt: at,
      expiresAt: at + this.approvalTtlMs,
      decidedAt: null,
    };
    this.store.putApproval(row);
    return { allowed: false, reason: 'held', approvalId: row.approvalId };
  }

  approvedFor(worker: WorkerRecord, action: ProposedAction): boolean {
    return this.store
      .approvalsFor(worker.tenantId, worker.workerId)
      .some(
        (row) =>
          row.state === 'approved' &&
          row.kind === action.kind &&
          row.boundText === action.boundText,
      );
  }

  decide(
    tenantId: string,
    approvalId: string,
    boundText: string,
    state: 'approved' | 'denied',
    at: number,
  ): { ok: true; approval: ApprovalRecord } | { ok: false; reason: string } {
    const row = this.store.approval(tenantId, approvalId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.state !== 'pending') return { ok: false, reason: 'not_pending' };
    if (row.boundText !== boundText) return { ok: false, reason: 'text_mismatch' };
    if (row.expiresAt <= at) {
      this.store.putApproval({ ...row, state: 'expired', decidedAt: at });
      return { ok: false, reason: 'expired' };
    }
    const next = { ...row, state, decidedAt: at };
    this.store.putApproval(next);
    return { ok: true, approval: next };
  }
}

function mergeReceiptOk(worker: WorkerRecord, action: ProposedAction): boolean {
  const parsed = parseMergeBound(action.boundText);
  if (!parsed) return false;
  return hasClearReceipt(worker.reviewReceipts, prRef(parsed.repo, parsed.number), parsed.sha);
}
