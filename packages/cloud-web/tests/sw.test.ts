import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { expect, test } from 'vitest';

type Listener = (event: unknown) => void;

/** Runs the real service worker script against a stand-in for its global scope. */
function load() {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const scope = {
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    location: { origin: 'https://maka.example.test' },
    clients: { matchAll: async () => [], openWindow: async () => undefined },
  };
  vm.runInNewContext(readFileSync(join(__dirname, '../public/sw.js'), 'utf8'), {
    self: scope,
    URL,
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
  return { push, shown };
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
    [TASK.title, TASK.body, TASK.tag],
    [SPEND.title, SPEND.body, SPEND.tag],
  ]);
  expect(worker.shown.every((n) => (n.options.data as { path: string }).path === '/')).toBe(true);
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
      TASK.title,
      TASK.body,
      TASK.tag,
    ]);
  }
});
