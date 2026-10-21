import {
  type Card,
  type CardMode,
  type CardScanner,
  type DutyEngine,
  KIND_SPECS,
  MAX_RUN_BUDGET_USD,
  type ScanResult,
} from '@maka-cloud/duties';
import type { CloudServer } from '@maka-cloud/server';
import {
  offerRef,
  type SuggestionCard,
  type SuggestionChoice,
  type SuggestionCheck,
  type SuggestionOfferChoice,
  type SuggestionOutcome,
} from '@maka-cloud/supervisor';

/** The most a task started from a card may spend unless the operator sets another cap, in dollars. */
export const DEFAULT_CARD_BUDGET_CAP_USD = 10;
const MAX_TITLE = 200;

export interface CardsOptions {
  engine: DutyEngine;
  scanner: CardScanner;
  /** The smallest budget a run in `mode` can start with (the modes' `minRunUsd`). */
  minRunUsd(mode: CardMode): number;
  /** The most one card's task may be given. Default `DEFAULT_CARD_BUDGET_CAP_USD`, and never more than a duty's ceiling. */
  budgetCapUsd?: number;
  onWarning?: (message: string, detail?: unknown) => void;
}

/** What the cards need once the server and the supervisor exist. */
export interface CardsParts {
  server: Pick<CloudServer, 'startConversation' | 'createConversation'>;
  /** The supervisor's way to show a card. False when it cannot be shown. */
  raiseSuggestion(choice: SuggestionChoice): boolean;
  /** The supervisor's way to offer turning a kind off. False when it cannot be shown. */
  raiseOffer(offer: SuggestionOfferChoice): boolean;
  /** Takes down the item of a suggestion that ended without an answer. */
  closeSuggestion(lineage: string): boolean;
}

/** One item for each suggestion across its refreshes. */
export const lineageOf = (card: Pick<Card, 'projectId' | 'kind' | 'subjectKey'>): string =>
  `${card.projectId}:${card.kind}:${card.subjectKey}`;

/**
 * The run a tap on a card starts: what the supervisor's host seam reaches. A tap starts one
 * conversation with the card's fixed brief, under the card kind's authority and mode, tainted when
 * text from outside shaped the card, within a budget the code computes. Nothing about a run comes
 * from text. The conductor's tool gate enforces the authority and the T15 approval for what a
 * tainted run does.
 */
export class CardsService {
  private parts: CardsParts | undefined;
  private readonly budgetCapUsd: number;

  constructor(private readonly options: CardsOptions) {
    this.budgetCapUsd = Math.min(
      options.budgetCapUsd ?? DEFAULT_CARD_BUDGET_CAP_USD,
      MAX_RUN_BUDGET_USD,
    );
    // A cap below what a kind's mode needs would make every card of it unstartable: refuse now.
    for (const [kind, spec] of Object.entries(KIND_SPECS)) {
      if (spec.gated) continue;
      if (this.budgetCapUsd < options.minRunUsd(spec.mode)) {
        throw new Error(
          `The card budget cap $${this.budgetCapUsd} is below what ${spec.mode} mode needs for ${kind}.`,
        );
      }
    }
  }

  start(parts: CardsParts): void {
    if (this.parts) throw new Error('The cards were started already');
    this.parts = parts;
  }

  /** What the supervisor's host seam calls. */
  readonly suggestions = {
    verify: (
      request: { cardId: string; caller?: string },
      signal: AbortSignal,
    ): Promise<SuggestionCheck> => this.verify(request, signal),
    decide: (
      decision: {
        cardId: string;
        action: 'accept' | 'dismiss' | 'turn_off' | 'keep';
        caller?: string;
      },
      _signal: AbortSignal,
    ): Promise<SuggestionOutcome> => this.decide(decision),
  };

  /** The budget a card's task starts with: twice its estimate, within what its mode needs and the cap. */
  budgetFor(card: Pick<Card, 'estimateUsd' | 'mode'>): number {
    const floor = this.options.minRunUsd(card.mode);
    const wanted = Math.max(floor, Math.round(card.estimateUsd * 2 * 100) / 100);
    return Math.min(wanted, this.budgetCapUsd);
  }

  async verify(
    request: { cardId: string; caller?: string },
    signal: AbortSignal,
  ): Promise<SuggestionCheck> {
    if (request.caller === undefined) throw new Error('A card is checked for a caller.');
    const result = await this.options.scanner.verify(request.caller, request.cardId, signal);
    if (!result.ok) {
      // Gone for good: the owner has nothing to tap. A read that failed may pass: try again.
      if (result.reason === 'not_found' || result.reason === 'closed') return { state: 'gone' };
      throw new Error(`The card could not be checked (${result.reason}).`);
    }
    if (result.state === 'fresh') return { state: 'fresh' };
    if (result.state === 'gone') return { state: 'gone' };
    return { state: 'refreshed', card: this.suggestionOf(request.caller, result.card) };
  }

  async decide(decision: {
    cardId: string;
    action: 'accept' | 'dismiss' | 'turn_off' | 'keep';
    caller?: string;
  }): Promise<SuggestionOutcome> {
    const { caller } = decision;
    if (caller === undefined) return { accepted: false, reason: 'forbidden' };
    const cards = this.options.engine.cards;
    if (decision.action === 'turn_off' || decision.action === 'keep') {
      return this.answerOffer(caller, decision.cardId, decision.action);
    }
    if (decision.action === 'dismiss') {
      const dismissed = cards.dismiss(caller, decision.cardId);
      return dismissed.ok
        ? { accepted: true, duplicate: dismissed.duplicate }
        : { accepted: false, reason: dismissed.reason };
    }
    // The card is spent first and the task started second, both under the card's id, so the
    // second call of a retry (the first one died between the two) finds the card spent and starts
    // the task under the same key, which starts nothing twice.
    const accepted = cards.accept(caller, decision.cardId);
    if (!accepted.ok) return { accepted: false, reason: accepted.reason };
    const started = this.startTask(accepted.card);
    if (started === 'forbidden') return { accepted: false, reason: 'forbidden' };
    return { accepted: true, duplicate: accepted.duplicate };
  }

  /** The answer to the offer to turn a kind off. The reference names a project and a kind, never a card. */
  private answerOffer(caller: string, ref: string, action: 'turn_off' | 'keep'): SuggestionOutcome {
    const match = /^offer:([^:]+):([a-z_]+)$/u.exec(ref);
    if (!match || ref !== offerRef(match[1] as string, match[2] as string)) {
      return { accepted: false, reason: 'not_found' };
    }
    const answered = this.options.engine.cards.answerOffer(
      caller,
      match[1] as string,
      match[2],
      action === 'turn_off' ? 'off' : 'keep',
    );
    return answered.ok
      ? { accepted: true, duplicate: answered.duplicate }
      : { accepted: false, reason: answered.reason };
  }

  /**
   * Starts the task of an accepted card under the card's key, or finds it started already. Throws
   * when the server did not take it, so the tap or the sweep is tried again.
   */
  private startTask(card: Card): 'started' | 'forbidden' {
    const parts = this.parts;
    if (!parts) throw new Error('The cards are not started.');
    const budgetUsd = this.budgetFor(card);
    const project = this.options.engine.project(card.owner, card.projectId);
    const started = parts.server.startConversation({
      owner: card.owner,
      key: `card:${card.cardId}`,
      title: `${card.title} · ${project?.repo ?? 'project'}`.slice(0, MAX_TITLE),
      text: `${card.brief}\n\nBudget: this task may spend at most $${budgetUsd.toFixed(2)} and cannot raise it. Stop and report if the work does not fit.`,
      meta: {
        external: card.external,
        run: {
          dutyId: `card:${card.cardId}`,
          authority: card.authority,
          budgetUsd,
          mode: card.mode,
        },
      },
    });
    if (!started.ok) {
      if (started.reason === 'owner_inactive') return 'forbidden';
      throw new Error(`The server did not start the task: ${started.reason}`);
    }
    this.options.engine.cards.attachConversation(card.owner, card.cardId, started.conversationId);
    return 'started';
  }

  /**
   * Housekeeping, safe to repeat: finishes the start of cards that were spent but whose task never
   * began (the process died between the two; the key makes a second start a no-op), and takes
   * down the items of open cards nobody answered in time.
   */
  maintain(): { resumed: number; expired: number } {
    const parts = this.parts;
    if (!parts) throw new Error('The cards are not started.');
    const cards = this.options.engine.cards;
    let resumed = 0;
    for (const card of cards.unstarted()) {
      try {
        if (this.startTask(card) === 'started') resumed += 1;
      } catch (error) {
        this.options.onWarning?.('A tapped card could not be started again', error);
      }
    }
    const expired = cards.expire();
    for (const card of expired) parts.closeSuggestion(lineageOf(card));
    return { resumed, expired: expired.length };
  }

  /**
   * Scans a project and shows what it found: new and replaced cards are raised, and the items of
   * cards that were taken down or expired are closed. Every open card is raised again each time
   * (idempotent), so one the supervisor could not take earlier is not lost.
   */
  async scanProject(owner: string, projectId: string, signal?: AbortSignal): Promise<ScanResult> {
    const parts = this.parts;
    if (!parts) throw new Error('The cards are not started.');
    const project = this.options.engine.project(owner, projectId);
    if (!project) return { ok: false, reason: 'not_found' };
    const result = await this.options.scanner.scan(owner, projectId, signal);
    if (!result.ok) return result;
    for (const card of [...result.outcome.retired, ...result.outcome.expired]) {
      parts.closeSuggestion(lineageOf(card));
    }
    const place = parts.server.createConversation({
      owner,
      key: `cards:${projectId}`,
      title: `Suggestions: ${project.repo}`.slice(0, MAX_TITLE),
    });
    if (!place.ok) {
      if (place.reason !== 'owner_inactive') {
        this.options.onWarning?.(`A suggestion could not be placed (${place.reason})`);
      }
      return result;
    }
    this.raiseOffers(owner, projectId, project.repo, place.conversationId, parts);
    for (const card of this.options.engine.cards.list(owner, projectId, ['open'])) {
      const shown = parts.raiseSuggestion({
        ...this.suggestionOf(owner, card),
        conversationId: place.conversationId,
      });
      if (!shown) this.options.onWarning?.('A suggestion could not be shown');
    }
    return result;
  }

  /**
   * Offers to turn off each kind whose cards went unanswered several times in a row. A kind is
   * taken once, and every kind still waiting for an answer is raised again each scan (the item is
   * one per project and kind), so an offer the supervisor could not take is not lost.
   */
  private raiseOffers(
    owner: string,
    projectId: string,
    repo: string,
    conversationId: string,
    parts: CardsParts,
  ): void {
    const cards = this.options.engine.cards;
    cards.takeOffers(owner, projectId);
    for (const stat of cards.stats(owner, projectId)) {
      if (stat.offer !== 'offered' || !stat.enabled) continue;
      const shown = parts.raiseOffer({
        conversationId,
        projectId,
        kind: stat.kind,
        label: KIND_SPECS[stat.kind].label,
        repo,
        ignored: stat.ignoredInARow,
      });
      if (!shown) this.options.onWarning?.('An offer to turn a suggestion off could not be shown');
    }
  }

  private suggestionOf(owner: string, card: Card): SuggestionCard {
    const project = this.options.engine.project(owner, card.projectId);
    return {
      lineage: lineageOf(card),
      cardId: card.cardId,
      title: card.title,
      facts: {
        kind: card.kind,
        mode: card.mode,
        estimateUsd: card.estimateUsd,
        typical: card.typical,
        repo: project?.repo ?? '',
        detail: card.detail,
        external: card.external,
      },
    };
  }
}
