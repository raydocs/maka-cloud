import type { DutyEngine } from '@maka-cloud/duties';
import type { CardsService } from './service.js';
import type { CardSettler } from './settle.js';

const HOUR = 3_600_000;

export interface CardSchedulerOptions {
  engine: Pick<DutyEngine, 'activeProjects' | 'cards'>;
  cards: Pick<CardsService, 'scanProject' | 'maintain'>;
  settler: Pick<CardSettler, 'settle'>;
  now?: () => number;
  /** A project is scanned when its last scan is this old. Default 24 hours: one scan a day, however long the host was down. */
  intervalMs?: number;
  /** A scan asked for after a finished task waits until the last one is at least this old. Default one hour. */
  minGapMs?: number;
  /** The most scans one pass starts, so a host that was down for days catches up a few at a time. Default 5. */
  maxPerPass?: number;
  /** How often a pass runs. Default 5 minutes. */
  tickMs?: number;
  /** Replaces setInterval, so a test can see the timer is released. Returns the function that releases it. */
  every?: (fn: () => void, ms: number) => () => void;
  onWarning?: (message: string, detail?: unknown) => void;
}

/**
 * Decides when each project is scanned for cards, and keeps the card housekeeping going. Scans are
 * read-only; this only chooses when. A project is scanned when its last scan is a day old (one
 * scan after any downtime, never one per missed day) and, sooner, after one of the employee's
 * own tasks on it finished. One pass at a time and one scan at a time: a pass asked for while
 * another runs is that pass, and a project is never scanned twice at once.
 */
export class CardScheduler {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly minGapMs: number;
  private readonly maxPerPass: number;
  private readonly wanted = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private running: Promise<void> | undefined;
  private release: (() => void) | undefined;
  private abort = new AbortController();
  private stopped = false;

  constructor(private readonly options: CardSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 24 * HOUR;
    this.minGapMs = options.minGapMs ?? HOUR;
    this.maxPerPass = options.maxPerPass ?? 5;
  }

  /** Begins the timer and looks at once. Once. */
  start(): void {
    if (this.release || this.stopped) throw new Error('The card scheduler was started already');
    this.release = (this.options.every ?? defaultEvery)(
      () => {
        void this.pass();
      },
      this.options.tickMs ?? 5 * 60_000,
    );
    void this.pass();
  }

  /** One of the employee's own tasks on this project finished: scan it again soon. */
  taskFinished(projectId: string): void {
    if (!this.stopped) this.wanted.add(projectId);
  }

  /**
   * One pass: settles finished card tasks, finishes taps that died before their task began,
   * expires unanswered cards, then scans what is due. Resolves when the pass is done. A pass
   * asked for while one runs returns that one.
   */
  pass(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const running = this.run().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  /** Stops the timer, ends the scan in progress and waits for the pass to finish. Nothing starts after. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.release?.();
    this.release = undefined;
    this.abort.abort();
    await this.running;
  }

  private async run(): Promise<void> {
    const { engine, cards, settler } = this.options;
    try {
      settler.settle();
      cards.maintain();
    } catch (error) {
      this.options.onWarning?.('A card housekeeping pass failed', error);
    }
    let scans = 0;
    for (const { owner, projectId } of engine.activeProjects()) {
      if (this.stopped || scans >= this.maxPerPass) return;
      if (!this.due(projectId)) continue;
      scans += 1;
      this.wanted.delete(projectId);
      try {
        const result = await cards.scanProject(owner, projectId, this.abort.signal);
        if (result.ok) {
          engine.cards.markScanned(projectId);
          this.retryAt.delete(projectId);
        } else if (result.reason !== 'not_found') {
          // A scan that could not read the project is not marked done; it is tried again after a gap.
          this.retryAt.set(projectId, this.now() + this.minGapMs);
          this.options.onWarning?.(`A card scan did not finish (${result.reason})`);
        }
      } catch (error) {
        this.retryAt.set(projectId, this.now() + this.minGapMs);
        this.options.onWarning?.('A card scan failed', error);
      }
    }
  }

  private due(projectId: string): boolean {
    if (this.now() < (this.retryAt.get(projectId) ?? 0)) return false;
    const last = this.options.engine.cards.lastScan(projectId);
    if (last === undefined) return true;
    const age = this.now() - last;
    return age >= this.intervalMs || (this.wanted.has(projectId) && age >= this.minGapMs);
  }
}

function defaultEvery(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
}
