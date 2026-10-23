import { expect, test } from '@playwright/test';
import { API, control, conversationsOf, finishedTask, signIn } from './support';

test('notification task link opens timeline and CJK text keeps autospace', async ({
  page,
  request,
  context,
}) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('检查 API');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toBeVisible();
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const taskId = await finishedTask(request, conversationId, '检查 API task');
  await page.route('**/timeline', (route) =>
    route.fulfill({
      json: {
        timeline: {
          steps: [{ stepId: 'one', kind: 'shell', state: 'interrupted', durationMs: 123 }],
        },
      },
    }),
  );
  await page.getByRole('textbox', { name: 'Keep the conversation going' }).fill('Unsent draft');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const me = await request.get(`${API}/v1/me`, {
    headers: { authorization: `Bearer ${invite.token}` },
  });
  const { accountTag } = (await me.json()) as { accountTag: string };
  // Real notices retain their account tag. No push subscription is needed to open one.
  await expect
    .poll(() =>
      worker.evaluate(async () => {
        const cache = await caches.open('maka-context');
        return Promise.all(
          (await cache.keys()).map(async (key) => (await (await cache.match(key))?.json())?.tag),
        );
      }),
    )
    .toContain(accountTag);
  const clickNotification = (path: string) =>
    worker.evaluate(
      async ({ path, accountTag }) => {
        const event = new Event('notificationclick');
        const waits: Promise<unknown>[] = [];
        Object.assign(event, {
          notification: { close() {}, data: { path, accountTag } },
          waitUntil: (work: Promise<unknown>) => waits.push(work),
        });
        self.dispatchEvent(event);
        await Promise.all(waits);
      },
      { path, accountTag },
    );
  await clickNotification('/?conversation=' + conversationId + '&task=' + taskId);
  await expect(page.getByLabel('Invite token')).toHaveCount(0);
  await expect(page).toHaveURL('/');
  const task = page.getByRole('article', { name: 'Task: 检查 API task' });
  await expect(task).toBeVisible();
  await expect(task).toContainText('May or may not have happened — check before redoing it');
  await expect(task).toContainText('123 ms');
  expect(
    await task.evaluate(
      (el) =>
        !CSS.supports('text-autospace', 'normal') ||
        getComputedStyle(el).getPropertyValue('text-autospace') === 'normal',
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Keep the conversation going' })).toHaveValue(
    'Unsent draft',
  );
  await control(request, 'ask', {
    conversationId,
    question: {
      questionId: 'q_notification',
      question: 'Which scope?',
      options: [{ id: 'small', label: 'Small scope' }],
      recommended: 'small',
    },
  });
  const decision = page.getByRole('region', { name: 'Your decision', exact: true });
  await expect(decision).toBeVisible();
  await clickNotification('/?conversation=' + conversationId + '&task=' + taskId + '&decision=1');
  await expect(decision).toBeFocused();
  await expect(page).toHaveURL('/');
  await expect(task).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
