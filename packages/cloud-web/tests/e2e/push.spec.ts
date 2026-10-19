import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__mock/reset');
});

async function stubPush(page: import('@playwright/test').Page) {
  // Stub only the browser push transport. Registration, UI and HTTP use real code.
  // No push provider is contacted and no real key is used.
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'requestPermission', { value: async () => 'granted' });
    Object.defineProperty(PushManager.prototype, 'getSubscription', { value: async () => null });
    Object.defineProperty(PushManager.prototype, 'subscribe', {
      value: async () => ({
        toJSON: () => ({
          endpoint: 'https://push.example.invalid/local-test',
          expirationTime: null,
          keys: { auth: 'fake', p256dh: 'fake' },
        }),
        unsubscribe: async () => true,
      }),
    });
  });
}

test('registers push, then service worker handles a completion with no page open', async ({
  page,
  context,
  request,
}) => {
  await stubPush(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByText('Background notifications enabled')).toBeVisible();
  const state = await (await request.get('/__mock/state')).json();
  expect(state.subscriptions).toEqual([
    {
      endpoint: 'https://push.example.invalid/local-test',
      expirationTime: null,
      keys: { auth: 'fake', p256dh: 'fake' },
    },
  ]);
  const worker = context.serviceWorkers()[0];
  expect(worker.url()).toContain('/sw.js');
  await page.close();
  const notification = await worker.evaluate(async () => {
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
    // Synthetic delivery at the real worker boundary, not a foreground callback.
    // Deliberately hostile payload: the worker must ignore content and URLs.
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
  expect(notification).toMatchObject({
    title: 'Your background task has finished',
    options: { body: 'Open Maka to review the result.', data: { path: '/' } },
  });
});

for (const status of [404, 405, 500]) {
  test(`push registration ${status} never claims enabled`, async ({ page, request }) => {
    await stubPush(page);
    await request.post('/__mock/overrides', { data: { 'POST /v1/push/subscriptions': status } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Enable notifications' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('Background notifications enabled')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enable notifications' })).toHaveCount(
      status === 500 ? 1 : 0,
    );
    const state = await (await request.get('/__mock/state')).json();
    expect(state.subscriptions).toEqual([]);
  });
}
