import type { CloudClient } from './client';
import type { Conversation } from './contract';
import { randomId } from './ids';

/**
 * Starts a conversation from one sentence. A retry after a failed post reuses the conversation and
 * the message id (so it is one message, never two); editing the sentence makes it a new message.
 */
export class ConversationStarter {
  private attempt: { conversationId: string; clientMessageId: string } | null = null;

  constructor(
    private readonly client: CloudClient,
    private readonly now: () => number = Date.now,
  ) {}

  async start(text: string): Promise<Conversation> {
    this.attempt ??= {
      conversationId: (await this.client.createConversation()).conversationId,
      clientMessageId: randomId(),
    };
    const { conversationId, clientMessageId } = this.attempt;
    await this.client.postMessage(conversationId, text.trim(), clientMessageId);
    this.attempt = null;
    return { conversationId, title: null, createdAt: this.now() };
  }

  /** Call when the sentence changes. */
  draftEdited(): void {
    if (this.attempt) this.attempt.clientMessageId = randomId();
  }
}
