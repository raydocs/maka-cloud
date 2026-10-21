import type { BudgetPort, CapHit, ReserveResult } from './budget.js';

/**
 * Who a grant's spend counts against: an invite (its daily and monthly caps, and the server's),
 * or the server alone (spend that belongs to no invite, such as the digest summary).
 *
 * An invite account carries the generation of its run budget as it was when the grant was issued
 * (`SpendAccounts.generationOf`). A newer run of the invite moves the generation on, and from then
 * on the grant books nothing.
 */
export type Account = { inviteId: string; generation?: number } | 'server';

/**
 * The caps on accounts. A reservation counts what the account already spent and holds, so
 * requests in flight cannot together pass a cap. Both calls are synchronous and durable when
 * they return.
 */
export interface SpendAccounts {
  /** The invite's current generation: what a grant issued now is stamped with. */
  generationOf?(inviteId: string): number;
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
  issued: Account,
): BudgetPort {
  // Stamped when the grant is issued: a run that begins later makes this stamp stale.
  const account: Account =
    issued === 'server' || issued.generation !== undefined || !accounts.generationOf
      ? issued
      : { ...issued, generation: accounts.generationOf(issued.inviteId) };
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
