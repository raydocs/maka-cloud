import { type APIRequestContext, expect, type Locator, type Page } from '@playwright/test';

const CONTROL = 'http://127.0.0.1:4175';
export const API = 'http://127.0.0.1:4174';

/** Plays the conductor and the runners of the real server (tests/support/serve.ts). */
export async function control<T = unknown>(
  request: APIRequestContext,
  op: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await request.post(CONTROL, { data: { op, ...body } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as T;
}

/** A fresh invite per test, so tests never see each other's conversations. */
export async function signIn(page: Page, request: APIRequestContext) {
  const invite = await control<{ token: string; inviteId: string }>(request, 'invite');
  await page.goto('/');
  await page.getByLabel('Invite token').fill(invite.token);
  await page.getByRole('button', { name: 'Enter your workspace' }).click();
  return invite;
}

/** The segmented navigation at the top of every signed-in screen. */
export async function openSection(page: Page, name: 'Home' | 'Chat' | 'Projects' | 'Settings') {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name, exact: true })
    .click();
}

export async function openSettings(page: Page) {
  await openSection(page, 'Settings');
}

export async function conversationsOf(request: APIRequestContext, token: string) {
  const response = await request.get(`${API}/v1/conversations`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return ((await response.json()) as { conversations: { conversationId: string }[] }).conversations;
}

export async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** A task of the conversation that ran and finished, as the fake runner reports it. */
export async function finishedTask(
  request: APIRequestContext,
  conversationId: string,
  title: string,
  manifest: Record<string, unknown> = {},
) {
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title,
  });
  await control(request, 'progress', { taskId, note: 'Working' });
  await control(request, 'complete', { taskId, manifest });
  return taskId;
}

/** The WCAG contrast ratio between an element's text color and its own background, as the browser computed them. */
export async function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const channels = (value: string) => (value.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
    const luminance = ([r = 0, g = 0, b = 0]: number[]) => {
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const style = getComputedStyle(el);
    const a = luminance(channels(style.color));
    const b = luminance(channels(style.backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}
