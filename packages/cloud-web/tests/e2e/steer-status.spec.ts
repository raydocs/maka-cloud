import { expect, test } from '@playwright/test';
import { control, conversationsOf, signIn } from './support';

test('steer, withdraw, read and opt out while a real task runs', async ({ page, request }) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Review the release');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Review the release');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Check the release',
  });
  await expect(page.getByLabel('To the running task')).toHaveValue(taskId);
  await expect(page.getByText(/Working for \d\d:\d\d/)).toBeVisible();
  const composer = page.getByLabel('Keep the conversation going');
  await composer.fill('Include the changelog');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Waiting for the next step', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Take back', exact: true }).click();
  await expect(page.getByText('Taken back', { exact: false })).toBeVisible();
  expect(await control(request, 'read-steers', { taskId })).toEqual([]);
  await composer.fill('Check links too');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Waiting for the next step', { exact: false })).toBeVisible();
  const read = await control<{ text: string }[]>(request, 'read-steers', { taskId });
  expect(read.map((message) => message.text)).toEqual(['Check links too']);
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(page.getByText('Read by the task', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take back', exact: true })).toHaveCount(0);
  await page.getByLabel('To the running task').selectOption('');
  await composer.fill('A separate request');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('A separate request');
  await page.getByLabel('Switch conversation', { exact: true }).first().click();
  await expect(
    page.locator('.composer-choices').getByRole('region', { name: 'Working', exact: true }),
  ).toContainText('Review the release');
});

test('starter ideas fill the draft and offscreen decisions have a jump chip', async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const invite = await signIn(page, request);
  await page.getByRole('button', { name: 'Plan my next project', exact: true }).click();
  await expect(page.getByLabel('What would you like to get done?')).toHaveValue(
    'Plan my next project',
  );
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Plan my next project');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  await control(request, 'ask', {
    conversationId,
    question: {
      questionId: 'offscreen',
      question: 'Choose a direction',
      options: [{ id: 'yes', label: 'Go ahead' }],
      recommended: 'yes',
    },
  });
  await expect(page.getByText('Choose a direction')).toBeAttached();
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '2000px';
    document.querySelector('[data-waiting="true"]')!.before(spacer);
    // On a wide screen the conversation scrolls in its own column, not the window.
    window.scrollTo(0, 0);
    document.querySelector('.chat-dock')?.scrollTo(0, 0);
  });
  await page.getByRole('button', { name: '1 waiting', exact: true }).click();
  await expect(page.getByText('Choose a direction')).toBeInViewport();
});

test('a running task without steering leaves the composer sending normal requests', async ({
  page,
  request,
}) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Review the build');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Review the build');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  await control(request, 'delegate', { conversationId, title: 'Build work', steerable: false });
  await expect(page.getByText('Build work', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('To the running task')).toHaveCount(0);
  await page.getByLabel('Keep the conversation going').fill('A separate request');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('A separate request');
});
