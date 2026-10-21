import {
  CardScanner,
  type CardMode,
  type CardRanker,
  type DutyEngine,
  GitHubSignalReader,
  type SignalReader,
} from '@maka-cloud/duties';
import type { SupervisorHost } from '@maka-cloud/supervisor';
import type { DutyRunView } from '../duties/settle.js';
import { CardScheduler, type CardSchedulerOptions } from './schedule.js';
import { CardsService, type CardsParts } from './service.js';
import { CardSettler } from './settle.js';

export interface CardsSetup {
  engine: DutyEngine;
  /** The smallest budget a run in `mode` can start with. */
  minRunUsd(mode: CardMode): number;
  /** Replaces the GitHub reader, for tests. */
  reader?: SignalReader;
  /** Reorders the candidates of a scan. None: the fixed order. */
  ranker?: CardRanker;
  /** Replaces the scheduler's timing and timer, for tests. */
  schedule?: Pick<
    CardSchedulerOptions,
    'every' | 'now' | 'intervalMs' | 'minGapMs' | 'maxPerPass' | 'tickMs'
  >;
  onWarning?: (message: string, detail?: unknown) => void;
}

/** What the cards need once the server and the supervisor exist. */
export interface CardsStart extends CardsParts {
  runsOf(conversationId: string): DutyRunView[];
}

export interface CardsRuntime {
  /** What the supervisor delivers a tapped card to. Usable before `start`: nothing runs until then. */
  suggestions: NonNullable<SupervisorHost['suggestions']>;
  service: CardsService;
  /** Begins the daily scan, the settling of finished card tasks and the housekeeping. Once. */
  start(parts: CardsStart): void;
  /** One pass of the schedule, now: housekeeping, then the scans that are due. For tests. */
  pass(): Promise<void>;
  /** Stops the timer and the scan in progress, and waits for them. */
  stop(): Promise<void>;
}

/** Proposed cards (T30) as the stack runs them: the service, the scan schedule and the settling of tapped tasks. */
export function createCards(setup: CardsSetup): CardsRuntime {
  const warn = setup.onWarning ?? (() => undefined);
  const reader = setup.reader ?? new GitHubSignalReader();
  const scanner = new CardScanner(setup.engine, {
    reader,
    ...(setup.ranker === undefined ? {} : { ranker: setup.ranker }),
    onWarning: warn,
  });
  const service = new CardsService({
    engine: setup.engine,
    scanner,
    minRunUsd: setup.minRunUsd,
    onWarning: warn,
  });
  let scheduler: CardScheduler | undefined;
  return {
    suggestions: service.suggestions,
    service,
    start(parts) {
      if (scheduler) throw new Error('The cards were started already');
      service.start(parts);
      const created: CardScheduler = new CardScheduler({
        engine: setup.engine,
        cards: service,
        settler: new CardSettler({
          engine: setup.engine,
          runsOf: parts.runsOf,
          // A finished task of the employee's own is a reason to look at the project again.
          onSettled: (card) => created.taskFinished(card.projectId),
          onWarning: warn,
        }),
        onWarning: warn,
        ...setup.schedule,
      });
      scheduler = created;
      created.start();
    },
    pass: () => scheduler?.pass() ?? Promise.resolve(),
    async stop() {
      await scheduler?.stop();
    },
  };
}
