import type { SummaryModel } from './host.js';
import type { ItemRecord } from './store.js';
import { clip } from './text.js';
import { byUrgency } from './view.js';

export interface DigestItem {
  itemId: string;
  kind: string;
  ask: string;
  state: string;
  closeReason: string | null;
}

export interface Digest {
  digestId: string;
  at: number;
  since: number;
  summary: string;
  /** Open items first, most urgent first, unless the ranker moved them. */
  items: DigestItem[];
  counts: { open: number; finished: number; closed: number };
}

/**
 * An order from a model is accepted only as a permutation of the items we
 * have: invented ids and repeats are dropped, missing ones follow in the
 * deterministic order. The set of items never changes.
 */
export function validateOrder(proposed: readonly string[], known: readonly string[]): string[] {
  const allowed = new Set(known);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of proposed) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of known) if (!seen.has(id)) ordered.push(id);
  return ordered;
}

function templateSummary(counts: Digest['counts'], held: number): string {
  const parts = [
    counts.open === 0 ? 'Nothing is waiting on you.' : `${counts.open} waiting on you.`,
    `${counts.finished} finished since the last digest.`,
  ];
  if (held > 0) parts.push(`${held} were held back by your notification limits.`);
  return parts.join(' ');
}

export async function buildDigest(input: {
  digestId: string;
  at: number;
  since: number;
  active: ItemRecord[];
  recent: ItemRecord[];
  model?: SummaryModel;
  timeoutMs: number;
  signal: AbortSignal;
  onWarning: (message: string, detail?: unknown) => void;
}): Promise<Digest> {
  const byId = new Map<string, ItemRecord>();
  for (const item of [...input.active, ...input.recent]) byId.set(item.itemId, item);
  const items = [...byId.values()].sort(
    (a, b) => Number(b.state !== 'closed') - Number(a.state !== 'closed') || byUrgency(a, b),
  );
  const counts = {
    open: items.filter((item) => item.state !== 'closed' && item.kind !== 'finished').length,
    finished: items.filter((item) => item.kind === 'finished').length,
    closed: items.filter((item) => item.state === 'closed').length,
  };
  const held = items.filter((item) => item.pushState === 'held').length;
  const fallbackOrder = items.map((item) => item.itemId);
  let order = fallbackOrder;
  let summary = templateSummary(counts, held);

  if (input.model && items.length > 0) {
    const timeout = AbortSignal.timeout(input.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    try {
      const answer = await input.model.summarize(
        {
          items: items.map((item) => ({
            id: item.itemId,
            kind: item.kind,
            ask: item.ask,
            ageMs: Math.max(0, input.at - item.createdAt),
          })),
        },
        signal,
      );
      if (signal.aborted) throw new Error('summary timed out or was stopped');
      order = validateOrder(Array.isArray(answer.order) ? answer.order : [], fallbackOrder);
      if (typeof answer.summary === 'string' && answer.summary.trim() !== '') {
        summary = clip(answer.summary, 600);
      }
    } catch (error) {
      input.onWarning('The digest summary failed; using the deterministic digest', error);
    }
  }

  return {
    digestId: input.digestId,
    at: input.at,
    since: input.since,
    summary,
    items: order.map((id) => {
      const item = byId.get(id) as ItemRecord;
      return {
        itemId: item.itemId,
        kind: item.kind,
        ask: item.ask,
        state: item.state,
        closeReason: item.closeReason,
      };
    }),
    counts,
  };
}
