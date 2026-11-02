import type { WatchdogFinding, WatchdogRule, WorkerRecord } from './types.js';

/** T33 `ask_user` reason. A stuck report is never an approval. */
export const STUCK_REASON = 'stuck' as const;

export interface StuckOption {
  id: string;
  label: string;
  recommended: boolean;
  /** What taking the option costs; omitted when it costs nothing extra. */
  cost?: string;
}

/**
 * T33 stuck-report body: what was tried, where it is stuck, a diagnosis,
 * `sameFailure` when the same step looped, and two to four one-tap options.
 */
export interface StuckCard {
  reason: typeof STUCK_REASON;
  tenantId: string;
  workerId: string;
  subjectKey: string;
  rule: WatchdogRule;
  tried: string[];
  where: string;
  diagnosis: string;
  sameFailure: boolean;
  generation: number;
  idleMinutes: number;
  options: StuckOption[];
}

export const DEFAULT_STUCK_OPTIONS: readonly StuckOption[] = [
  {
    id: 'narrow',
    label: 'Narrow the scope and try a different approach',
    recommended: true,
    cost: 'same Mandate budget',
  },
  {
    id: 'budget',
    label: 'Give more budget for a named approach',
    recommended: false,
    cost: 'owner may raise the spend cap later',
  },
  {
    id: 'stop',
    label: 'Stop here and keep what was done',
    recommended: false,
  },
];

export function stuckCardOf(worker: WorkerRecord, finding: WatchdogFinding, at: number): StuckCard {
  const tried: string[] = [];
  if (worker.plan.trim()) tried.push(worker.plan.trim());
  if (worker.lastStepSignature) tried.push(worker.lastStepSignature);
  const sameFailure = finding.rule === 'looping';
  return {
    reason: STUCK_REASON,
    tenantId: worker.tenantId,
    workerId: worker.workerId,
    subjectKey: worker.subject.key,
    rule: finding.rule,
    tried,
    where: finding.detail,
    diagnosis: sameFailure
      ? 'The same step repeated without progress (sameFailure).'
      : finding.detail,
    sameFailure,
    generation: finding.generation,
    idleMinutes: Math.max(0, Math.floor((at - worker.lastProgressAt) / 60_000)),
    options: [...DEFAULT_STUCK_OPTIONS],
  };
}

export function formatStuckAsk(card: StuckCard): string {
  const tried =
    card.tried.length === 0
      ? 'nothing recorded'
      : card.tried.map((line, index) => `${index + 1}. ${line}`).join(' ');
  const same = card.sameFailure ? ' sameFailure.' : '';
  return `This worker is stuck (${card.rule}). Tried: ${tried}. Where: ${card.where}. Diagnosis: ${card.diagnosis}.${same}`;
}
