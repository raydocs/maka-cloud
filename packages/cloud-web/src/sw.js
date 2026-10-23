import { en, zhHans, zhHant } from './strings';

/* No server-derived content or URLs enter notification surfaces. */

/*
 * The only thing read from a push is its `type`, and only to pick one of these fixed texts. Anything
 * else in a payload, and a payload that is missing, is not shown; an unknown type shows the default.
 */
const NOTIFICATIONS = {
  'task.finished': {
    title: 'Your background task has finished',
    body: 'Open Maka to review the result.',
    tag: 'maka-task-complete',
  },
  'spend.alert': {
    title: 'Spending is high today',
    body: 'Open Maka to see where it went.',
    tag: 'maka-spend-alert',
  },
};

function typeOf(event) {
  try {
    const payload = event.data ? event.data.json() : undefined;
    const type = payload && typeof payload === 'object' ? payload.type : undefined;
    return typeof type === 'string' && Object.hasOwn(NOTIFICATIONS, type) ? type : 'task.finished';
  } catch {
    return 'task.finished';
  }
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
  if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/iu.test(self.navigator?.languages?.[0] ?? '')) {
    return 'zh-Hant';
  }
  return /^en(?:-|$)/iu.test(self.navigator?.languages?.[0] ?? '') ? 'en' : 'zh-Hans';
}

self.addEventListener('push', (event) => {
  const shown = NOTIFICATIONS[typeOf(event)];
  event.waitUntil(
    (async () => {
      const table = { en, 'zh-Hans': zhHans, 'zh-Hant': zhHant }[await language()];
      await self.registration.showNotification(table[shown.title], {
        body: table[shown.body],
        tag: shown.tag,
        data: { path: '/' },
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
      if (own) return own.focus();
      return self.clients.openWindow('/');
    })(),
  );
});
