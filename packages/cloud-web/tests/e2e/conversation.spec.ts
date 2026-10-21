import { expect, test } from '@playwright/test';
import { control, conversationsOf, noHorizontalScroll, openSettings, signIn } from './support';

const NAMES = /Claude|Codex|GPT|Anthropic|OpenAI/i;

test('one sentence in, a watched piece of work and a reviewable result out', async ({
  page,
  request,
}) => {
  const invite = await signIn(page, request);

  // The first screen is the sentence, not an empty list of conversations.
  await page.getByLabel('What would you like to get done?').fill('Research solid-state batteries');
  await page.getByRole('button', { name: 'Start' }).click();
  const log = page.getByRole('log');
  await expect(log).toContainText('Research solid-state batteries');
  await expect(log).toContainText('Got it. I will start on that.');

  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId: root } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Write the report',
    budgetUsd: 2,
  });
  const { taskId: child } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Collect sources',
    parent: root,
  });
  await control(request, 'progress', { taskId: root, note: 'Outlining the report' });
  await control(request, 'progress', { taskId: child, note: 'Reading source 2 of 5' });
  await control(request, 'usage', { taskId: root, usd: 0.1 });
  await control(request, 'usage', { taskId: child, usd: 0.04 });

  const rootCard = page.getByRole('article', { name: 'Write the report', exact: true });
  const childCard = page.getByRole('article', { name: 'Collect sources', exact: true });
  await expect(rootCard).toContainText('Outlining the report');
  await expect(childCard).toContainText('Reading source 2 of 5');
  await expect(rootCard).toContainText('Cost so far: $0.14 of $2.00');
  await expect(page.locator('.spend')).toContainText('$0.14');

  // A decision: the recommended option comes first and the answer is recorded once.
  await control(request, 'ask', {
    conversationId,
    question: {
      questionId: 'q_scope',
      question: 'How wide should the search be?',
      options: [
        { id: 'broad', label: 'Everything published since 2020' },
        { id: 'narrow', label: 'Peer-reviewed papers only' },
      ],
      recommended: 'narrow',
      note: 'Narrow is faster and cheaper.',
    },
  });
  await expect(page.getByText('Needs your decision')).toBeVisible();
  await expect(page.getByRole('listbox').getByRole('option').first()).toContainText(
    'Peer-reviewed papers only',
  );
  await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('Recommended');
  await page.getByLabel('Additional context (optional)').fill('Keep it short.');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByText('Answer recorded: Peer-reviewed papers only')).toBeVisible();
  await expect(page.getByText('Needs your decision')).toHaveCount(0);
  expect(await control<unknown[]>(request, 'answers')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        questionId: 'q_scope',
        optionId: 'narrow',
        text: 'Keep it short.',
      }),
    ]),
  );

  // Pause and resume go to the server; the label changes when the stream says so.
  await rootCard.getByRole('button', { name: 'Pause task' }).click();
  await expect(rootCard.getByText('Paused', { exact: true })).toBeVisible();
  await expect(page.getByText('1 running')).toBeVisible();
  await rootCard.getByRole('button', { name: 'Resume task' }).click();
  await expect(rootCard.getByText('In progress', { exact: true })).toBeVisible();

  // The result: a file is read as inert text, a link opens as a link.
  await control(request, 'artifact', {
    taskId: root,
    ref: 'out/report.md',
    content: '# Findings\n\nSolid-state cells <script>alert(1)</script> are close.',
  });
  await control(request, 'complete', {
    taskId: child,
  });
  await control(request, 'complete', {
    taskId: root,
    manifest: { artifacts: ['out/report.md', 'https://github.com/example/repo/pull/7'] },
  });
  await expect(rootCard.getByText('Finished', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review report.md' }).click();
  await expect(page.locator('.report-content')).toContainText(
    'Solid-state cells <script>alert(1)</script> are close.',
  );
  await expect(page.getByRole('link', { name: 'Open pull request' })).toHaveAttribute(
    'href',
    'https://github.com/example/repo/pull/7',
  );
  expect(await page.locator('body').innerText()).not.toMatch(NAMES);
  await noHorizontalScroll(page);
});

test('cancel stops the whole tree and is shown only when the server says so', async ({
  page,
  request,
}) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Do a long job');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('log')).toContainText('Got it');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId: root } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Long job',
  });
  await control(request, 'delegate', { conversationId, title: 'Part of it', parent: root });
  const rootCard = page.getByRole('article', { name: 'Long job', exact: true });
  await rootCard.getByRole('button', { name: 'Cancel task' }).click();
  await expect(rootCard.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('article', { name: 'Part of it', exact: true })
      .getByText('Cancelled', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
});

test('a revoked invite ends the session at once and keeps nothing', async ({ page, request }) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Something private');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('log')).toContainText('Something private');
  await control(request, 'revoke', { inviteId: invite.inviteId });
  await expect(page.getByLabel('Invite token')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('no longer valid');
  await expect(page.getByText('Something private')).toHaveCount(0);
});

test('another invite starts from a clean slate and never sees the first one’s work', async ({
  page,
  request,
}) => {
  const first = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('First owner’s secret plan');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('log')).toContainText('secret plan');
  expect(await conversationsOf(request, first.token)).toHaveLength(1);
  await openSettings(page);
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await signIn(page, request);
  await expect(page.getByLabel('What would you like to get done?')).toBeVisible();
  await expect(page.getByText('secret plan')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Recent conversations' })).toHaveCount(0);
});

test('a runner’s failure text and names are never shown', async ({ page, request }) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Try something risky');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('log')).toContainText('Got it');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Doomed',
  });
  await control(request, 'fail', {
    taskId,
    reason: 'Claude Code crashed while OpenAI gpt-5 answered',
  });
  await control(request, 'notice', { conversationId, text: 'Codex and Anthropic were mentioned' });
  const card = page.getByRole('article', { name: 'Doomed', exact: true });
  await expect(card.getByText('Failed', { exact: true })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('assistant and assistant were mentioned');
  expect(await page.locator('body').innerText()).not.toMatch(NAMES);
  expect(await page.locator('body').ariaSnapshot()).not.toMatch(NAMES);
  await noHorizontalScroll(page);
});
