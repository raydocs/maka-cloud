import { expect, test } from '@playwright/test';
import { API, control, conversationsOf, noHorizontalScroll, signIn } from './support';

test('profile facts can be saved, edited and deleted without returning after a reload', async ({
  page,
  request,
}) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Fix the parser');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Fix the parser');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  await control(request, 'say', {
    conversationId,
    text: 'Fixed the parser and ran the focused tests.',
  });
  await page.getByText('Memory', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Your memory' });
  await expect(panel.getByText('No saved facts yet.')).toBeVisible();
  await expect(
    panel.getByText('Fixed the parser and ran the focused tests.', { exact: true }),
  ).toBeVisible();
  await panel.getByLabel('Add a fact').fill('Keep pull requests focused.');
  await panel.getByRole('button', { name: 'Save fact', exact: true }).click();
  await expect(panel.getByText('Keep pull requests focused.', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await panel.getByLabel('Edit fact').fill('Include a short verification brief.');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    panel.getByText('Include a short verification brief.', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('Keep pull requests focused.', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('No task summaries yet.')).toBeVisible();
  await noHorizontalScroll(page);
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(panel.getByText('No saved facts yet.')).toBeVisible();
  await panel.getByLabel('Add a fact').fill('Include a short verification brief.');
  await panel.getByRole('button', { name: 'Save fact', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('forgotten');
  await page.reload();
  await page.getByLabel('Invite token').fill(invite.token);
  await page.getByRole('button', { name: 'Enter your workspace' }).click();
  await page.getByText('Memory', { exact: true }).click();
  await expect(panel.getByText('No saved facts yet.')).toBeVisible();
  const profile = await request.get(`${API}/v1/memory`, {
    headers: { authorization: `Bearer ${invite.token}` },
  });
  expect((await profile.json()).facts).toEqual([]);
});
