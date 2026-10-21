import { ApiError, type CloudClient } from './client';
import type { InboxItem } from './contract';

/**
 * One tap, one answer. A decision is answered with an id that is the same for the same answer to
 * the same state of the same item, so a retry (a double tap, a lost reply) is the server's duplicate,
 * never a second answer. A refused answer (stale, closed, already answered) carries the item as it
 * is now: `onItem` takes it so the card refreshes instead of acting, and the error is still thrown
 * for the caller to say so.
 */
export function inboxAnswerer(client: CloudClient, onItem: (item: unknown) => void) {
  const ids = new Map<string, string>();
  return async function answer(item: InboxItem, optionId: string, text?: string): Promise<void> {
    const key = [item.itemId, item.preconditionHash, optionId, text ?? ''].join('\u0000');
    const answerId = ids.get(key) ?? crypto.randomUUID();
    ids.set(key, answerId);
    try {
      const result = await client.answerInbox(item.itemId, {
        answerId,
        optionId,
        ...(text ? { text } : {}),
        preconditionHash: item.preconditionHash,
      });
      onItem(result.item);
      ids.delete(key);
    } catch (e) {
      // Only a refusal that carries the item is final (stale, closed, answered already). Any other
      // failure may or may not have reached the server, so the retry keeps its id.
      const refreshed =
        e instanceof ApiError && typeof e.body === 'object' && e.body !== null
          ? (e.body as { item?: unknown }).item
          : undefined;
      if (refreshed !== undefined) {
        onItem(refreshed);
        ids.delete(key);
      }
      throw e;
    }
  };
}
