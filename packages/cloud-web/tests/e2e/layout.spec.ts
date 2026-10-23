import { expect, test } from '@playwright/test';
import { control, conversationsOf, noHorizontalScroll, openSection, signIn } from './support';

test('chat stays docked beside sections on desktop; phone sections share a floating composer', async ({
  page,
  request,
}, info) => {
  await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Plan the launch');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Plan the launch');
  await openSection(page, 'Projects');
  const desktop = info.project.name === 'desktop';
  if (desktop) {
    await expect(page.getByRole('log')).toBeVisible();
    const chat = await page.locator('.chat-dock').boundingBox();
    const content = await page.locator('.content-pane').boundingBox();
    expect(chat!.x + chat!.width).toBeLessThan(content!.x);
  } else {
    await expect(page.getByRole('log')).toHaveCount(0);
    await expect(page.getByLabel('What would you like to get done?')).toBeVisible();
  }
  const composer = page.locator(desktop ? '.composer' : '.project-starter .start form');
  const box = await composer.boundingBox();
  expect(box!.y + box!.height).toBeGreaterThan(page.viewportSize()!.height - 40);
  await noHorizontalScroll(page);
  await page.getByTestId('button-search').click();
  await page.getByRole('searchbox').fill('launch');
  await page
    .getByRole('region', { name: 'Search', exact: true })
    .getByRole('button', { name: 'Plan the launch' })
    .click();
  await expect(page.getByRole('log')).toContainText('Plan the launch');
  await page.screenshot({ path: info.outputPath('panel-layout.png') });
});

test('unknown values stay absent and reduced motion stops live shimmer and insertion', async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Check the launch');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Check the launch');
  await expect(page.getByRole('region', { name: 'Task tree' })).toHaveCount(0);
  await expect(page.getByText('Not reported', { exact: true })).toHaveCount(0);
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Launch check',
  });
  await control(request, 'progress', { taskId, note: 'Checking the build' });
  const line = page.locator('.current-step summary');
  await expect(line).toContainText('Checking the build');
  expect(await line.evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe('none');
  expect(
    await page
      .locator('.message')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await expect(page.getByRole('article', { name: 'Launch check', exact: true })).not.toContainText(
    'Cost',
  );
});
