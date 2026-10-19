/* No server-derived content or URLs enter notification surfaces. */
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Your background task has finished', {
      body: 'Open Maka to review the result.',
      tag: 'maka-task-complete',
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
