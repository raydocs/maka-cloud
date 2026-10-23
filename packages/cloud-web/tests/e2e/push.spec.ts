import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, control, conversationsOf, openSettings, signIn } from './support';

// One endpoint per test: the stack (and what it pushed) is shared by every test.
const device = () => `https://push.example.test/device-${crypto.randomUUID()}`;

/**
 * Stands in for the browser's push transport only: a stateful subscription with
 * real-shaped P-256 keys, so the server can encrypt for it. No push service is
 * contacted. `window.__push` exposes what the page did to it.
 */
async function stubPush(page: Page, endpoint: string) {
  await page.addInitScript((endpoint) => {
    const state = {
      endpoint,
      subscribed: false,
      unsubscribed: 0,
      key: '',
      keys: { p256dh: '', auth: '' },
    };
    (window as unknown as { __push: typeof state }).__push = state;
    Object.defineProperty(Notification, 'requestPermission', { value: async () => 'granted' });
    const subscription = {
      endpoint,
      unsubscribe: async () => {
        state.subscribed = false;
        state.unsubscribed += 1;
        return true;
      },
      toJSON: () => ({ endpoint, keys: state.keys }),
    };
    const b64 = (bytes: ArrayBuffer | Uint8Array) =>
      btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/u, '');
    Object.defineProperty(PushManager.prototype, 'getSubscription', {
      value: async () => (state.subscribed ? subscription : null),
    });
    Object.defineProperty(PushManager.prototype, 'subscribe', {
      value: async (options: { applicationServerKey: Uint8Array }) => {
        state.subscribed = true;
        state.key = b64(options.applicationServerKey);
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
          'deriveBits',
        ]);
        const p256dh = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
        const auth = b64(crypto.getRandomValues(new Uint8Array(16)));
        state.keys = { p256dh, auth };
        return subscription;
      },
    });
  }, endpoint);
}

async function pushed(request: APIRequestContext) {
  return control<{ endpoint: string; bytes: number }[]>(request, 'pushed');
}

async function finishTopLevel(
  request: APIRequestContext,
  token: string,
  conversationId: string,
  title: string,
) {
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title,
  });
  await control(request, 'progress', { taskId, note: 'Working' });
  await control(request, 'complete', { taskId });
  return taskId;
}

async function startConversation(page: Page, request: APIRequestContext, token: string) {
  await page.getByLabel('What would you like to get done?').fill('Hello');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('log')).toBeVisible();
  const [{ conversationId }] = await conversationsOf(request, token);
  // Notifications are a setting, not part of the chat.
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeVisible();
  return conversationId;
}

// The real server (push configured with a throwaway key and a fake transport).
test('enabling notifications registers this device with the server, and only its own invite is pushed', async ({
  page,
  request,
}) => {
  const endpoint = device();
  await stubPush(page, endpoint);
  const invite = await signIn(page, request);
  const conversationId = await startConversation(page, request, invite.token);
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Background notifications enabled' }),
  ).toBeVisible();
  // The browser was subscribed with the key the server published.
  const key = await request.get(`${API}/v1/push/key`, {
    headers: { authorization: `Bearer ${invite.token}` },
  });
  const { publicKey } = (await key.json()) as { publicKey: string };
  expect(
    await page.evaluate(() => (window as never as { __push: { key: string } }).__push.key),
  ).toBe(publicKey);

  // Another invite's finished task reaches no device of this one.
  const other = await control<{ token: string }>(request, 'invite');
  const created = await request.post(`${API}/v1/conversations`, {
    headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
    data: {},
  });
  const otherConversation = ((await created.json()) as { conversationId: string }).conversationId;
  await finishTopLevel(request, other.token, otherConversation, 'Not yours');

  // This invite's finished task reaches this device once. Ids only, encrypted.
  // The other invite's task ended first and the server works through the feed in order,
  // so by the time this device has its message, any message for the other task was sent.
  await finishTopLevel(request, invite.token, conversationId, 'Mine');
  const mine = () => pushed(request).then((all) => all.filter((m) => m.endpoint === endpoint));
  await expect.poll(async () => (await mine()).length).toBe(1);
  expect((await mine())[0]?.bytes).toBeGreaterThan(0);
});

test('turning notifications off removes the registration and the browser subscription', async ({
  page,
  request,
}) => {
  const endpoint = device();
  await stubPush(page, endpoint);
  const invite = await signIn(page, request);
  await startConversation(page, request, invite.token);
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await page.getByRole('button', { name: 'Turn off notifications' }).click();
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeVisible();
  await expect(page.getByText('Background notifications enabled')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as never as { __push: { unsubscribed: number } }).__push.unsubscribed,
    ),
  ).toBe(1);
  // The server no longer knows the device: removing it again is a 404.
  const again = await request.delete(`${API}/v1/push/subscriptions`, {
    headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/json' },
    data: { endpoint },
  });
  expect(again.status()).toBe(404);
});

test('a push service the server does not accept is said plainly and leaves no subscription behind', async ({
  page,
  request,
}) => {
  await stubPush(page, `https://elsewhere.example.invalid/device-${crypto.randomUUID()}`);
  const invite = await signIn(page, request);
  await startConversation(page, request, invite.token);
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByRole('alert')).toContainText('not accepted by this server');
  await expect(page.getByText('Background notifications enabled')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as never as { __push: { subscribed: boolean } }).__push.subscribed,
    ),
  ).toBe(false);
});

test('an untagged push shows a neutral root-only notification and ignores hostile content', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const worker = await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { type: 'module' });
    await navigator.serviceWorker.ready;
    return true;
  });
  expect(worker).toBe(true);
  const registered = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await page.close();
  const notification = await registered.evaluate(async () => {
    const scope = self as unknown as {
      registration: {
        showNotification: (title: string, options: NotificationOptions) => Promise<void>;
      };
      dispatchEvent(event: Event): void;
    };
    let shown: { title: string; options: NotificationOptions } | undefined;
    scope.registration.showNotification = async (title, options) => {
      shown = { title, options };
    };
    // Synthetic delivery at the real worker boundary. Deliberately hostile payload.
    const event = new Event('push');
    const promises: Promise<unknown>[] = [];
    Object.assign(event, {
      data: { json: () => ({ title: 'Claude OpenAI GPT', url: 'https://openai.com' }) },
      waitUntil: (promise: Promise<unknown>) => promises.push(promise),
    });
    scope.dispatchEvent(event);
    await Promise.all(promises);
    return shown;
  });
  expect(notification).toEqual({
    title: 'Something needs a look',
    options: {
      body: 'Open Maka to check your inbox.',
      tag: 'maka-account-mismatch',
      silent: false,
      data: { path: '/' },
    },
  });
});
