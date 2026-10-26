import type { Conductor } from '@maka-cloud/conductor';
import { type Language, localizedAsk, messages, scrubErrorText } from '@maka-cloud/server';
import type { Interrupt } from '@maka-cloud/supervisor';

const MAX_ASK_CHARS = 300;

type NoticeApi = Pick<Conductor, 'postNotice'>;

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= MAX_ASK_CHARS ? flat : `${flat.slice(0, MAX_ASK_CHARS - 1)}…`;
}

/**
 * Tells the human by a notice in the conversation the item is about. A batch becomes one notice
 * per conversation. The inbox keeps the full item; the notice carries only the ask. Web push is
 * a second notifier once the web app has it. With `languageOf`, the notice is in the language of
 * the conversation's owner (an ask a rule built from a fixed sentence included); without it, English.
 */
export function conductorNotifier(
  conductor: NoticeApi,
  languageOf?: (conversationId: string) => Language,
): {
  interrupt(interrupt: Interrupt): Promise<void>;
} {
  return {
    async interrupt(interrupt) {
      const byConversation = new Map<string, string[]>();
      for (const item of interrupt.items) {
        const asks = byConversation.get(item.conversationId) ?? [];
        const language = languageOf?.(item.conversationId);
        const ask =
          (language === undefined ? undefined : localizedAsk(item.askTemplate, language)) ??
          item.ask;
        // The ask quotes agent-written text; the notice lands in the conversation clients see.
        asks.push(clip(scrubErrorText(ask)));
        byConversation.set(item.conversationId, asks);
      }
      for (const [conversationId, asks] of byConversation) {
        const [only] = asks;
        const words = messages(languageOf?.(conversationId) ?? 'en').needsYou;
        const text =
          asks.length === 1 && only !== undefined
            ? words.one(only)
            : words.many(asks.length, asks.map((ask) => `- ${ask}`).join('\n'));
        await conductor.postNotice({ conversationId, text });
      }
    },
  };
}
