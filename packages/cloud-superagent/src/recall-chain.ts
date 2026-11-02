import type { SuperagentStore } from './store.js';

export const RECALL_DOCUMENT = 'recall';
const MAX_LINKS = 400;

/**
 * Trigger → thread → worker. Answers "what happened to yesterday's issue"
 * by following the ids the Router already minted (`ids.ts`).
 */
export interface RecallChain {
  triggerId: string;
  threadId: string;
  workerId: string | null;
  taskId?: string;
  decisionId?: string;
  layer: 'fast' | 'slow' | 'passthrough';
  at: number;
}

export interface RecallQuery {
  triggerId?: string;
  threadId?: string;
  workerId?: string;
}

export function loadRecall(store: SuperagentStore, tenantId: string): RecallChain[] {
  const raw = store.getDocument(tenantId, RECALL_DOCUMENT);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { links?: RecallChain[] };
    return Array.isArray(parsed.links) ? parsed.links.map((row) => ({ ...row })) : [];
  } catch {
    return [];
  }
}

export function saveRecall(store: SuperagentStore, tenantId: string, links: RecallChain[], at: number): void {
  store.putDocument(tenantId, RECALL_DOCUMENT, JSON.stringify({ links: links.slice(-MAX_LINKS) }), at);
}

export function appendRecall(
  store: SuperagentStore,
  tenantId: string,
  link: RecallChain,
): RecallChain[] {
  const links = loadRecall(store, tenantId);
  const next = [...links, link].slice(-MAX_LINKS);
  saveRecall(store, tenantId, next, link.at);
  return next;
}

export function followRecall(links: readonly RecallChain[], query: RecallQuery): RecallChain[] {
  return links.filter((row) => {
    if (query.triggerId && row.triggerId === query.triggerId) return true;
    if (query.threadId && row.threadId === query.threadId) return true;
    if (query.workerId && row.workerId === query.workerId) return true;
    return false;
  });
}

export function followRecallInStore(
  store: SuperagentStore,
  tenantId: string,
  query: RecallQuery,
): RecallChain[] {
  return followRecall(loadRecall(store, tenantId), query);
}
