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

self.addEventListener('push', (event) => {
  const shown = NOTIFICATIONS[typeOf(event)];
  event.waitUntil(
    self.registration.showNotification(shown.title, {
      body: shown.body,
      tag: shown.tag,
      data: { path: '/' },
    }),
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
