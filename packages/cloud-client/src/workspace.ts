import { CloudClient, type ClientOptions } from './client';
import type { Conversation } from './contract';

export interface Workspace {
  client: CloudClient;
  conversations: Conversation[];
  /** The conversation to open, or '' when there is none yet. */
  chosen: string;
  /** Someone with conversations lands in the latest one; a first visit lands on Home. */
  landing: 'home' | 'chat';
}

/**
 * Signs in with an invite token: builds the client, reads the conversations, and says where to
 * land. `onRevoked` runs when the server later refuses the invite, and the caller leaves the
 * workspace and keeps nothing of it. Throws what the client threw (the caller says it in words).
 */
export async function openWorkspace(
  token: string,
  options: ClientOptions & { onRevoked: () => void },
): Promise<Workspace> {
  const client = new CloudClient(token, options);
  const { conversations } = await client.listConversations();
  const chosen = conversations.at(-1)?.conversationId ?? '';
  return { client, conversations, chosen, landing: chosen ? 'chat' : 'home' };
}
