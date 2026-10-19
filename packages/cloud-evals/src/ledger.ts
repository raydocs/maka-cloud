/**
 * Dollars a run may still start. All of it is synchronous: a cell reserves its whole cap before
 * its first await, so two cells that start together cannot both fit when only one does.
 */
export class BudgetLedger {
  private spent: number;
  private reserved = 0;
  private readonly open = new Map<string, number>();

  constructor(
    readonly totalUsd: number,
    priorSpentUsd = 0,
  ) {
    if (!(totalUsd >= 0) || !Number.isFinite(totalUsd)) throw new Error('total budget is invalid');
    this.spent = priorSpentUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get reservedUsd(): number {
    return this.reserved;
  }

  get openReservations(): number {
    return this.open.size;
  }

  /** Null when the cap does not fit in what is left. */
  reserve(id: string, capUsd: number): Reservation | null {
    if (!(capUsd >= 0) || !Number.isFinite(capUsd)) throw new Error('cell budget is invalid');
    if (this.open.has(id)) throw new Error(`budget already reserved for ${id}`);
    if (this.spent + this.reserved + capUsd > this.totalUsd + 1e-9) return null;
    this.reserved += capUsd;
    this.open.set(id, capUsd);
    return new Reservation(this, id, capUsd);
  }

  /** @internal */
  settle(id: string, actualUsd: number): void {
    const cap = this.open.get(id);
    if (cap === undefined) return;
    this.open.delete(id);
    this.reserved -= cap;
    this.spent += actualUsd;
  }
}

export class Reservation {
  private done = false;

  constructor(
    private readonly ledger: BudgetLedger,
    readonly id: string,
    readonly capUsd: number,
  ) {}

  /** Gives the reservation back and charges what was spent. Idempotent. */
  settle(actualUsd: number): void {
    if (this.done) return;
    this.done = true;
    this.ledger.settle(this.id, actualUsd);
  }
}
