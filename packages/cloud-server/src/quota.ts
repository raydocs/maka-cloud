/** USD includes settled spend and reservations in flight. UTC reset timestamps are milliseconds;
 * task limits do not reset. No self-service budget editor exists, so operator-owned caps
 * offer ask_owner; clients must never invent a paid upgrade or top-up.
 */
export interface QuotaReason {
  scope: 'task' | 'day' | 'month';
  usedUsd: number;
  limitUsd: number;
  resetsAt: number | null;
  nextStep: 'wait' | 'raise_limit' | 'ask_owner';
}
export interface UsageView {
  limits: QuotaReason[];
  refusal?: QuotaReason;
}

export interface QuotaSource {
  usage(owner: string): UsageView;
  refusal?(taskId: string): QuotaReason | undefined;
}
export function taskQuota(usedUsd: number, limitUsd: number): QuotaReason {
  return { scope: 'task', usedUsd, limitUsd, resetsAt: null, nextStep: 'ask_owner' };
}
