import { en, zhHans, zhHant } from './strings';

// Notification copy is fixed; payload identifiers are used only in same-origin links and tags.
const NOTIFICATIONS = {
  'task.finished': {
    title: 'Your background task has finished',
    body: 'Open Maka to review the result.',
    tag: 'maka-task-complete',
  },
  'task.failed': {
    title: 'Task failed',
    body: 'Open Maka to review the result.',
    tag: 'maka-task',
  },
  'task.stopped': {
    title: 'Task stopped',
    body: 'Open Maka to review the result.',
    tag: 'maka-task',
  },
  'task.running': {
    title: 'Task running',
    body: 'Open Maka to review the result.',
    tag: 'maka-task',
  },
  'approval.required': {
    title: 'Your decision is needed',
    body: 'Open Maka to review the request.',
    tag: 'maka-approval',
    approval: true,
  },
  'spend.alert': {
    title: 'Spending is high today',
    body: 'Open Maka to see where it went.',
    tag: 'maka-spend-alert',
  },
};
const NEUTRAL = {
  title: 'Something needs a look',
  body: 'Open Maka to check your inbox.',
  tag: 'maka-inbox',
};

function payloadOf(event) {
  try {
    const value = event.data?.json();
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
const identifier = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
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

let pushQueue = Promise.resolve();
async function contextOf(client) {
  if (!client.id) return undefined;
  try {
    return await (
      await (
        await caches.open('maka-context')
      ).match('/.maka-context/' + encodeURIComponent(client.id))
    )?.json();
  } catch {
    return undefined;
  }
}
const ACCOUNT_URL = '/.maka-account';
async function accountTag() {
  try {
    return await (await (await caches.open('maka-account')).match(ACCOUNT_URL))?.text();
  } catch {
    return undefined;
  }
}

const LANGUAGE_CACHE = 'maka-language';
const LANGUAGE_URL = '/.maka-language';

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  if (event.data?.type === 'maka.subscription') {
    const tag = identifier(event.data.accountTag);
    if (!tag) return;
    const work = pushQueue.then(async () => {
      await (await caches.open('maka-account')).put(ACCOUNT_URL, new Response(tag));
    });
    pushQueue = work.catch(() => {});
    event.waitUntil(work);
    return;
  }
  if (event.data?.type === 'maka.context') {
    const work = pushQueue.then(async () => {
      const tag = identifier(event.data.accountTag) || '';
      const contexts = await caches.open('maka-context');
      await contexts.put(
        '/.maka-context/' + encodeURIComponent(event.source.id),
        new Response(
          JSON.stringify({
            tag,
            conversation: identifier(event.data.conversationId),
          }),
        ),
      );
      const keys = await contexts.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) await contexts.delete(key);
    });
    pushQueue = work.catch(() => {});
    event.waitUntil(work);
    return;
  }
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
  if (
    /^zh-(?:hant|tw|hk|mo)(?:-|$)/iu.test(
      self.navigator?.language ?? self.navigator?.languages?.[0] ?? '',
    )
  ) {
    return 'zh-Hant';
  }
  return /^en(?:-|$)/iu.test(self.navigator?.language ?? self.navigator?.languages?.[0] ?? '')
    ? 'en'
    : 'zh-Hans';
}

self.addEventListener('push', (event) => {
  const payload = payloadOf(event);
  const known = typeof payload.type === 'string' && Object.hasOwn(NOTIFICATIONS, payload.type);
  const terminal =
    payload.type === 'task.finished' &&
    (payload.state === 'failed'
      ? 'task.failed'
      : ['stopped', 'cancelled'].includes(payload.state)
        ? 'task.stopped'
        : undefined);
  const shown = known ? NOTIFICATIONS[terminal || payload.type] : NEUTRAL;
  const work = pushQueue.then(async () => {
    const account = await accountTag();
    const table = { en, 'zh-Hans': zhHans, 'zh-Hant': zhHant }[await language()];
    const neutral = async (quiet = false) => {
      const tag = quiet ? 'maka-quiet' : NEUTRAL.tag;
      await self.registration.showNotification(table[NEUTRAL.title], {
        body: table[NEUTRAL.body],
        tag,
        silent: quiet,
        data: { path: '/' },
      });
      if (quiet) {
        for (const notice of await self.registration.getNotifications({ tag })) notice.close();
      }
    };
    if (!account || payload.accountTag !== account) return neutral();
    const task = identifier(payload.taskId);
    const taskState = known && payload.type.startsWith('task.');
    const rank = taskState ? (payload.type === 'task.running' ? 1 : 2) : 0;
    const approval = identifier(payload.actionRef) || identifier(payload.approvalId) || task;
    const tag =
      shown.approval && approval
        ? 'maka-approval:' + encodeURIComponent(approval)
        : taskState && task
          ? 'maka-task:' + encodeURIComponent(task)
          : shown.tag;
    const records = await caches.open('maka-task-terminal');
    const recordKey = '/.maka-terminal/' + account + '/' + encodeURIComponent(task || '');
    if (rank === 1 && (await records.match(recordKey))) return neutral(true);
    if (rank === 2 && task) {
      await records.put(recordKey, new Response('terminal'));
      const keys = await records.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - 200))) await records.delete(key);
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const contexts = await Promise.all(windows.map(contextOf));
    if (identifier(payload.conversationId)) {
      for (const [index, client] of windows.entries()) {
        const context = contexts[index];
        if (
          client.visibilityState === 'visible' &&
          client.focused &&
          context?.tag === account &&
          context.conversation === payload.conversationId
        ) {
          try {
            client.postMessage({ ...payload, type: 'maka.push' });
            return neutral(true);
          } catch {
            // A disappearing client still needs the usual notification.
          }
        }
      }
    }
    const previous = taskState ? await self.registration.getNotifications({ tag }) : [];
    if (previous.some((notice) => notice.data?.rank > rank)) return neutral(true);
    await self.registration.showNotification(table[shown.title], {
      body: table[shown.body],
      tag,
      ...(rank === 2 && previous.some((notice) => notice.data?.rank === 1)
        ? { renotify: true }
        : {}),
      data: { accountTag: account, path: pathOf(payload, known), ...(rank ? { rank } : {}) },
      ...(shown.approval ? { actions: [{ action: 'open', title: table.Open }] } : {}),
    });
  });
  pushQueue = work.catch(() => {});
  event.waitUntil(work);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const own = windows.find((client) => new URL(client.url).origin === self.location.origin);
      await pushQueue;
      const account = await accountTag();
      const context = own ? await contextOf(own) : undefined;
      const raw =
        account &&
        (!own || context?.tag === account) &&
        event.notification.data?.accountTag === account
          ? event.notification.data?.path
          : '/';
      const target = new URL(typeof raw === 'string' ? raw : '/', self.location.origin);
      const path = target.origin === self.location.origin ? target.pathname + target.search : '/';
      if (own) {
        try {
          await own.focus().catch(() => {});
          own.postMessage({ type: 'maka.open', path });
          return;
        } catch {
          // An unavailable client must not swallow the click.
        }
      }
      return self.clients.openWindow(path);
    })(),
  );
});
