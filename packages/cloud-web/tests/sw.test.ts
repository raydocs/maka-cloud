import { CloudClient } from '@maka-cloud/client';
import { restorePush } from '../src/push';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { expect, test, vi } from 'vitest';

type Listener = (event: unknown) => void;

/** Runs the real service worker script against a stand-in for its global scope. */
function load(
  language = 'en-US',
  saved = new Map<string, string>(),
  windows: Array<{
    id?: string;
    visibilityState?: string;
    focused?: boolean;
    url: string;
    focus: () => Promise<unknown>;
    postMessage: (data: unknown, ports?: MessagePort[]) => void;
  }> = [],
  registrationScope = 'https://maka.example.test/',
) {
  if (!saved.has('/.maka-account')) saved.set('/.maka-account', 'account-a');
  const caches = {
    open: async () => ({
      keys: async () => [...saved.keys()],
      delete: async (key: string) => saved.delete(key),
      put: async (key: string, value: Response) => {
        saved.set(key, await value.text());
      },
      match: async (key: string) => (saved.has(key) ? new Response(saved.get(key)) : undefined),
    }),
  };
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const closed: unknown[] = [];
  const scope = {
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    registration: {
      scope: registrationScope,
      getNotifications: async ({ tag }: { tag: string }) =>
        shown
          .filter((notice) => notice.options.tag === tag)
          .map((notice) => ({
            data: notice.options.data,
            close: () => closed.push(notice.options.tag),
          })),
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    location: { origin: 'https://maka.example.test' },
    navigator: { languages: [language] },
    clients: {
      matchAll: async () => windows.map((client) => ({ id: 'tab', ...client })),
      openWindow: async (path: string) => {
        opened.push(path);
      },
    },
  };
  vm.runInNewContext(readFileSync(join(__dirname, '../dist/sw.js'), 'utf8'), {
    caches,
    Response,
    self: scope,
    URL,
    URLSearchParams,
    Object,
    setTimeout,
    clearTimeout,
    MessageChannel: class {
      port1 = {
        onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
        postMessage: (data: unknown) => this.port2.onmessage?.({ data }),
        close() {},
      };
      port2 = {
        onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
        postMessage: (data: unknown) => this.port1.onmessage?.({ data }),
      };
    },
  });
  const push = async (data: unknown, tagged = true) => {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({
      data:
        data === undefined && !tagged
          ? undefined
          : {
              json: () =>
                tagged
                  ? {
                      ...(data instanceof Error ? raise(data) : (data as object)),
                      accountTag:
                        (data as { accountTag?: string } | null)?.accountTag ?? 'account-a',
                    }
                  : data,
            },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
  };
  const message = async (
    language: string | Record<string, unknown>,
    origin = 'https://maka.example.test',
    clientId = 'tab',
  ) => {
    const waits: Promise<unknown>[] = [];
    listeners.get('message')?.({
      source: { id: clientId, url: `${origin}/` },
      data: typeof language === 'string' ? { type: 'maka.language', language } : language,
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
  };
  const click = async (path: string, accountTag = 'account-a') => {
    const waits: Promise<unknown>[] = [];
    listeners.get('notificationclick')?.({
      notification: { close() {}, data: { path, accountTag } },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
  };
  return { push, shown, message, click, opened, closed };
}

function raise(error: Error): never {
  throw error;
}

const TASK = {
  title: 'Your background task has finished',
  body: 'Open Maka to review the result.',
  tag: 'maka-task-complete',
};
const SPEND = {
  title: 'Spending is high today',
  body: 'Open Maka to see where it went.',
  tag: 'maka-spend-alert',
};

test('a task message and a spend alert each show their own fixed text', async () => {
  const worker = load();
  await worker.push({
    type: 'task.finished',
    conversationId: 'cnv_1',
    taskId: 'tsk_1',
    state: 'ok',
  });
  await worker.push({ type: 'spend.alert' });
  expect(worker.shown.map((n) => [n.title, n.options.body, n.options.tag])).toEqual([
    [TASK.title, TASK.body, 'maka-task:tsk_1'],
    [SPEND.title, SPEND.body, SPEND.tag],
  ]);
  expect(worker.shown[0]?.options.data).toEqual({
    accountTag: 'account-a',
    path: '/?conversation=cnv_1&task=tsk_1',
    rank: 2,
  });
});

test('nothing a payload carries reaches the notification', async () => {
  const worker = load();
  await worker.push({
    type: 'spend.alert',
    title: 'Send $500 to attacker.example',
    body: 'click here',
    amount: 123.45,
    url: 'https://attacker.example',
    data: { path: 'https://attacker.example' },
  });
  const [only] = worker.shown;
  expect(only?.title).toBe(SPEND.title);
  expect(JSON.stringify(only)).not.toMatch(/attacker|500|123|click/u);
  expect(only?.options.data).toEqual({ accountTag: 'account-a', path: '/' });
});

test('unknown and malformed payloads always show neutral text', async () => {
  const worker = load();
  for (const payload of [
    { type: 'something.new', body: 'x' },
    { type: 'constructor' },
    { type: '__proto__' },
    { type: 7 },
    { type: ['spend.alert'] },
    'spend.alert',
    null,
    42,
    undefined,
  ]) {
    await worker.push(payload);
  }
  expect(worker.shown).toHaveLength(9);
  for (const shown of worker.shown) {
    expect([shown.title, shown.options.body, shown.options.tag]).toEqual([
      'Something needs a look',
      'Open Maka to check your inbox.',
      'maka-inbox',
    ]);
  }
});

test('Chinese is the fallback for notifications, including when no page is open', async () => {
  const worker = load('fr-FR');
  await worker.push({ type: 'task.finished', title: 'Untrusted title' });
  await worker.push({ type: 'spend.alert' });
  expect(worker.shown.map((notice) => [notice.title, notice.options.body])).toEqual([
    ['你的后台任务已完成', '打开 Maka 查看结果。'],
    ['今天的花费较高', '打开 Maka 查看花费明细。'],
  ]);
});

test('notification language survives worker restart and ignores messages from other origins', async () => {
  const saved = new Map<string, string>();
  const first = load('en-US', saved);
  await first.message('zh-Hans');
  const restarted = load('en-US', saved);
  await restarted.message('en', 'https://untrusted.example');
  await restarted.message('invalid');
  await restarted.push({ type: 'task.finished' });
  expect(restarted.shown[0]?.title).toBe('你的后台任务已完成');
  await restarted.message('en');
  await restarted.push({ type: 'task.finished' });
  expect(restarted.shown[1]?.title).toBe(TASK.title);
  await restarted.message('system');
  const chineseBrowser = load('zh-TW', saved);
  await chineseBrowser.push({ type: 'task.finished' });
  expect(chineseBrowser.shown[0]?.title).toBe('你的背景任務已完成');
});

test('the production worker is a self-contained classic script', () => {
  const script = readFileSync(join(__dirname, '../dist/sw.js'), 'utf8');
  expect(script).not.toMatch(/\b(?:import|export)\s*(?:[{'"*]|\w)/u);
  expect(() => new vm.Script(script)).not.toThrow();
});

test.each(['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO'])(
  'Traditional notifications for %s',
  async (locale) => {
    const worker = load(locale);
    await worker.push({ type: 'task.finished' });
    await worker.push({ type: 'spend.alert' });
    expect(worker.shown.map((notice) => [notice.title, notice.options.body])).toEqual([
      ['你的背景任務已完成', '開啟 Maka 查看結果。'],
      ['今天的花費較高', '開啟 Maka 查看花費明細。'],
    ]);
    const saved = new Map<string, string>();
    await load('en', saved).message('zh-Hant');
    const restarted = load('en', saved);
    await restarted.push({ type: 'task.finished' });
    expect(restarted.shown[0]?.title).toBe('你的背景任務已完成');
  },
);

test('task states replace one tag; approval only offers opening the in-app decision', async () => {
  const worker = load();
  for (const type of [
    'task.running',
    'approval.required',
    'task.finished',
    'task.failed',
    'task.stopped',
  ])
    await worker.push({ type, taskId: 'one', conversationId: 'chat' });
  expect(new Set(worker.shown.map((n) => n.options.tag))).toEqual(
    new Set(['maka-task:one', 'maka-approval:one']),
  );
  expect(worker.shown[1]?.options.actions).toEqual([{ action: 'open', title: 'Open' }]);
  expect(worker.shown[2]?.options.actions).toBeUndefined();
});
test.each([
  ['zh-TW', '有件事需要查看'],
  ['zh-HK', '有件事需要查看'],
  ['zh-MO', '有件事需要查看'],
  ['zh-CN', '有件事需要查看'],
  ['zh-SG', '有件事需要查看'],
  ['en-GB', 'Something needs a look'],
  ['fr', '有件事需要查看'],
])('neutral notification in %s opens inbox', async (locale, title) => {
  const worker = load(locale);
  await worker.push({ type: 'future.type', taskId: 'one' });
  expect(worker.shown[0]?.title).toBe(title);
  expect(worker.shown[0]?.options.data).toEqual({ accountTag: 'account-a', path: '/?inbox=1' });
});

test('click opens the payload target and refuses external destinations', async () => {
  const worker = load();
  await worker.click('/?conversation=chat&task=one');
  await worker.click('https://evil.example/');
  expect(worker.opened).toEqual(['/?conversation=chat&task=one', '/']);
});

test('the server terminal envelope preserves failed and stopped outcomes', async () => {
  const worker = load();
  for (const state of ['failed', 'stopped', '__proto__'])
    await worker.push({ type: 'task.finished', taskId: 'same', state });
  expect(worker.shown.map((n) => n.title)).toEqual(['Task failed', 'Task stopped', TASK.title]);
  expect(new Set(worker.shown.map((n) => n.options.tag)).size).toBe(1);
  await worker.push({ type: 'approval.required', taskId: 'same', conversationId: 'chat' });
  expect(worker.shown).toHaveLength(4);
  expect(worker.shown.at(-1)?.options.silent).toBe(true);
});

test('existing uncontrolled clients receive in-app links without navigation or reload', async () => {
  const focus = vi.fn(async () => {});
  const postMessage = vi.fn((data, ports) =>
    ports[0].postMessage({ type: 'maka.open.ack', id: data.id }),
  );
  const worker = load('en', new Map(), [{ url: 'https://maka.example.test/', focus, postMessage }]);
  await worker.message({ type: 'maka.context', accountTag: 'account-a' });
  await worker.click('/?task=one');
  expect(focus).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledWith(
    { type: 'maka.open', path: '/?task=one', id: expect.any(Number) },
    expect.anything(),
  );
  expect(worker.opened).toEqual([]);
});

test('a client that cannot be messaged falls back to a new window', async () => {
  const worker = load('en', new Map(), [
    {
      url: 'https://maka.example.test/',
      focus: async () => {},
      postMessage: () => {
        throw new Error('gone');
      },
    },
  ]);
  await worker.message({ type: 'maka.context', accountTag: 'account-a' });
  await worker.click('/?task=one');
  expect(worker.opened).toEqual(['/?task=one']);
});

test('approval and unknown tags stay separate; terminal replaces ongoing and resists late running pushes', async () => {
  const worker = load();
  await worker.push({ type: 'approval.required', taskId: 'one', actionRef: 'action-1' });
  await worker.push({ type: 'approval.required', taskId: 'one', actionRef: 'action-2' });
  await worker.push({ type: 'future.type', taskId: 'one' });
  await worker.push({ type: 'task.running', taskId: 'one' });
  await worker.push({ type: 'task.finished', taskId: 'one' });
  expect(worker.shown.map((notice) => notice.options.tag)).toEqual([
    'maka-approval:action-1',
    'maka-approval:action-2',
    'maka-inbox',
    'maka-task:one',
    'maka-task:one',
  ]);
  expect(worker.shown.at(-1)?.options.renotify).toBe(true);
  await worker.push({ type: 'task.running', taskId: 'one' });
  expect(worker.shown).toHaveLength(6);
  expect(worker.shown.at(-1)?.options.silent).toBe(true);
  expect(worker.closed).toContain('maka-quiet');
});

test('mismatched, missing, and pre-upgrade tags stay neutral until app-load recovery', async () => {
  const saved = new Map<string, string>();
  const worker = load('en', saved);
  await worker.push({ type: 'task.finished', accountTag: 'account-b', conversationId: 'private' });
  await worker.push({ type: 'task.finished' }, false);
  saved.delete('/.maka-account');
  await worker.push({ type: 'task.finished' });
  expect(worker.shown).toHaveLength(3);
  for (const notice of worker.shown) {
    expect(notice.title).toBe('Something needs a look');
    expect(notice.options.data).toEqual({ path: '/' });
  }
  await worker.click('/?conversation=private');
  expect(worker.opened).toEqual(['/']);
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration: async () => ({
        active: { postMessage: (message: Record<string, unknown>) => worker.message(message) },
        pushManager: {
          getSubscription: async () => ({
            toJSON: () => ({
              endpoint: 'https://push.example/one',
              keys: { p256dh: 'key', auth: 'auth' },
            }),
          }),
        },
      }),
    },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {});
  try {
    await restorePush(
      new CloudClient('token', async () => Response.json({ accountTag: 'new-tag' })),
    );
    await worker.push({ type: 'task.finished', accountTag: 'new-tag', conversationId: 'chat' });
    expect(worker.shown.at(-1)?.options.data).toMatchObject({
      accountTag: 'new-tag',
      path: '/?conversation=chat',
    });
    await worker.push({ type: 'future.type', accountTag: 'new-tag' });
    expect(worker.shown.at(-1)?.options.tag).toBe('maka-inbox');
    expect(worker.shown[0]?.options.tag).toBe('maka-account-mismatch');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('tab contexts cannot overwrite the subscription owner, including sign-out', async () => {
  const saved = new Map<string, string>();
  const worker = load('en', saved);
  await worker.message({ type: 'maka.subscription', accountTag: 'account-b' });
  await worker.message(
    { type: 'maka.context', accountTag: 'account-a', conversationId: 'chat' },
    undefined,
    'tab-a',
  );
  await worker.message(
    { type: 'maka.context', accountTag: 'account-b', conversationId: 'other' },
    undefined,
    'tab-b',
  );
  await worker.message({ type: 'maka.context', accountTag: null }, undefined, 'tab-a');
  expect(JSON.parse(saved.get('/.maka-context/tab-b') ?? '{}').tag).toBe('account-b');
  expect(saved.get('/.maka-account')).toBe('account-b');
  await worker.push({ type: 'task.finished', accountTag: 'account-b', taskId: 'one' });
  expect(worker.shown[0]?.title).toBe(TASK.title);
  await worker.push({ type: 'task.finished', accountTag: 'account-a', taskId: 'two' });
  expect(worker.shown[1]?.options.data).toEqual({ path: '/' });
  await worker.message({ type: 'maka.subscription', accountTag: 'account-a' });
  await worker.push({ type: 'spend.alert' });
  expect(worker.shown[2]?.title).toBe(SPEND.title);
});

test('visible conversations suppress banners but retain terminal ordering across restart', async () => {
  const saved = new Map<string, string>();
  const tab = {
    id: 'tab',
    visibilityState: 'visible',
    focused: true,
    url: 'https://maka.example.test/',
    focus: async () => {},
    postMessage: vi.fn(),
  };
  const worker = load('en', saved, [tab]);
  await worker.message({ type: 'maka.context', accountTag: 'account-a', conversationId: 'chat' });
  await worker.push({ type: 'task.finished', taskId: 'one', conversationId: 'chat' });
  expect(worker.shown).toHaveLength(1);
  expect(worker.shown[0]?.options.silent).toBe(true);
  expect(worker.closed).toContain('maka-quiet');
  expect(tab.postMessage).not.toHaveBeenCalled();
  const restarted = load('en', saved, [tab]);
  await restarted.push({ type: 'task.finished', taskId: 'other', conversationId: 'chat' });
  expect(restarted.shown.at(-1)?.options.silent).toBe(true);
  expect(restarted.closed).toContain('maka-quiet');
  await restarted.push({ type: 'task.running', taskId: 'one', conversationId: 'chat' });
  expect(restarted.shown.at(-1)?.options.silent).toBe(true);
  expect(restarted.closed).toContain('maka-quiet');
  tab.visibilityState = 'hidden';
  await worker.message({ type: 'maka.context', accountTag: 'account-a', conversationId: null });
  await worker.push({ type: 'task.finished', taskId: 'two', conversationId: 'chat' });
  expect(worker.shown).toHaveLength(2);
  expect(worker.shown[1]?.title).toBe(TASK.title);
});

test.each([undefined, 'account-b'])(
  'a shown notification routes to its own tab with subscription owner %s',
  async (owner) => {
    const saved = new Map<string, string>();
    const postMessage = vi.fn((data, ports) =>
      ports[0].postMessage({ type: 'maka.open.ack', id: data.id }),
    );
    const worker = load('en', saved, [
      { url: 'https://maka.example.test/', focus: async () => {}, postMessage },
    ]);
    await worker.message({ type: 'maka.context', accountTag: 'account-a' });
    await worker.push({ type: 'task.finished', conversationId: 'chat', taskId: 'one' });
    const notice = worker.shown[0]?.options.data as { path: string; accountTag: string };
    if (owner) await worker.message({ type: 'maka.subscription', accountTag: owner });
    else saved.delete('/.maka-account');
    await worker.click(notice.path, notice.accountTag);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'maka.open', path: '/?conversation=chat&task=one', id: expect.any(Number) },
      expect.anything(),
    );
    expect(worker.opened).toEqual([]);
  },
);

test.each([undefined, '', 'account-b'])(
  'a notification cannot deep-link a tab with missing or foreign account context %s',
  async (tag) => {
    const postMessage = vi.fn();
    const saved = new Map([
      ['/.maka-account', 'account-a'],
      ['/.maka-context/tab', JSON.stringify({ tag })],
    ]);
    const worker = load('en', saved, [
      { url: 'https://maka.example.test/', focus: async () => {}, postMessage },
    ]);
    await worker.click('/?conversation=private', 'account-a');
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'maka.open', path: '/', id: expect.any(Number) },
      expect.anything(),
    );
  },
);

test('a push with no data still displays a neutral root-only notification', async () => {
  const worker = load();
  await worker.push(undefined, false);
  await worker.push(new Error('not json'));
  expect(worker.shown).toHaveLength(2);
  expect(worker.shown[1]?.options.tag).toBe('maka-account-mismatch');
  expect(worker.shown[0]?.title).toBe('Something needs a look');
  expect(worker.shown[0]?.options.data).toEqual({ path: '/' });
});

test('only a focused visible conversation suppresses its task notification', async () => {
  const tab = {
    id: 'tab',
    visibilityState: 'visible',
    focused: false,
    url: 'https://maka.example.test/',
    focus: async () => {},
    postMessage: () => {
      throw new Error('gone');
    },
  };
  const worker = load('en', new Map(), [tab]);
  await worker.message({ type: 'maka.context', accountTag: 'account-a', conversationId: 'chat' });
  await worker.push({ type: 'task.finished', taskId: 'one', conversationId: 'chat' });
  tab.focused = true;
  await worker.push({ type: 'task.finished', taskId: 'two', conversationId: 'chat' });
  expect(worker.shown.map((notice) => notice.title)).toEqual([
    TASK.title,
    'Something needs a look',
  ]);
  expect(worker.shown[1]?.options.silent).toBe(true);
});

test('dismissed terminal tasks survive a restart, expire after seven days, and keep only 200 records', async () => {
  const saved = new Map<string, string>();
  await load('en', saved).push({ type: 'task.finished', taskId: 'ended' });
  const restarted = load('en', saved);
  await restarted.push({ type: 'task.running', taskId: 'ended' });
  expect(restarted.shown).toHaveLength(1);
  expect(restarted.shown[0]?.options.silent).toBe(true);
  const key = '/.maka-terminal-tasks/account-a';
  saved.set(key, JSON.stringify([['expired', Date.now() - 8 * 86400000]]));
  await restarted.push({ type: 'task.running', taskId: 'expired' });
  expect(restarted.shown).toHaveLength(2);
  for (let i = 0; i < 201; i++) await restarted.push({ type: 'task.finished', taskId: String(i) });
  const records = JSON.parse(saved.get(key)!);
  expect(records).toHaveLength(200);
  expect(records[0][0]).toBe('1');
});

test('callback clients are skipped and an app without an ack falls back after half a second when focused', async () => {
  vi.useFakeTimers();
  try {
    const callback = vi.fn();
    const app = vi.fn();
    const worker = load('en', new Map(), [
      { url: 'https://maka.example.test/callback', focus: async () => {}, postMessage: callback },
      { url: 'https://maka.example.test/', focus: async () => {}, postMessage: app },
    ]);
    await worker.message({ type: 'maka.context', accountTag: 'account-a' });
    const click = worker.click('/?task=one');
    await vi.advanceTimersByTimeAsync(499);
    expect(callback).not.toHaveBeenCalled();
    expect(app).toHaveBeenCalledOnce();
    expect(worker.opened).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await click;
    expect(worker.opened).toEqual(['/?task=one']);
  } finally {
    vi.useRealTimers();
  }
});

test.each([100, 600])(
  'focused nested app ack at %s ms routes only with worker go',
  async (delay) => {
    vi.useFakeTimers();
    try {
      const routes: string[] = [];
      const worker = load('en', new Map(), [
        {
          url: 'https://maka.example.test/tasks/one',
          focus: async () => {},
          postMessage: (data, ports) => {
            const { id, path } = data as { id: number; path: string };
            const port = ports![0];
            port.onmessage = (reply) => {
              if (reply.data.type === 'maka.open.go' && reply.data.id === id) routes.push(path);
            };
            setTimeout(() => port.postMessage({ type: 'maka.open.ack', id }), delay);
          },
        },
      ]);
      await worker.message({ type: 'maka.context', accountTag: 'account-a' });
      const click = worker.click('/?task=one');
      await vi.advanceTimersByTimeAsync(1000);
      await click;
      expect(routes).toEqual(delay < 500 ? ['/?task=one'] : []);
      expect(worker.opened).toEqual(delay < 500 ? [] : ['/?task=one']);
      expect(routes.length + worker.opened.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  },
);

test('a refused focus still lets the open app route; no answer opens a window', async () => {
  const refused = async () => {
    throw new Error('unavailable');
  };
  const answering = vi.fn((data, ports) =>
    ports[0].postMessage({ type: 'maka.open.ack', id: data.id }),
  );
  const routed = load('en', new Map(), [
    { url: 'https://maka.example.test/', focus: refused, postMessage: answering },
  ]);
  await routed.message({ type: 'maka.context', accountTag: 'account-a' });
  await routed.click('/?task=one');
  expect(answering).toHaveBeenCalledOnce();
  expect(routed.opened).toEqual([]);

  const silent = vi.fn();
  const opened = load('en', new Map(), [
    { url: 'https://maka.example.test/', focus: refused, postMessage: silent },
  ]);
  await opened.message({ type: 'maka.context', accountTag: 'account-a' });
  await opened.click('/?task=one');
  expect(silent).toHaveBeenCalledOnce();
  expect(opened.opened).toEqual(['/?task=one']);
});

test('clients outside the worker registration scope are skipped', async () => {
  const outside = vi.fn();
  const inside = vi.fn((data, ports) =>
    ports[0].postMessage({ type: 'maka.open.ack', id: data.id }),
  );
  const worker = load(
    'en',
    new Map(),
    [
      { url: 'https://maka.example.test/other/', focus: async () => {}, postMessage: outside },
      {
        url: 'https://maka.example.test/app/tasks/one',
        focus: async () => {},
        postMessage: inside,
      },
    ],
    'https://maka.example.test/app/',
  );
  await worker.click('/app/?task=one');
  expect(outside).not.toHaveBeenCalled();
  expect(inside).toHaveBeenCalledOnce();
  expect(worker.opened).toEqual([]);
});
