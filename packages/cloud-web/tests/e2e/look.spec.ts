import { expect, test } from '@playwright/test';
import {
  control,
  conversationsOf,
  noHorizontalScroll,
  openSection,
  openSettings,
  signIn,
} from './support';

test('Home, Chat and Settings fit the screen, cards are frosted and code is not', async ({
  page,
  request,
}, info) => {
  const invite = await signIn(page, request);

  // Home: a first visit, the start sentence and nothing else to scroll sideways.
  await expect(page.getByRole('heading', { name: 'Make room for your next idea.' })).toBeVisible();
  await noHorizontalScroll(page);
  const frosted = await page.getByRole('region', { name: 'Start something' }).evaluate((el) => {
    const style = getComputedStyle(el);
    return { blur: style.backdropFilter, bg: style.backgroundColor };
  });
  expect(frosted.blur).toContain('blur');
  // Translucent: the alpha channel of the card's background is below 1.
  expect(frosted.bg).toMatch(/^rgba\(.*,\s*0?\.\d+\)$/u);
  await page.screenshot({ path: info.outputPath('home.png') });

  await page.getByLabel('What would you like to get done?').fill('Write the changelog');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Write the changelog');
  await noHorizontalScroll(page);

  // A finished task with a diff: the diff is read on an opaque surface.
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Changelog',
  });
  await control(request, 'artifact', {
    taskId,
    ref: 'out/changes.diff',
    content: '+added line\n-removed line\n',
  });
  await control(request, 'complete', { taskId, manifest: { artifacts: ['out/changes.diff'] } });
  await page.getByRole('button', { name: /Review changes\.diff/u }).click();
  const diff = page.locator('pre.diff-content');
  await expect(diff).toContainText('+added line');
  const solid = await diff.evaluate((el) => {
    const style = getComputedStyle(el);
    return { blur: style.backdropFilter, bg: style.backgroundColor };
  });
  expect(solid.blur === 'none' || solid.blur === '').toBe(true);
  expect(solid.bg).toMatch(/^rgb\(/u); // no alpha channel: opaque
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('chat.png') });

  // Settings: light and dark are one tap, kept after a reload.
  await openSettings(page);
  await noHorizontalScroll(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: info.outputPath('settings-dark.png') });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // The invite is not kept: a reload is a sign-out, and the chosen scheme is still there.
  await expect(page.getByLabel('Invite token')).toBeVisible();
});

test('on a phone every navigation target is large enough to tap', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'phone', 'phone only');
  await signIn(page, request);
  for (const name of ['Home', 'Chat', 'Projects', 'Settings'] as const) {
    const box = await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name, exact: true })
      .boundingBox();
    expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
  }
  await openSection(page, 'Settings');
  const toggle = await page.getByRole('button', { name: 'Light', exact: true }).boundingBox();
  expect(toggle?.height ?? 0).toBeGreaterThanOrEqual(36);
});
