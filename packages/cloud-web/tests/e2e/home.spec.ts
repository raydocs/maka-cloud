import { expect, test } from '@playwright/test';
import {
  API,
  contrastOf,
  control,
  conversationsOf,
  finishedTask,
  noHorizontalScroll,
  openSection,
  signIn,
} from './support';

test('Home leads with what waits on you, answers it once, and says what was done since last time', async ({
  page,
  request,
}, info) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Weekly report');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Weekly report');
  const [{ conversationId }] = await conversationsOf(request, invite.token);

  await finishedTask(request, conversationId, 'Weekly report', {
    summary: 'The weekly report is ready. Sales are up.',
  });
  // The supervisor asks for one answer about it, and that card is on Home too.
  await openSection(page, 'Home');
  const waiting = page.getByRole('region', { name: 'Decisions waiting' });
  await expect(waiting.getByText('Waiting on you (1)')).toBeVisible({ timeout: 20_000 });
  await expect(waiting.locator('.chip.verb')).toHaveText('Review');
  expect(await waiting.getByRole('heading', { level: 3 }).innerText()).toContain('Weekly report');
  // Decisions come before the start sentence.
  const order = await page
    .getByRole('region')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(order.indexOf('Decisions waiting')).toBeLessThan(order.indexOf('Start something'));
  await noHorizontalScroll(page);

  // What was done since the last visit: the first visit shows the last day.
  const since = page.getByRole('region', { name: 'Since you were last here' });
  await expect(since.getByText('Weekly report', { exact: true })).toBeVisible();
  await expect(since.getByText('The weekly report is ready.', { exact: true })).toBeVisible();
  await expect(since.locator('.stat-tile').first()).toContainText('Done');
  await page.screenshot({ path: info.outputPath('home.png') });

  // One tap answers once: two quick taps make one answer on the server.
  const answers: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/v1\/inbox\/items\/[^/]+\/answer$/u.test(r.url()))
      answers.push(r.url());
  });
  const gotIt = waiting.getByRole('button', { name: 'Got it' });
  // The recommended answer is a filled button: its label must be readable on its fill.
  expect(await contrastOf(gotIt)).toBeGreaterThanOrEqual(4.5);
  await gotIt.dblclick();
  await expect(page.getByRole('region', { name: 'Decisions waiting' })).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(answers).toHaveLength(1);
  const items = await request.get(`${API}/v1/inbox/items?state=closed`, {
    headers: { authorization: `Bearer ${invite.token}` },
  });
  expect(((await items.json()) as { items: unknown[] }).items).toHaveLength(1);

  // Tapping a result opens the task's own page, and Back returns to Home.
  await since.getByRole('button', { name: /Weekly report/u }).click();
  await expect(page.getByRole('article', { name: 'Task: Weekly report' })).toBeVisible();
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page.getByRole('region', { name: 'Since you were last here' })).toBeVisible();
});

test('Home keeps nothing of another invite’s decisions', async ({ page, request }) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Mine');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Mine');
  const [{ conversationId }] = await conversationsOf(request, invite.token);

  const other = await control<{ token: string }>(request, 'invite');
  const created = await request.post(`${API}/v1/conversations`, {
    headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
    data: {},
  });
  const theirs = ((await created.json()) as { conversationId: string }).conversationId;
  await finishedTask(request, theirs, 'Their secret job');
  await finishedTask(request, conversationId, 'My job');

  await openSection(page, 'Home');
  const waiting = page.getByRole('region', { name: 'Decisions waiting' });
  await expect(waiting).toContainText('My job', { timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Their secret job');
});

test('a first visit has no decisions, no results and no schedule: just the start sentence', async ({
  page,
  request,
}) => {
  await signIn(page, request);
  await expect(page.getByRole('heading', { name: 'Make room for your next idea.' })).toBeVisible();
  for (const name of [
    'Decisions waiting',
    'Since you were last here',
    'What runs next',
    'Recent conversations',
  ]) {
    await expect(page.getByRole('region', { name })).toHaveCount(0);
  }
  await noHorizontalScroll(page);
});
