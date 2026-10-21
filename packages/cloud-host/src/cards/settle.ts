import type { Card, CardOutcome, DutyEngine } from '@maka-cloud/duties';
import type { DutyRunView } from '../duties/settle.js';

export interface CardSettlerOptions {
  engine: Pick<DutyEngine, 'cards'>;
  /** The conversation's runs, oldest first. */
  runsOf(conversationId: string): DutyRunView[];
  now?: () => number;
  /**
   * A task whose conversation never got its run (the message was lost) is written off after this
   * long, spent nothing. Default 24 hours.
   */
  abandonAfterMs?: number;
  /** Called once for each card this pass settled: the project can be scanned again. */
  onSettled?: (card: Card) => void;
  onWarning?: (message: string, detail?: unknown) => void;
}

const STOPPED_BY_PERSON: ReadonlySet<string> = new Set(['user_stop', 'paused']);

function outcomeOf(
  run: DutyRunView & { state: 'done' | 'failed' | 'cancelled' | 'interrupted' },
): CardOutcome {
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
 * Writes down what each task a tapped card started really spent and how it ended, once its run
 * has ended. The typical cost shown on later cards of the kind comes from these. Reading the
 * conductor's state is the only input, so it is safe to run as often as wanted and after any
 * restart: a card is settled once.
 */
export class CardSettler {
  private readonly now: () => number;
  private readonly abandonAfterMs: number;

  constructor(private readonly options: CardSettlerOptions) {
    this.now = options.now ?? Date.now;
    this.abandonAfterMs = options.abandonAfterMs ?? 24 * 3_600_000;
  }

  /** Returns how many cards this pass settled. */
  settle(): number {
    const cards = this.options.engine.cards;
    let settled = 0;
    for (const card of cards.unsettled()) {
      try {
        if (card.conversationId === null) continue;
        const run = this.options
          .runsOf(card.conversationId)
          .find((r) => r.dutyId === `card:${card.cardId}`);
        if (run === undefined) {
          if (this.now() - (card.decidedAt ?? this.now()) >= this.abandonAfterMs) {
            if (cards.settle(card.cardId, 'abandoned', 0)) {
              settled += 1;
              this.options.onSettled?.(card);
            }
          }
          continue;
        }
        if (run.state === 'active' || run.state === 'waiting' || run.state === 'delivering') {
          continue;
        }
        if (cards.settle(card.cardId, outcomeOf({ ...run, state: run.state }), run.spentUsd)) {
          settled += 1;
          this.options.onSettled?.(card);
        }
      } catch (error) {
        // One card that cannot be read does not hold up the others; it is tried again next pass.
        this.options.onWarning?.('Settling a card run failed', error);
      }
    }
    return settled;
  }
}
