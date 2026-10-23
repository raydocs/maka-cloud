import { expect, test } from '@playwright/test';
import { conversationsOf, finishedTask, signIn } from './support';

test('notification task link opens timeline and CJK text keeps autospace', async ({ page, request }) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('检查 API');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toBeVisible();
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const taskId = await finishedTask(request, conversationId, '检查 API task');
  await page.route('**/timeline', (route) => route.fulfill({ json: { timeline: {
    steps: [{ stepId: 'one', kind: 'shell', state: 'interrupted', durationMs: 123 }],
  } } }));
  await page.goto('/?conversation=' + conversationId + '&task=' + taskId);
  await page.getByLabel('Invite token').fill(invite.token);
  await page.getByRole('button', { name: 'Enter your workspace' }).click();
  const task = page.getByRole('article', { name: 'Task: 检查 API task' });
  await expect(task).toBeVisible();
  await expect(task).toContainText('May or may not have happened — check before redoing it');
  await expect(task).toContainText('123 ms');
  expect(await task.evaluate((el) => !CSS.supports('text-autospace', 'normal') || getComputedStyle(el).getPropertyValue('text-autospace') === 'normal')).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
