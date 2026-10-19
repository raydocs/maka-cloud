import { expect, test } from '@playwright/test';
import { control, signIn } from './support';

async function stubPush(page: import('@playwright/test').Page) {
  // Stub only the browser push transport. No push service is contacted.
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

// Web Push is T4 PR E (#44), which is not on main: the real server answers 404 for its
// routes, so the app must say so and never claim notifications are on.
test('a server without push says so and never claims notifications are enabled', async ({
  page,
  request,
}) => {
  await stubPush(page);
  await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Hello');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByRole('alert')).toContainText('No change was made');
  await expect(page.getByText('Background notifications enabled')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toHaveCount(0);
  await expect(
    page.getByText('Background notifications are unavailable on this server.'),
  ).toBeVisible();
  void control;
});

test('the service worker shows one generic notification and ignores whatever the push carries', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const worker = await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
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
  expect(notification).toMatchObject({
    title: 'Your background task has finished',
    options: { body: 'Open Maka to review the result.', data: { path: '/' } },
  });
});
