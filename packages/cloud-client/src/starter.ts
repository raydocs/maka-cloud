import type { CloudClient } from './client';
import type { Conversation, Mode } from './contract';
import { randomId } from './ids';

/**
 * Starts a conversation from one sentence. A retry after a failed post reuses the conversation and
 * the message id (so it is one message, never two); editing the sentence makes it a new message.
 */
/** A conversation's name: its first sentence's first line, cut at a word near 60 characters. */
export function titleFrom(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\s+/gu, ' ').trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/u, '')}…`;
}

export class ConversationStarter {
  private attempt: { conversationId: string; clientMessageId: string; title: string } | null =
    null;

  constructor(
    private readonly client: CloudClient,
    private readonly now: () => number = Date.now,
  ) {}

  async start(text: string, mode?: Mode): Promise<Conversation> {
    if (!this.attempt) {
      const title = titleFrom(text);
      this.attempt = {
        conversationId: (await this.client.createConversation(title)).conversationId,
        clientMessageId: randomId(),
        title,
      };
    }
    const { conversationId, clientMessageId, title } = this.attempt;
    await this.client.postMessage(conversationId, text.trim(), clientMessageId, mode);
    this.attempt = null;
    return { conversationId, title, createdAt: this.now() };
  }

  /** Call when the sentence changes. */
  draftEdited(): void {
    if (this.attempt) this.attempt.clientMessageId = randomId();
  }
}
