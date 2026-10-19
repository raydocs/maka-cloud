import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__mock/reset');
});

test('conversation, decisions, task controls, artifacts and live completion', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'A thoughtful launch for Fieldnotes' }),
  ).toBeVisible();
  await expect(page.locator('.spend')).toContainText('$1.91');
  const options = page.getByRole('option').filter({ hasText: 'launch' });
  // The native conversation selector is not an answer option.
  await expect(page.getByRole('listbox').getByRole('option').first()).toContainText(
    'A quieter launch',
  );
  await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('Recommended');
  await page.getByRole('listbox').focus();
  await page.keyboard.press('ArrowDown');
  await page.getByLabel('Additional context (optional)').fill('Let’s keep it concise.');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('Answer recorded: A bold, announcement-led launch')).toBeVisible();
  await expect(page.getByText('Needs your decision')).toHaveCount(0);
  const task = page.getByRole('article', { name: 'Shape the landing page', exact: true });
  await task.getByRole('button', { name: 'Pause task' }).click();
  await expect(task.getByText('Paused', { exact: true })).toBeVisible();
  await expect(page.getByText('1 running')).toBeVisible();
  await task.getByRole('button', { name: 'Resume task' }).click();
  await expect(task.getByText('In progress', { exact: true })).toBeVisible();
  for (let index = 1; index <= 3; index++)
    await page.getByRole('button', { name: `Review result ${index}` }).click();
  await expect(
    page.getByText('Lead with the story, not a feature list.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.diff-content')).toContainText(
    '+<h1>A little space for your next idea.</h1>',
  );
  await expect(page.getByRole('link', { name: 'Open pull request' })).toHaveAttribute(
    'href',
    'https://github.com/example/fieldnotes/pull/12',
  );
  await page.getByLabel('Keep the conversation going').fill('Please also check the footer.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Please also check the footer.');
  await request.post('/__mock/finish');
  await expect(task.getByText('Finished', { exact: true })).toBeVisible();
  await page
    .getByRole('article', { name: 'Prepare the launch', exact: true })
    .getByRole('button', { name: 'Cancel task' })
    .click();
  await expect(page.getByText('0 running')).toBeVisible();
  const state = await (await request.get('/__mock/state')).json();
  const answer = state.requests.find((r: { path: string }) => r.path.endsWith('/answers'));
  expect(answer.body).toEqual({
    questionId: 'q_direction',
    optionId: 'bold',
    text: 'Let’s keep it concise.',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const status of [404, 405]) {
  test(`${status} downgrade hides cancel, pause, answers and artifact actions without success`, async ({
    page,
    request,
  }) => {
    await request.post('/__mock/overrides', {
      data: {
        'GET /v1/capabilities': status,
        'POST /v1/conversations/cnv_demo/tasks/task_launch/cancel': status,
        'POST /v1/conversations/cnv_demo/tasks/task_launch/pause': status,
        'POST /v1/conversations/cnv_demo/answers': status,
        'GET /v1/conversations/cnv_demo/artifacts': status,
        'GET /v1/push/config': status,
      },
    });
    await page.goto('/');
    const root = page.getByRole('article', { name: 'Prepare the launch', exact: true });
    await root.getByRole('button', { name: 'Cancel task' }).click();
    await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
    await expect(root.getByText('In progress', { exact: true })).toBeVisible();
    await root.getByRole('button', { name: 'Pause task' }).click();
    await expect(page.getByRole('button', { name: 'Pause task' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Send answer' }).click();
    await expect(page.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
    await expect(page.getByText(/Answer recorded/)).toHaveCount(0);
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Review result 1' }).click();
    await expect(page.getByRole('button', { name: /Review result/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Enable notifications' }).click();
    await expect(page.getByRole('button', { name: 'Enable notifications' })).toHaveCount(0);
    await expect(page.getByText('Background notifications enabled')).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('No change was made');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('resume sends Last-Event-ID and replay never duplicates messages or loses live progress', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('listbox')).toBeVisible();
  await request.post('/__mock/disconnect');
  await request.post('/__mock/emit', {
    data: {
      kind: 'conductor.notice',
      data: { conversationId: 'cnv_demo', text: 'Your brief is checked.' },
    },
  });
  await expect(page.getByRole('log')).toContainText('Your brief is checked.');
  await expect(
    page
      .getByRole('log')
      .getByText('Let’s make it feel like an invitation, not an announcement.', { exact: false }),
  ).toHaveCount(1);
  const state = await (await request.get('/__mock/state')).json();
  const streams = state.requests.filter((r: { path: string }) => r.path.startsWith('/v1/events'));
  expect(streams[1].lastEventId).toBe('16');
});

test('server-derived names are suppressed across messages, tasks, cards, artifacts, links and a11y', async ({
  page,
  request,
}) => {
  const names = 'Claude Codex GPT Anthropic OpenAI';
  await page.route('**/v1/conversations', (route) =>
    route.fulfill({
      json: { conversations: [{ conversationId: 'cnv_demo', title: names, createdAt: 0 }] },
    }),
  );
  await page.route('**/artifacts?*', (route) =>
    route.fulfill({
      json: {
        kind: 'report',
        title: names,
        content: `${names}\n<script>alert(1)</script>\n${'long'.repeat(130)}`,
        url: 'https://openai.com/private',
      },
    }),
  );
  await request.post('/__mock/emit', {
    data: { kind: 'conductor.notice', data: { conversationId: 'cnv_demo', text: names } },
  });
  await request.post('/__mock/emit', {
    data: {
      kind: 'task.event',
      data: {
        conversationId: 'cnv_demo',
        seq: 99,
        at: 0,
        event: { type: 'task_failed', taskId: 'task_page', reason: names },
      },
    },
  });
  await request.post('/__mock/emit', {
    data: {
      kind: 'conductor.question',
      data: {
        conversationId: 'cnv_demo',
        runId: 'run_demo',
        questionId: 'q_extra',
        question: names,
        reason: 'taste',
        options: [{ id: 'one', label: names }],
        recommended: 'one',
      },
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Review result 1' }).click();
  await expect(page.locator('.report-content')).toContainText(
    'assistant assistant assistant assistant assistant',
  );
  expect(await page.locator('body').innerText()).not.toMatch(/Claude|Codex|GPT|Anthropic|OpenAI/i);
  expect(await page.locator('body').ariaSnapshot()).not.toMatch(
    /Claude|Codex|GPT|Anthropic|OpenAI/i,
  );
  await expect(page.locator('a[href*="openai"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('new conversation is isolated and an unavailable message POST preserves the draft', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByRole('heading', { name: 'A fresh start' })).toBeVisible();
  await expect(page.getByRole('log')).not.toContainText('Fieldnotes');
  await page.getByLabel('Keep the conversation going').fill('A new project.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('A new project.');
  await page.getByRole('combobox').selectOption('cnv_demo');
  await request.post('/__mock/overrides', {
    data: { 'POST /v1/conversations/cnv_demo/messages': 503 },
  });
  await page.getByLabel('Keep the conversation going').fill('Keep this draft.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('(503)');
  await expect(page.getByLabel('Keep the conversation going')).toHaveValue('Keep this draft.');
});
