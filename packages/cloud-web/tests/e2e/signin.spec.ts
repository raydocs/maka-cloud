import { expect, test } from '@playwright/test';
import { control, noHorizontalScroll, openSettings } from './support';

test('a new person signs in with an emailed code, gives the invite code once, and can sign out', async ({
  page,
  request,
}, info) => {
  const address = `web-${info.project.name}-${Date.now()}@example.com`;
  const invite = await control<{ token: string }>(request, 'invite');
  const sendCode = async () => {
    await page.getByLabel('Email').fill(address);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page.getByText('Check your email')).toBeVisible();
    const { code } = await control<{ code: string }>(request, 'mail-code', { address });
    expect(code).toMatch(/^\d{6}$/u);
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  };

  await page.goto('/');
  await expect(page.getByLabel('Invite token')).toHaveCount(0);
  await noHorizontalScroll(page);
  await sendCode();
  // Nobody has this address yet: the invite code is asked for, once.
  await expect(page.getByText('Enter your invite code')).toBeVisible();
  await page.getByLabel('Invite code').fill(invite.token);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('What would you like to get done?')).toBeVisible();

  // The session is a cookie no script can read, and a reload stays signed in.
  const [cookie] = (await page.context().cookies()).filter((c) => c.name === '__Host-maka-session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  expect(await page.evaluate(() => document.cookie)).not.toContain('maka-session');
  await page.reload();
  await expect(page.getByLabel('What would you like to get done?')).toBeVisible();

  await openSettings(page);
  const devices = page.getByRole('region', { name: 'Signed-in devices' });
  await expect(devices).toContainText('this device');
  await expect(devices).toContainText('You sign in with email');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Email me a code' })).toBeVisible();
  // Signing out cleared the cookie: a reload asks to sign in again.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Email me a code' })).toBeVisible();
});
