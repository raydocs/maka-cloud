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
  // An action sentence: "[Review] Weekly report", the outcome, and whether it was checked.
  await expect(waiting.getByRole('button', { name: 'Review: Weekly report' })).toHaveText('Review');
  expect(await waiting.getByRole('heading', { level: 3 }).innerText()).toContain('Weekly report');
  await expect(waiting.getByText('The weekly report is ready. Sales are up.')).toBeVisible();
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

test('the mode picker sits on the start card and in the chat, fits the screen, and a pick is sent with the message', async ({
  page,
  request,
}, info) => {
  await signIn(page, request);
  // Folded into one chip that names the choice; it opens to the four.
  const chip = page.locator('.start .mode-menu > summary');
  await expect(chip).toHaveText(/Let it decide/u);
  await chip.click();
  const startPicker = page.getByRole('group', { name: 'How much care this needs' });
  await expect(startPicker).toBeVisible();
  await expect(startPicker.getByLabel('Let it decide')).toBeChecked();
  await noHorizontalScroll(page);
  // Each choice is a row tall enough for a thumb, with a line on what it means.
  for (const label of ['Let it decide', 'Quick', 'Standard', 'Deep']) {
    const row = startPicker.locator('.mode-option').filter({ hasText: label });
    expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
  }
  await startPicker.getByLabel('Deep').check();
  await expect(startPicker).toBeHidden();
  await expect(chip).toHaveText(/Deep/u);
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/v1\/conversations\/[^/]+\/messages$/u.test(r.url()),
  );
  await page.getByLabel('What would you like to get done?').fill('Weekly report');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  expect((await sent).postDataJSON()).toMatchObject({ text: 'Weekly report', mode: 'deep' });

  // In the chat the picker starts from "Let it decide" again, and sends no mode until one is picked.
  await expect(page.getByRole('log')).toContainText('Weekly report');
  await expect(page.locator('.composer .mode-menu > summary')).toHaveText(/Let it decide/u);
  await noHorizontalScroll(page);
  const next = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/v1\/conversations\/[^/]+\/messages$/u.test(r.url()),
  );
  await page.getByLabel('Keep the conversation going').fill('And the month before');
  await page.getByRole('button', { name: 'Send message' }).click();
  expect(Object.keys((await next).postDataJSON()).sort()).toEqual(['clientMessageId', 'text']);
  await page.screenshot({ path: info.outputPath('modes.png') });
});
