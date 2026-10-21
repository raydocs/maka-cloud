import type { CapEvent } from '@maka-cloud/gateway';

export interface CapReporterDeps {
  /** Raises the budget item; one per `key` while it is open. Throws if it cannot. */
  raise(input: { conversationId: string; taskId?: string; key: string; ask: string }): void;
  /** Tells the conversation, in the chat. */
  notice(conversationId: string, text: string): Promise<void>;
  warn(message: string, detail?: unknown): void;
  now?: () => number;
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

function words(cap: CapEvent['cap']): string {
  switch (cap.scope) {
    case 'invite_daily':
      return `Your daily spending limit of ${money(cap.limitUsd)} is used up, so work that needs the model has stopped. It starts again at midnight UTC.`;
    case 'invite_monthly':
      return `Your monthly spending limit of ${money(cap.limitUsd)} is used up, so work that needs the model has stopped. It starts again on the first of next month (UTC).`;
    case 'invite_run':
      return `The spending limit of ${money(cap.limitUsd)} set for this test run is used up, so work that needs the model has stopped.`;
    case 'server_daily':
      return `The daily spending limit of the whole service is used up, so work that needs the model has stopped. It starts again at midnight UTC.`;
  }
}

/**
 * What the gateway calls when a cap stops a grant: the user is told in the conversation and gets a
 * budget item in the inbox, so a cap is never a silent failure. A cap that stops several grants of
 * one limit raises one item, and tells each conversation once per period.
 */
export function capReporter(deps: CapReporterDeps): (event: CapEvent) => void {
  const now = deps.now ?? Date.now;
  const told = new Set<string>();
  return (event) => {
    const { conversationId, cap } = event;
    if (conversationId === undefined) {
      deps.warn('A spending limit stopped work that no conversation could be told about', {
        scope: cap.scope,
        subject: event.subject,
      });
      return;
    }
    const iso = new Date(now()).toISOString();
    const period = cap.scope === 'invite_monthly' ? iso.slice(0, 7) : iso.slice(0, 10);
    // The service-wide limit stops every invite, so each conversation gets its own item.
    const key =
      cap.scope === 'server_daily'
        ? `${cap.scope}:${conversationId}:${period}`
        : `${cap.scope}:${cap.inviteId ?? ''}:${period}`;
    const ask = words(cap);
    try {
      deps.raise({
        conversationId,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        key,
        ask,
      });
    } catch (error) {
      deps.warn('A spending limit stopped work, but its inbox item could not be raised', error);
    }
    const noticeKey = `${key}:${conversationId}`;
    if (told.has(noticeKey)) return;
    if (told.size >= 1_000) told.clear();
    told.add(noticeKey);
    deps.notice(conversationId, ask).catch((error: unknown) => {
      told.delete(noticeKey);
      deps.warn('A spending limit stopped work, but the conversation could not be told', error);
    });
  };
}
