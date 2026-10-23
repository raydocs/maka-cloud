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
    url: string;
    focus: () => Promise<unknown>;
    postMessage: (data: unknown) => void;
  }> = [],
) {
  const caches = {
    open: async () => ({
      put: async (key: string, value: Response) => {
        saved.set(key, await value.text());
      },
      match: async (key: string) => (saved.has(key) ? new Response(saved.get(key)) : undefined),
    }),
  };
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const scope = {
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    registration: {
      getNotifications: async ({ tag }: { tag: string }) =>
        shown
          .filter((notice) => notice.options.tag === tag)
          .map((notice) => ({ data: notice.options.data })),
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    location: { origin: 'https://maka.example.test' },
    navigator: { languages: [language] },
    clients: {
      matchAll: async () => windows,
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
  });
  const push = async (data: unknown) => {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({
      data:
        data === undefined ? null : { json: () => (data instanceof Error ? raise(data) : data) },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
  };
  const message = async (language: string, origin = 'https://maka.example.test') => {
    const waits: Promise<unknown>[] = [];
    listeners.get('message')?.({
      source: { url: `${origin}/` },
      data: { type: 'maka.language', language },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
  };
  const click = async (path: string) => {
    const waits: Promise<unknown>[] = [];
    listeners.get('notificationclick')?.({
      notification: { close() {}, data: { path } },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
  };
  return { push, shown, message, click, opened };
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
  expect(only?.options.data).toEqual({ path: '/' });
});

test('an unknown, malformed, missing or inherited type shows the default text, never the payload', async () => {
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
    new Error('not json'),
  ]) {
    await worker.push(payload);
  }
  expect(worker.shown).toHaveLength(10);
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
  expect(worker.shown[0]?.options.data).toEqual({ path: '/?inbox=1' });
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
  expect(worker.shown.at(-1)?.options.data).toEqual({
    path: '/?conversation=chat&task=same&decision=1',
  });
});

test('existing uncontrolled clients receive in-app links without navigation or reload', async () => {
  const focus = vi.fn(async () => {});
  const postMessage = vi.fn();
  const worker = load('en', new Map(), [{ url: 'https://maka.example.test/', focus, postMessage }]);
  await worker.click('/?task=one');
  expect(focus).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledWith({ type: 'maka.open', path: '/?task=one' });
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
  expect(worker.shown).toHaveLength(5);
});
