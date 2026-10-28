/**
 * Where a link or a notification opens the app. A link carries only an id (`makacloud://task/<id>`,
 * `makacloud://decision/<id>`, `makacloud://` for Home), never a token or any text; the app fetches
 * what it needs once it is open. Anything it does not know opens Home.
 */

/** The ids the server hands out: letters, digits and `_ : . -`, at most 128. Nothing else is followed. */
const ID = /^[A-Za-z0-9_:.-]{1,128}$/u;

export type AppHref = '/' | `/?decision=${string}` | `/chat?task=${string}`;

/** The task opens in Chat, the conversation found from it; a decision opens on Home. */
export function taskHref(taskId: string, conversationId?: string): AppHref {
  const conversation =
    conversationId !== undefined && ID.test(conversationId)
      ? `&conversation=${encodeURIComponent(conversationId)}`
      : '';
  return `/chat?task=${encodeURIComponent(taskId)}${conversation}`;
}

/**
 * The screen for an incoming URL: the app's own scheme, or a path on the app's web domain (for
 * universal and App Links once the owner sets the domain up). `makacloud://task/t1` and
 * `/task/t1` are the same.
 */
export function hrefOfUrl(url: string): AppHref {
  const rest = url
    .trim()
    .replace(/^makacloud:\/\//iu, '')
    .replace(/^https:\/\/[^/?#]+/iu, '')
    .replace(/^\/+/u, '')
    .split(/[?#]/u)[0];
  const [kind, id, extra] = (rest ?? '').split('/');
  if (extra !== undefined && extra !== '') return '/';
  if (kind === 'task' && id !== undefined && ID.test(id)) return taskHref(id);
  if (kind === 'decision' && id !== undefined && ID.test(id)) {
    return `/?decision=${encodeURIComponent(id)}`;
  }
  return '/';
}

/**
 * The screen a tapped notification opens. A notification for another account than the one signed
 * in (the phone changed hands, or signed in elsewhere since) opens Home only, so it never shows one
 * account's ids to another. The data is the server's: `{type, accountTag, taskId | itemId, ...}`.
 */
export function hrefOfNotification(data: unknown, accountTag: string | undefined): AppHref {
  if (typeof data !== 'object' || data === null) return '/';
  const fields = data as Record<string, unknown>;
  const text = (name: string) => {
    const value = fields[name];
    return typeof value === 'string' && ID.test(value) ? value : undefined;
  };
  if (accountTag === undefined || fields.accountTag !== accountTag) return '/';
  const taskId = text('taskId');
  if (fields.type === 'task.finished' && taskId) return taskHref(taskId, text('conversationId'));
  const itemId = text('itemId');
  if (fields.type === 'inbox.needed' && itemId) return `/?decision=${encodeURIComponent(itemId)}`;
  return '/';
}
