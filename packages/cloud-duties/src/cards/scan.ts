import type { DutyEngine } from '../engine.js';
import { buildCandidates, type Candidate, capPerKind, type OwnResult } from './candidates.js';
import { type CardKind, defaultEnabledKinds } from './kinds.js';
import type { RepoSignals, SignalReader } from './signals.js';
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

/** Whether a card still describes its project, read fresh. */
export type VerifyResult =
  | { ok: true; state: 'fresh'; card: Card }
  | { ok: true; state: 'refreshed'; card: Card }
  | { ok: true; state: 'gone'; card: Card }
  | { ok: false; reason: 'not_found' | 'closed' | 'read_failed' | 'aborted' };

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

  /**
   * Reads the project again and says whether a card still describes it, for the moment a tap is
   * about to act on it. A card whose state moved is replaced by a fresh one (the old one ends
   * `stale`); one whose work is gone is taken down. A replaced card answers with the card that
   * replaced it. Nothing is started and nothing is written to GitHub.
   */
  async verify(owner: string, cardId: string, outer?: AbortSignal): Promise<VerifyResult> {
    const cards = this.engine.cards;
    const card = cards.get(owner, cardId);
    if (!card) return { ok: false, reason: 'not_found' };
    const project = this.engine.project(owner, card.projectId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (card.state === 'accepted' || card.state === 'dismissed') {
      return { ok: false, reason: 'closed' };
    }
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
        if (!abort.signal.aborted) {
          this.options.onWarning?.('A card could not be checked against the project', error);
        }
        return undefined;
      });
      if (abort.signal.aborted) return { ok: false, reason: 'aborted' };
      if (!signals) return { ok: false, reason: 'read_failed' };
      const all = this.candidatesFor(owner, project, signals);
      // The card as the store has it now: another check may have replaced it while this one read.
      const now = cards.get(owner, cardId);
      if (!now) return { ok: false, reason: 'not_found' };
      const open =
        now.state === 'open'
          ? now
          : now.state === 'stale'
            ? cards
                .list(owner, card.projectId, ['open'])
                .find((c) => c.kind === now.kind && c.subjectKey === now.subjectKey)
            : undefined;
      if (!open) {
        return now.state === 'stale'
          ? { ok: true, state: 'gone', card: now }
          : { ok: false, reason: 'closed' };
      }
      const verdict = this.reconcile(owner, open, all);
      if (verdict.state === 'refreshed') {
        return { ok: true, state: 'refreshed', card: verdict.card };
      }
      if (verdict.state === 'gone') return { ok: true, state: 'gone', card: verdict.card };
      // Kept as it is; or replaced by someone else's check an instant ago, which is the card to use.
      if (open.cardId !== cardId) return { ok: true, state: 'refreshed', card: open };
      return { ok: true, state: 'fresh', card: open };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }

  /** The candidates of a project for these signals, under the owner's switches. */
  private candidatesFor(
    owner: string,
    project: NonNullable<ReturnType<DutyEngine['project']>>,
    signals: RepoSignals,
  ): Candidate[] {
    let ownResults: readonly OwnResult[] = [];
    try {
      ownResults = this.options.ownResults?.(project.projectId) ?? [];
    } catch (error) {
      this.options.onWarning?.('A scan could not read the finished tasks', error);
    }
    const switchedOff = new Set(
      this.engine.cards
        .stats(owner, project.projectId)
        .filter((kind) => !kind.enabled)
        .map((kind) => kind.kind),
    );
    const enabled = new Set<CardKind>(
      [...defaultEnabledKinds()].filter((kind) => !switchedOff.has(kind)),
    );
    return buildCandidates({
      repo: project.repo,
      defaultBranch: project.defaultBranch,
      signals,
      ownResults,
      issueDutyActive: project.duties.some(
        (duty) => duty.state === 'active' && duty.trigger.kind === 'issue_opened',
      ),
      enabled,
    });
  }

  /** Keeps an open card, replaces it with a fresh one, or takes it down, by what the candidates say now. */
  private reconcile(
    owner: string,
    open: Card,
    all: readonly Candidate[],
  ):
    | { state: 'kept' }
    | { state: 'refreshed'; card: Card }
    | { state: 'gone'; card: Card; retired: boolean } {
    const cards = this.engine.cards;
    const now = all.find((c) => c.card.kind === open.kind && c.card.subjectKey === open.subjectKey);
    if (!now) {
      const retired = cards.retire(owner, open.cardId);
      return retired.ok
        ? { state: 'gone', card: retired.card, retired: !retired.duplicate }
        : { state: 'gone', card: open, retired: false };
    }
    if (now.card.preconditionHash === open.preconditionHash) return { state: 'kept' };
    const fresh = cards.refresh(owner, open.cardId, now.card);
    return fresh.ok ? { state: 'refreshed', card: fresh.card } : { state: 'kept' };
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

      const all = this.candidatesFor(owner, project, signals);

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
      for (const open of cards.list(owner, projectId, ['open'])) {
        const verdict = this.reconcile(owner, open, all);
        if (verdict.state === 'refreshed')
          outcome.refreshed.push({ old: open, card: verdict.card });
        if (verdict.state === 'gone' && verdict.retired) outcome.retired.push(verdict.card);
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
