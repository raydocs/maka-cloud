import { expect, test } from '@playwright/test';
import { control, conversationsOf, noHorizontalScroll, signIn } from './support';

test('watch, take over, type and point, reopen, then hand back; revoke clears the computer', async ({
  page,
  request,
}) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Fix the greeting');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Fix the greeting',
  });
  const task = page.getByRole('article', { name: 'Fix the greeting', exact: true });
  const viewer = task.getByRole('region', { name: 'Task computer' });
  await expect(task.getByText('Open computer', { exact: true })).toBeVisible();
  await expect(viewer).toHaveCount(0);
  await task.getByText('Open computer', { exact: true }).click();
  await expect(viewer.getByRole('status')).toHaveText('Watching · Task has control');
  await expect(viewer.getByRole('img', { name: 'Task desktop' })).toBeVisible();
  await expect(viewer.getByLabel('Live terminal output')).toContainText('workspace $ ready');
  await expect(viewer.getByLabel('Terminal input')).toBeDisabled();
  await noHorizontalScroll(page);
  await viewer.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect(viewer.getByRole('status')).toHaveText('You have control · Task paused');
  await expect(task.getByText('Paused', { exact: true })).toBeVisible();
  await task.getByRole('button', { name: 'Resume task' }).click();
  await expect(page.getByRole('alert')).toContainText('Hand back computer control');
  await expect(viewer.getByLabel('Terminal input')).toBeEnabled();
  await viewer.getByLabel('Terminal input').fill('pwd');
  await viewer.getByRole('button', { name: 'Send input' }).dblclick();
  await expect(viewer.getByLabel('Live terminal output')).toContainText('workspace $ pwd');
  const inputs = () => control<Array<{ input: unknown }>>(request, 'computer-inputs', { taskId });
  expect(await inputs()).toEqual([{ taskId, input: { type: 'terminal', text: 'pwd\n' } }]);
  const image = viewer.getByRole('img', { name: 'Task desktop' });
  await image.click({ position: { x: 20, y: 30 } });
  await expect.poll(async () => (await inputs()).length).toBe(2);
  await viewer.getByRole('application', { name: 'Desktop controls' }).press('ArrowDown');
  await expect.poll(async () => (await inputs()).length).toBe(3);
  expect((await inputs()).at(-1)?.input).toEqual({ type: 'key', key: 'ArrowDown' });
  // Hiding the viewer is not consent to resume. Reopening discovers the held control.
  await task.getByText('Open computer', { exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(task.getByText('Paused', { exact: true })).toBeVisible();
  await task.getByText('Open computer', { exact: true }).click();
  await expect(viewer.getByRole('button', { name: 'Hand back control' })).toBeEnabled();
  await viewer.getByRole('button', { name: 'Hand back control' }).click();
  await expect(viewer.getByRole('status')).toHaveText('Watching · Task has control');
  await expect(task.getByText('In progress', { exact: true })).toBeVisible();
  await expect(viewer.getByLabel('Terminal input')).toBeDisabled();
  await expect(page.getByRole('log')).toContainText('Computer control taken; task paused');
  await expect(page.getByRole('log')).toContainText('Computer control returned; task resumed');
  expect(await page.locator('body').innerText()).not.toMatch(
    /Claude|Codex|GPT|Anthropic|OpenAI|instabox/i,
  );
  await noHorizontalScroll(page);
  await control(request, 'revoke', { inviteId: invite.inviteId });
  await expect(page.getByLabel('Invite token')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Task desktop' })).toHaveCount(0);
});

test('a disconnected stream removes stale output and disables input without resuming', async ({
  page,
  request,
}) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Inspect the app');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Inspect the app',
  });
  const task = page.getByRole('article', { name: 'Inspect the app', exact: true });
  await task.getByText('Open computer', { exact: true }).click();
  await task.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect(task.getByLabel('Terminal input')).toBeEnabled();
  await control(request, 'computer-disconnect', { taskId });
  await expect(task.getByRole('alert')).toContainText('Input is disabled');
  await expect(task.getByLabel('Terminal input')).toBeDisabled();
  await expect(task.getByRole('img', { name: 'Task desktop' })).toHaveCount(0);
  await expect(task.getByText('Paused', { exact: true })).toBeVisible();
  await expect(task.getByRole('button', { name: 'Reconnect computer' })).toBeVisible();
  await noHorizontalScroll(page);
});
