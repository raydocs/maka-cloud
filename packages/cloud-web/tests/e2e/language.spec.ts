import { expect, test } from '@playwright/test';
import { control, conversationsOf, noHorizontalScroll } from './support';

// Chinese is Simplified even for a Traditional Chinese browser outside mainland China.
test.use({ locale: 'zh-TW' });

test('Chinese Home and Chat preserve server text; Settings remembers an English override', async ({
  page,
  request,
}, info) => {
  const invite = await control<{ token: string }>(request, 'invite');
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await page.getByLabel('邀请令牌').fill(invite.token);
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('heading', { name: '给下一个想法留个位置。' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '导航' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('home-zh.png') });
  await page.getByPlaceholder('想完成什么？').fill('Keep this English message');
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByRole('log', { name: '消息' })).toContainText('Keep this English message');
  await expect(page.getByRole('log')).toContainText('Got it. I will start on that.');
  await expect(page.getByPlaceholder('接下来想做什么？')).toBeVisible();
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  await control(request, 'ask', {
    conversationId,
    question: {
      questionId: 'language-choice',
      recommended: 'approve',
      question: 'This server question stays in English.',
      options: [
        { id: 'approve', label: 'Go ahead' },
        { id: 'custom', label: 'Go ahead' },
      ],
    },
  });
  const decision = page.getByRole('region', { name: '你的决定' });
  await expect(
    decision.getByRole('heading', { name: 'This server question stays in English.' }),
  ).toBeVisible();
  await expect(decision.getByRole('button', { name: '可以执行' })).toBeVisible();
  await expect(decision.getByRole('button', { name: 'Go ahead' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('chat-zh.png') });
  await page.getByRole('navigation').getByRole('button', { name: '设置' }).click();
  await page.getByRole('group', { name: '语言' }).getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Enter your workspace' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
