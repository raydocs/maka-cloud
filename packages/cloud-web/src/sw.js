import { en, zhHans, zhHant } from './strings';

// Notification copy is fixed; payload identifiers are used only in same-origin links and tags.
const NOTIFICATIONS = {
  'task.finished': { title: 'Your background task has finished', body: 'Open Maka to review the result.', tag: 'maka-task-complete' },
  'task.failed': { title: 'Task failed', body: 'Open Maka to review the result.', tag: 'maka-task' },
  'task.stopped': { title: 'Task stopped', body: 'Open Maka to review the result.', tag: 'maka-task' },
  'task.running': { title: 'Task running', body: 'Open Maka to review the result.', tag: 'maka-task' },
  'approval.required': { title: 'Your decision is needed', body: 'Open Maka to review the request.', tag: 'maka-approval', approval: true },
  'spend.alert': { title: 'Spending is high today', body: 'Open Maka to see where it went.', tag: 'maka-spend-alert' },
};
const NEUTRAL = { title: 'Something needs a look', body: 'Open Maka to check your inbox.', tag: 'maka-inbox' };

function payloadOf(event) {
  try {
    const value = event.data?.json();
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
function pathOf(payload, known) {
  if (!known) return '/?inbox=1';
  const query = new URLSearchParams();
  const conversation = identifier(payload.conversationId);
  const task = identifier(payload.taskId);
  if (conversation) query.set('conversation', conversation);
  if (task) query.set('task', task);
  if (payload.type === 'approval.required') query.set('decision', '1');
  return query.size ? '/?' + query.toString() : '/';
}

const LANGUAGE_CACHE = 'maka-language';
const LANGUAGE_URL = '/.maka-language';

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  const language = event.data?.type === 'maka.language' ? event.data.language : undefined;
  if (
    language !== 'system' &&
    language !== 'en' &&
    language !== 'zh-Hans' &&
    language !== 'zh-Hant'
  )
    return;
  event.waitUntil(
    caches
      .open(LANGUAGE_CACHE)
      .then((cache) => cache.put(LANGUAGE_URL, new Response(language)))
      .catch(() => {}),
  );
});

async function language() {
  try {
    const stored = await (await caches.open(LANGUAGE_CACHE)).match(LANGUAGE_URL);
    const value = await stored?.text();
    if (value === 'en' || value === 'zh-Hans' || value === 'zh-Hant') return value;
  } catch {
    // Storage can be unavailable. The browser's first language is still a useful default.
  }
  if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/iu.test(self.navigator?.language ?? self.navigator?.languages?.[0] ?? '')) {
    return 'zh-Hant';
  }
  return /^en(?:-|$)/iu.test(self.navigator?.language ?? self.navigator?.languages?.[0] ?? '') ? 'en' : 'zh-Hans';
}

self.addEventListener('push', (event) => {
  const payload = payloadOf(event);
  const known = typeof payload.type === 'string' && Object.hasOwn(NOTIFICATIONS, payload.type);
  const terminal = payload.type === 'task.finished' && (payload.state === 'failed' ? 'task.failed' : ['stopped', 'cancelled'].includes(payload.state) ? 'task.stopped' : undefined);
  const shown = known ? NOTIFICATIONS[terminal || payload.type] : NEUTRAL;
  event.waitUntil(
    (async () => {
      const table = { en, 'zh-Hans': zhHans, 'zh-Hant': zhHant }[await language()];
      await self.registration.showNotification(table[shown.title], {
        body: table[shown.body],
        tag: identifier(payload.taskId) ? 'maka-task:' + encodeURIComponent(payload.taskId) : shown.tag,
        data: { path: pathOf(payload, known) },
        ...(shown.approval ? { actions: [{ action: 'open', title: table.Open }] } : {}),
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const own = windows.find((client) => new URL(client.url).origin === self.location.origin);
      const raw = event.notification.data?.path;
      const target = new URL(typeof raw === 'string' ? raw : '/', self.location.origin);
      const path = target.origin === self.location.origin ? target.pathname + target.search : '/';
      if (own) {
        await own.navigate(path);
        return own.focus();
      }
      return self.clients.openWindow(path);
    })(),
  );
});
