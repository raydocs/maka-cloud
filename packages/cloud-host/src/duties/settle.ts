import type { DutyEngine, EndOutcome } from '@maka-cloud/duties';

/** The run a duty started, as the conductor knows it. */
export interface DutyRunView {
  runId: string;
  dutyId: string | null;
  state: 'active' | 'waiting' | 'delivering' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  /** What the run spent, reservations included. */
  spentUsd: number;
  /** Why the conductor ended the run (`user_stop`, `budget_limit`, ...); null while it is open. */
  endReason: string | null;
}

export interface SettlerOptions {
  engine: Pick<DutyEngine, 'startedRequests' | 'finish'>;
  /** The conversation's runs, oldest first. */
  runsOf(conversationId: string): DutyRunView[];
  now?: () => number;
  /**
   * A started request whose conversation never got a duty run (the message was lost) is written
   * off after this long, at its whole reservation. Default 24 hours.
   */
  abandonAfterMs?: number;
  onWarning?: (message: string, detail?: unknown) => void;
}

/** A person (or the operator's pause) ended the run; it says nothing against the duty. */
const STOPPED_BY_PERSON: ReadonlySet<string> = new Set(['user_stop', 'paused']);

/**
 * Only a stop by a person is `stopped` and leaves the failure count alone. Any other way a run is
 * cancelled (the hard budget, a reason this list does not know, none recorded) counts against the
 * duty, so a duty that keeps hitting its budget turns itself off.
 */
function outcomeOf(
  run: DutyRunView & { state: 'done' | 'failed' | 'cancelled' | 'interrupted' },
): EndOutcome {
  switch (run.state) {
    case 'done':
      return 'completed';
    case 'cancelled':
      return run.endReason !== null && STOPPED_BY_PERSON.has(run.endReason) ? 'stopped' : 'failed';
    default:
      return 'failed';
  }
}

/**
 * Replaces the reservation of each started duty request with what its run really spent, once the
 * run has ended. Reading the conductor's state is the only input, so it is safe to run as often
 * as wanted and after any restart: ending a request twice changes nothing.
 */
export class RunSettler {
  private readonly now: () => number;
  private readonly abandonAfterMs: number;

  constructor(private readonly options: SettlerOptions) {
    this.now = options.now ?? Date.now;
    this.abandonAfterMs = options.abandonAfterMs ?? 24 * 3_600_000;
  }

  /** Returns how many requests this pass ended. */
  settle(): number {
    let ended = 0;
    for (const request of this.options.engine.startedRequests()) {
      try {
        // The duty's own run is the one that carries its id; a later message may start another.
        const run = this.options.runsOf(request.conversationId).find((r) => r.dutyId !== null);
        if (run === undefined) {
          if (this.now() - request.startedAt >= this.abandonAfterMs) {
            if (this.options.engine.finish(request.requestId, 'abandoned')) ended += 1;
          }
          continue;
        }
        if (run.state === 'active' || run.state === 'waiting' || run.state === 'delivering') {
          continue;
        }
        if (
          this.options.engine.finish(
            request.requestId,
            outcomeOf({ ...run, state: run.state }),
            run.spentUsd,
          )
        ) {
          ended += 1;
        }
      } catch (error) {
        // One request that cannot be read does not hold up the others; it is tried again next pass.
        this.options.onWarning?.('Settling a duty run failed', error);
      }
    }
    return ended;
  }
}
