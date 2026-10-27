import { ApiError, CloudClient, type ClientOptions } from './client';
import { type Conversation, routes } from './contract';

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

/**
 * Opens the workspace this browser's session cookie signs in to (the web app after a reload or a
 * tap on a notification), or undefined when it signs in to none: no cookie, or one the server no
 * longer takes. The page never sees the session token; the server reads it from the cookie.
 * Throws when the server cannot be reached or answers something else.
 */
export async function openCookieWorkspace(
  options: Omit<ClientOptions, 'cookie'> & { onRevoked: () => void },
): Promise<Workspace | undefined> {
  const given = options.fetcher;
  const fetcher: typeof fetch = given
    ? (input, init) => given(input, init)
    : globalThis.fetch.bind(globalThis);
  const response = await fetcher(`${options.baseUrl ?? ''}${routes.me}`, {
    headers: { 'X-Maka-Cookie': '1' },
  });
  if (response.status === 401) return undefined;
  const body = (await response.json().catch(() => undefined)) as { ownerId?: unknown } | undefined;
  if (!response.ok || typeof body?.ownerId !== 'string')
    throw new ApiError(response.ok ? 502 : response.status);
  return openWorkspace('', { ...options, cookie: { owner: body.ownerId } });
}
