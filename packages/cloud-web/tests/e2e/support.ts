import { type APIRequestContext, expect, type Page } from '@playwright/test';

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

export async function conversationsOf(request: APIRequestContext, token: string) {
  const response = await request.get(`${API}/v1/conversations`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return ((await response.json()) as { conversations: { conversationId: string }[] }).conversations;
}

export async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
