import type { CloudClient } from './client';
import type { Conversation, Mode } from './contract';
import { randomId } from './ids';
import { type PendingSends, reusable } from './pending';

/** The key a first message is kept under: it is not in a conversation yet. */
const START_KEY = 'start';

/**
 * Starts a conversation from one sentence. A retry after a failed post reuses the conversation and
 * the message id (so it is one message, never two); editing the sentence makes it a new message.
 */
export class ConversationStarter {
  private attempt: { conversationId: string; clientMessageId: string } | null = null;

  constructor(
    private readonly client: CloudClient,
    private readonly now: () => number = Date.now,
    /** Where an unacknowledged first message is kept across a reload; none keeps it in memory. */
    private readonly sends?: PendingSends,
  ) {}

  async start(text: string, mode?: Mode): Promise<Conversation> {
    const body = text.trim();
    // After a reload, the same sentence whose post was never acknowledged reuses its conversation
    // and its id: one conversation and one message, never two.
    let kept = reusable(this.sends?.read(START_KEY), body, this.now());
    if (!this.attempt && kept?.conversationId) {
      // Only a conversation this invite can open: a kept one from another invite in this tab is
      // not reused (it would answer 404 every time).
      const known = await this.client
        .listConversations()
        .then(({ conversations }) =>
          conversations.some((c) => c.conversationId === kept?.conversationId),
        )
        .catch(() => true);
      if (known) this.attempt = { conversationId: kept.conversationId, clientMessageId: kept.id };
      else {
        this.sends?.clear(START_KEY);
        kept = undefined;
      }
    }
    this.attempt ??= {
      conversationId: (await this.client.createConversation()).conversationId,
      clientMessageId: randomId(),
    };
    const { conversationId, clientMessageId } = this.attempt;
    this.sends?.write(START_KEY, {
      id: clientMessageId,
      text: body,
      at: kept?.at ?? this.now(),
      conversationId,
    });
    await this.client.postMessage(conversationId, body, clientMessageId, mode);
    this.attempt = null;
    this.sends?.clear(START_KEY);
    return { conversationId, title: null, createdAt: this.now() };
  }

  /** Call when the sentence changes. */
  draftEdited(): void {
    if (this.attempt) this.attempt.clientMessageId = randomId();
  }
}
