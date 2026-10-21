/** A cap on an account's spend that refused a request. */
export interface CapHit {
  scope: 'invite_daily' | 'invite_monthly' | 'invite_run' | 'server_daily';
  /** The invite whose cap it is; absent for the server-wide cap. */
  inviteId?: string;
  limitUsd: number;
}

export type ReserveResult =
  | { ok: true }
  /**
   * `budget`: refused because the money is not there, not because spending is closed.
   * `unavailable`: the reservation could not be recorded; the same request may pass later.
   * `cap`: the refusal is an account cap (a `budget` refusal), not the task's own budget.
   */
  | { ok: false; reason: string; budget?: boolean; unavailable?: boolean; cap?: CapHit };

/**
 * Where a grant's spend is charged. Both calls are synchronous, so nothing can spend between a
 * check and its reservation. The conductor's run ledger and the supervisor's spend gate implement
 * it; `LimitPort` is the in-memory one for runner tasks.
 */
export interface BudgetPort {
  /** Holds `usd` under `key`, or refuses. */
  reserve(key: string, usd: number): ReserveResult;
  /** Replaces the hold under `key` with what was spent, in full even above it. */
  settle(key: string, usd: number): void;
}

const EPSILON = 1e-9;

function money(usd: number): string {
  return `$${Math.max(0, usd).toFixed(2)}`;
}

/** A dollar limit in memory, with what was spent and what is held for requests in flight. */
export class Allowance {
  spentUsd = 0;
  private readonly held = new Map<string, number>();

  constructor(
    readonly limitUsd: number,
    /** What a refusal calls this limit. */
    readonly label = "the task's model budget",
  ) {}

  get heldUsd(): number {
    let sum = 0;
    for (const usd of this.held.values()) sum += usd;
    return sum;
  }

  get remainingUsd(): number {
    return this.limitUsd - this.spentUsd - this.heldUsd;
  }

  fits(usd: number): boolean {
    return this.spentUsd + this.heldUsd + usd <= this.limitUsd + EPSILON;
  }

  hold(key: string, usd: number): void {
    this.held.set(key, usd);
  }

  /** Replaces the hold with the spend. A key that holds nothing is not charged twice. */
  settle(key: string, usd: number): void {
    if (!this.held.delete(key)) return;
    this.spentUsd += usd;
  }
}

/**
 * Charges every allowance at once: a request is reserved only when it fits all of them (the
 * task's own budget and its tree's pool), and settles in all of them.
 */
export class LimitPort implements BudgetPort {
  constructor(private readonly allowances: readonly Allowance[]) {}

  reserve(key: string, usd: number): ReserveResult {
    if (!Number.isFinite(usd) || usd < 0)
      return { ok: false, reason: 'the request has no valid cost' };
    const short = this.allowances.find((allowance) => !allowance.fits(usd));
    if (short) {
      return {
        ok: false,
        budget: true,
        reason: `${short.label} has ${money(short.remainingUsd)} left, and this request could cost up to ${money(usd)}`,
      };
    }
    for (const allowance of this.allowances) allowance.hold(key, usd);
    return { ok: true };
  }

  settle(key: string, usd: number): void {
    for (const allowance of this.allowances) allowance.settle(key, usd);
  }
}
