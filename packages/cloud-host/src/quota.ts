import type { CapHit, SqliteSpendJournal } from '@maka-cloud/gateway';
import type { InviteStore, QuotaReason, QuotaSource } from '@maka-cloud/server';
import type { SpendCaps } from './config.js';

export function quotaSource(
  journal: SqliteSpendJournal,
  invites: Pick<InviteStore, 'limits'>,
  caps: SpendCaps,
  now = Date.now,
): QuotaSource {
  function reset(scope: 'day' | 'month', at: number): number {
    const d = new Date(at);
    return scope === 'day'
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  function reason(
    scope: 'day' | 'month',
    usedUsd: number,
    limitUsd: number,
  ): Exclude<QuotaReason, { scope: 'service' }> {
    return { scope, usedUsd, limitUsd, resetsAt: reset(scope, now()), nextStep: 'wait' };
  }
  function forCap(cap: CapHit & { usedUsd: number }, at: number): QuotaReason {
    if (cap.scope === 'server_daily')
      return { scope: 'service', resetsAt: reset('day', at), nextStep: 'wait' };
    if (cap.scope === 'invite_run')
      return {
        scope: 'run',
        usedUsd: cap.usedUsd,
        limitUsd: cap.limitUsd,
        resetsAt: null,
        nextStep: 'ask_owner',
      };
    const scope = cap.scope === 'invite_monthly' ? 'month' : 'day';
    return {
      scope,
      usedUsd: cap.usedUsd,
      limitUsd: cap.limitUsd,
      resetsAt: reset(scope, at),
      nextStep: 'wait',
    };
  }

  return {
    usage(owner) {
      const set = invites.limits(owner);
      const spent = journal.accountUsage(owner, now());
      const limits = [
        reason('day', spent.dayUsd, set?.dailyUsd ?? caps.inviteDailyUsd),
        reason('month', spent.monthUsd, set?.monthlyUsd ?? caps.inviteMonthlyUsd),
      ];
      const refusal =
        limits.find((limit) => limit.usedUsd >= limit.limitUsd) ??
        (journal.serverDaySpendUsd(now()) >= caps.serverDailyUsd
          ? { scope: 'service' as const, resetsAt: reset('day', now()), nextStep: 'wait' as const }
          : undefined);
      return { limits, ...(refusal ? { refusal } : {}) };
    },
    refusal(taskId) {
      const hit = journal.capHit(taskId);
      return hit && forCap(hit.cap, hit.at);
    },
  };
}
