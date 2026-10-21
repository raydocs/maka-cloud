import { expect, test } from '@playwright/test';
import { API, control, conversationsOf, noHorizontalScroll, signIn } from './support';

type Item = { itemId: string; taskId: string; kind: string; ask: string; state: string };

async function finishedTask(
  request: Parameters<typeof control>[0],
  conversationId: string,
  title: string,
) {
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title,
  });
  await control(request, 'progress', { taskId, note: 'Working' });
  await control(request, 'complete', { taskId });
  return taskId;
}

// The real server with the real supervisor (fake runner; no verification model).
test('a finished task asks for one answer with the supervisor’s own words, then moves to Done', async ({
  page,
  request,
}) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Hello');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('log')).toBeVisible();
  const [{ conversationId }] = await conversationsOf(request, invite.token);

  await finishedTask(request, conversationId, 'Weekly report');

  const needsYou = page.getByRole('region', { name: 'Needs you' });
  await expect(needsYou.getByRole('heading', { name: /Needs you \(1\)/u })).toBeVisible({
    timeout: 20_000,
  });

  // The card shows the supervisor's sentence as sent: no vendor or model names.
  const heading = await needsYou.getByRole('heading', { level: 3 }).innerText();
  expect(heading).toContain('Weekly report');
  expect(heading).not.toMatch(/claude|openai|gpt|anthropic|gemini|codex/iu);

  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByRole('button', { name: 'Got it' })).toHaveCount(0, { timeout: 20_000 });
  await expect(needsYou.getByText('Done (1)')).toBeVisible();
  await noHorizontalScroll(page);
});

test('another invite’s finished task never shows up in this workspace', async ({
  page,
  request,
}) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Hello');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('log')).toBeVisible();

  const other = await control<{ token: string }>(request, 'invite');
  const created = await request.post(`${API}/v1/conversations`, {
    headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
    data: {},
  });
  const otherConversation = ((await created.json()) as { conversationId: string }).conversationId;
  await finishedTask(request, otherConversation, 'Not yours');

  // This invite's own finished task appears; the other's never does, and the unrelated item
  // the other invite has is not reachable by id from this token.
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  await finishedTask(request, conversationId, 'Mine');
  // Wait until the supervisor's item has arrived too, so the check below sees both headings.
  await expect(
    page.getByRole('heading', { level: 3, name: /finished/u }).filter({ hasText: 'Mine' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 3, name: 'Mine', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Not yours')).toHaveCount(0);
});
