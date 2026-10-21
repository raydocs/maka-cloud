import type { DutyEngine } from '../engine.js';
import { buildCandidates, capPerKind, type OwnResult } from './candidates.js';
import { type CardKind, defaultEnabledKinds } from './kinds.js';
import type { SignalReader } from './signals.js';
import type { Card } from './store.js';

/**
 * Puts the candidates of a scan in an order. It is shown ids, kinds and scores only: no title, no
 * detail, no word that anyone but us wrote. It can reorder what the rules made and nothing else.
 */
export interface CardRanker {
  order(
    candidates: ReadonlyArray<{ id: string; kind: CardKind; score: number }>,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
}

/**
 * The order to use given the ranker's answer. The answer must be an array of strings; ids that are
 * not candidates and repeats are dropped, and candidates it did not name follow in the fixed order.
 * An answer that is not an array is no answer: the fixed order stands.
 */
export function applyRanking<T extends { id: string }>(fixed: readonly T[], answer: unknown): T[] {
  if (!Array.isArray(answer)) return [...fixed];
  const byId = new Map(fixed.map((item) => [item.id, item]));
  const out: T[] = [];
  const used = new Set<string>();
  for (const id of answer) {
    if (typeof id !== 'string' || used.has(id)) continue;
    const item = byId.get(id);
    if (!item) continue;
    used.add(id);
    out.push(item);
  }
  for (const item of fixed) if (!used.has(item.id)) out.push(item);
  return out;
}

export interface ScanOptions {
  reader: SignalReader;
  /** Reorders the candidates. Without one, or when it fails, the fixed order stands. */
  ranker?: CardRanker;
  /** What the employee's finished tasks left out, for the project. Without it there are none. */
  ownResults?: (projectId: string) => readonly OwnResult[];
  /** Longest a scan may take (reading and ranking), in milliseconds. Default two minutes. */
  timeoutMs?: number;
  onWarning?: (message: string, detail?: unknown) => void;
}

export interface ScanOutcome {
  /** New cards, in the order the ranking put them. */
  created: Card[];
  /** Open cards whose state changed, replaced by a fresh one. */
  refreshed: Array<{ old: Card; card: Card }>;
  /** Open cards whose condition no longer holds. */
  retired: Card[];
  /** Open cards nobody answered for too long. */
  expired: Card[];
  /** Candidates not proposed, and why. */
  skipped: Array<{ kind: CardKind; subjectKey: string; reason: string }>;
  ranked: 'model' | 'fixed';
}

export type ScanResult =
  | { ok: true; outcome: ScanOutcome }
  | { ok: false; reason: 'not_found' | 'read_failed' | 'aborted' };

/**
 * Scans a project for work and proposes cards for it. A scan reads and stores cards, nothing
 * else: it holds no way to start a task, post a message or write to GitHub. Two scans of one
 * project at once are one scan (the second call gets the first one's result), and the slot is
 * released however the scan ends. The limits that keep cards from being noise are the store's.
 */
export class CardScanner {
  private readonly inFlight = new Map<string, Promise<ScanResult>>();

  constructor(
    private readonly engine: DutyEngine,
    private readonly options: ScanOptions,
  ) {}

  scan(owner: string, projectId: string, signal?: AbortSignal): Promise<ScanResult> {
    const key = `${owner}\u0000${projectId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    // Set before anything awaits, so a second call in the same turn finds it.
    const started = this.run(owner, projectId, signal).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  /** Scans in progress; for tests, that the slot is let go. */
  get scanning(): number {
    return this.inFlight.size;
  }

  private async run(owner: string, projectId: string, outer?: AbortSignal): Promise<ScanResult> {
    const project = this.engine.project(owner, projectId);
    if (!project) return { ok: false, reason: 'not_found' };
    const cards = this.engine.cards;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 120_000);
    const onOuter = () => abort.abort();
    if (outer?.aborted) abort.abort();
    outer?.addEventListener('abort', onOuter, { once: true });
    try {
      const signals = await untilAborted(
        this.options.reader.read(
          {
            repo: project.repo,
            defaultBranch: project.defaultBranch,
            selfLogins: project.selfLogins,
          },
          abort.signal,
        ),
        abort.signal,
      ).catch((error: unknown) => {
        if (!abort.signal.aborted)
          this.options.onWarning?.('A scan could not read the project', error);
        return undefined;
      });
      if (abort.signal.aborted) return { ok: false, reason: 'aborted' };
      if (!signals) return { ok: false, reason: 'read_failed' };

      let ownResults: readonly OwnResult[] = [];
      try {
        ownResults = this.options.ownResults?.(projectId) ?? [];
      } catch (error) {
        this.options.onWarning?.('A scan could not read the finished tasks', error);
      }
      const switchedOff = new Set(
        cards
          .stats(owner, projectId)
          .filter((kind) => !kind.enabled)
          .map((kind) => kind.kind),
      );
      const enabled = new Set<CardKind>(
        [...defaultEnabledKinds()].filter((kind) => !switchedOff.has(kind)),
      );
      const all = buildCandidates({
        repo: project.repo,
        defaultBranch: project.defaultBranch,
        signals,
        ownResults,
        issueDutyActive: project.duties.some(
          (duty) => duty.state === 'active' && duty.trigger.kind === 'issue_opened',
        ),
        enabled,
      });

      const outcome: ScanOutcome = {
        created: [],
        refreshed: [],
        retired: [],
        expired: cards.expire(),
        skipped: [],
        ranked: 'fixed',
      };

      // Cards already open: keep, bring up to date, or take down. The whole candidate list is the
      // truth here, not the capped one, so a card is not taken down only because newer work came.
      const byKey = new Map(all.map((c) => [`${c.card.kind}\u0000${c.card.subjectKey}`, c]));
      for (const open of cards.list(owner, projectId, ['open'])) {
        const now = byKey.get(`${open.kind}\u0000${open.subjectKey}`);
        if (!now) {
          const retired = cards.retire(owner, open.cardId);
          if (retired.ok && !retired.duplicate) outcome.retired.push(retired.card);
        } else if (now.card.preconditionHash !== open.preconditionHash) {
          const fresh = cards.refresh(owner, open.cardId, now.card);
          if (fresh.ok) outcome.refreshed.push({ old: open, card: fresh.card });
        }
      }

      // New cards, in ranked order, until the store says the day is full.
      const fixed = capPerKind(all).map((candidate, index) => ({ id: `c${index + 1}`, candidate }));
      let ordered = fixed;
      if (this.options.ranker && fixed.length > 1) {
        try {
          const answer = await untilAborted(
            this.options.ranker.order(
              fixed.map(({ id, candidate }) => ({
                id,
                kind: candidate.card.kind,
                score: candidate.score,
              })),
              abort.signal,
            ),
            abort.signal,
          );
          ordered = applyRanking(fixed, answer);
          outcome.ranked = 'model';
        } catch (error) {
          if (abort.signal.aborted) return { ok: false, reason: 'aborted' };
          this.options.onWarning?.('The card ranker failed; the fixed order is used', error);
        }
      }
      for (const { candidate } of ordered) {
        const result = cards.propose(owner, projectId, candidate.card);
        if (result.ok) {
          outcome.created.push(result.card);
          continue;
        }
        outcome.skipped.push({
          kind: candidate.card.kind,
          subjectKey: candidate.card.subjectKey,
          reason: result.reason,
        });
        if (result.reason === 'daily_cap') break;
      }
      return { ok: true, outcome };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }
}

/**
 * `work`, or a rejection as soon as `signal` aborts, whether or not `work` looks at the signal:
 * a reader or a ranker that ignores it cannot hold a scan (and its slot) open.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new Error('The scan was aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('The scan was aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
