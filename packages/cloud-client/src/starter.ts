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
/** A conversation's name: its first sentence's first line, cut at a word near 60 characters. */
export function titleFrom(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\s+/gu, ' ').trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/u, '')}…`;
}

export class ConversationStarter {
  private attempt: { conversationId: string; clientMessageId: string; title: string } | null = null;
  /** Bumped by every edit: a lookup that finishes after an edit was for other words. */
  private revision = 0;

  constructor(
    private readonly client: CloudClient,
    private readonly now: () => number = Date.now,
    /** Where an unacknowledged first message is kept across a reload; none keeps it in memory. */
    private readonly sends?: PendingSends,
  ) {}

  async start(text: string, mode?: Mode): Promise<Conversation> {
    const body = text.trim();
    const title = titleFrom(body);
    // After a reload, the same sentence whose post was never acknowledged reuses its conversation
    // and its id: one conversation and one message, never two.
    const revision = this.revision;
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
      if (known) {
        this.attempt = { conversationId: kept.conversationId, clientMessageId: kept.id, title };
      } else {
        this.sends?.clear(START_KEY);
        kept = undefined;
      }
    }
    this.attempt ??= {
      conversationId: (await this.client.createConversation(title)).conversationId,
      clientMessageId: randomId(),
      title,
    };
    const { conversationId, clientMessageId, title: name } = this.attempt;
    this.sends?.write(START_KEY, {
      id: clientMessageId,
      text: body,
      at: kept?.at ?? this.now(),
      conversationId,
    });
    try {
      await this.client.postMessage(conversationId, body, clientMessageId, mode);
    } catch (error) {
      // This post was the words as submitted. If they were edited while it was in flight (an edit
      // before the attempt existed could not change its id), the next send is a new message.
      if (revision !== this.revision && this.attempt) this.attempt.clientMessageId = randomId();
      throw error;
    }
    this.attempt = null;
    this.sends?.clear(START_KEY);
    return { conversationId, title: name, createdAt: this.now() };
  }

  /** Call when the sentence changes. */
  draftEdited(): void {
    this.revision += 1;
    if (this.attempt) this.attempt.clientMessageId = randomId();
  }
}
