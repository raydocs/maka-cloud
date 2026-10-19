import type { SessionInfo } from '@maka-cloud/orchestrator';
import type { ConductorAccess, ConversationHandler } from '../cloud-server.js';
import { eventually, type Harness, postJson } from './harness.js';

/** A handler that remembers what it was given, standing in for the conductor. */
export function recordingHandler() {
  const seen = new Map<string, ConductorAccess>();
  const messages: Array<{ conversationId: string; messageId: string; text: string }> = [];
  const handler: ConversationHandler = {
    onUserMessage(message, conductor) {
      messages.push(message);
      seen.set(message.conversationId, conductor);
    },
  };
  return { handler, seen, messages };
}

/** The orchestrator session a conversation's conductor would hold. */
export async function conductorSession(
  h: Harness,
  seen: Map<string, ConductorAccess>,
  conversationId: string,
): Promise<{ session: SessionInfo; token: string }> {
  if (!seen.has(conversationId)) {
    await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'start' });
    await eventually(() => seen.has(conversationId), 'handler call');
  }
  const token = seen.get(conversationId)?.rotateToken() ?? '';
  const session = h.server.orchestrator.authenticate(token);
  if (!session) throw new Error('conductor token did not resolve');
  return { session, token };
}
