import type { BudgetPort, CapHit, ReserveResult } from './budget.js';

/**
 * Who a grant's spend counts against: an invite (its daily and monthly caps, and the server's),
 * or the server alone (spend that belongs to no invite, such as the digest summary).
 */
export type Account = { inviteId: string } | 'server';

/**
 * The caps on accounts. A reservation counts what the account already spent and holds, so
 * requests in flight cannot together pass a cap. Both calls are synchronous and durable when
 * they return.
 */
export interface SpendAccounts {
  reserve(account: Account, key: string, usd: number): ReserveResult;
  /** Replaces the hold under `key` with what was spent, in full even above it. */
  settle(key: string, usd: number): void;
}

/**
 * A grant's port that also charges `account`. The inner port reserves first (it is memory only);
 * if the account refuses, the inner hold is released. A refusal for a cap is final for the grant:
 * a smaller request cannot pass after a bigger one was refused, so the grant's spending ends.
 */
export function accountPort(
  port: BudgetPort,
  accounts: SpendAccounts,
  account: Account,
): BudgetPort {
  let capped: ReserveResult | undefined;
  return {
    reserve(key, usd) {
      if (capped) return capped;
      const inner = port.reserve(key, usd);
      if (!inner.ok) return inner;
      let outer: ReserveResult;
      try {
        outer = accounts.reserve(account, key, usd);
      } catch {
        outer = { ok: false, unavailable: true, reason: 'the spend could not be recorded' };
      }
      if (outer.ok) return outer;
      port.settle(key, 0);
      if (outer.cap) capped = outer;
      return outer;
    },
    settle(key, usd) {
      try {
        port.settle(key, usd);
      } finally {
        // If this throws, the account's hold stays and counts in full.
        accounts.settle(key, usd);
      }
    },
  };
}

export type { CapHit };
