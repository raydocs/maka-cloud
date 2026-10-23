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

// One bounded record survives notification dismissal and service worker restarts.
const TERMINAL_URL = '/.maka-terminal-tasks';
async function terminalTasks(account, task, terminal) {
  try {
    const cache = await caches.open('maka-terminal-tasks');
    const key = TERMINAL_URL + '/' + encodeURIComponent(account);
    const stored = await cache.match(key);
    const entries = stored ? JSON.parse(await stored.text()) : [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = entries.filter(([id, time]) => typeof id === 'string' && time > cutoff);
    const ended = recent.some(([id]) => id === task);
    if (terminal && !ended) recent.push([task, Date.now()]);
    await cache.put(key, new Response(JSON.stringify(recent.slice(-200))));
    return ended;
  } catch {
    return false;
  }
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
      const tag = quiet ? 'maka-quiet' : 'maka-account-mismatch';
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
    if (task && known && (taskState || shown.approval)) {
      const ended = await terminalTasks(account, task, rank === 2);
      if (ended && rank !== 2) return neutral(true);
    }
    const approval = identifier(payload.actionRef) || identifier(payload.approvalId) || task;
    const tag =
      shown.approval && approval
        ? 'maka-approval:' + encodeURIComponent(approval)
        : taskState && task
          ? 'maka-task:' + encodeURIComponent(task)
          : shown.tag;
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
          return neutral(true);
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

let openId = 0;

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const own = windows.find((client) => {
        const url = new URL(client.url);
        return (
          url.origin === self.location.origin &&
          url.href.startsWith(self.registration.scope) &&
          !url.pathname.startsWith('/callback')
        );
      });
      await pushQueue;
      const account = await accountTag();
      const context = own ? await contextOf(own) : undefined;
      // A notice retains its owner even if the subscription has since moved accounts.
      const noticeAccount = identifier(event.notification.data?.accountTag);
      const raw =
        noticeAccount && noticeAccount === (own ? context?.tag : account)
          ? event.notification.data?.path
          : '/';

      const target = new URL(typeof raw === 'string' ? raw : '/', self.location.origin);
      const path = target.origin === self.location.origin ? target.pathname + target.search : '/';
      if (own) {
        try {
          // A refused focus still leaves the open app able to route; only no answer opens a window.
          await own.focus().catch(() => undefined);
          const id = ++openId;
          const acknowledged = await new Promise((resolve) => {
            const channel = new MessageChannel();
            let live = true;
            const finish = (ok) => {
              if (!live) return;
              live = false;
              if (ok) channel.port1.postMessage({ type: 'maka.open.go', id });
              clearTimeout(timer);
              channel.port1.close();
              resolve(ok);
            };
            // Firefox's notification activation is tighter (~1 s); keep this below it.
            // Chromium documents a 10 s notificationclick window. Do not wait near that limit.
            const timer = setTimeout(() => finish(false), 500);
            channel.port1.onmessage = (message) => {
              if (message.data?.type === 'maka.open.ack' && message.data.id === id) finish(true);
            };
            try {
              own.postMessage({ type: 'maka.open', path, id }, [channel.port2]);
            } catch {
              finish(false);
            }
          });
          if (acknowledged) return;
        } catch {
          // An unavailable client must not swallow the click.
        }
      }
      return self.clients.openWindow(path);
    })(),
  );
});
