import { expect, test } from '@playwright/test';
import { control, conversationsOf, finishedTask, noHorizontalScroll } from './support';

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

test.describe('Chinese Home layout', () => {
  test.use({ locale: 'zh-CN' });

  test('decisions lead, scheduled work goes last on phones, and unspaced titles fit', async ({
    page,
    request,
  }, info) => {
    await page.route('**/v1/projects', (route) =>
      route.fulfill({
        json: {
          projects: [
            {
              projectId: 'layout-project',
              repo: 'acme/widgets',
              defaultBranch: 'main',
              duties: [
                {
                  dutyId: 'layout-duty',
                  name: 'Nightly check',
                  trigger: { kind: 'schedule', everyMinutes: 60 },
                  authority: 'open-pr',
                  runBudgetUsd: 2,
                  dailyCapUsd: 5,
                  state: 'active',
                  activatedAt: Date.now(),
                  offReason: null,
                  consecutiveFailures: 0,
                },
              ],
            },
          ],
        },
      }),
    );
    const invite = await control<{ token: string }>(request, 'invite');
    await page.goto('/');
    await page.getByLabel('邀请令牌').fill(invite.token);
    await page.getByRole('button', { name: '进入工作区' }).click();
    await page.getByPlaceholder('想完成什么？').fill('Layout test');
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('Layout test');
    const [{ conversationId }] = await conversationsOf(request, invite.token);
    await finishedTask(request, conversationId, 'Weekly report');
    await control(request, 'suggest', {
      choice: {
        lineage: `layout_${info.project.name}:fix_main_ci:main`,
        conversationId,
        cardId: `layout_${info.project.name}`,
        title: '修复主分支上持续失败的测试并检查所有相关改动确保发布顺利完成',
        facts: {
          kind: 'fix_main_ci',
          mode: 'standard',
          estimateUsd: 3,
          typical: false,
          repo: 'acme/widgets',
          external: false,
        },
      },
    });
    await page.getByRole('navigation').getByRole('button', { name: '首页', exact: true }).click();
    const waiting = page.getByRole('region', { name: '待你处理的决定' });
    await expect(waiting).toBeVisible();
    const next = page.getByRole('region', { name: '即将运行' });
    await expect(next).toBeVisible();
    const regions = await page
      .getByRole('region')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    expect(regions.indexOf('待你处理的决定')).toBeLessThan(regions.indexOf('开始新任务'));
    expect(
      await waiting.locator('h2').evaluate((el) => getComputedStyle(el, '::before').content),
    ).not.toBe('none');
    if (info.project.name === 'phone') {
      expect(await next.evaluate((el) => getComputedStyle(el).order)).toBe('1');
      const boxes = await page
        .locator('.home .section-card')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      expect((await next.boundingBox())?.y).toBe(Math.max(...boxes));
    }
    const chip = page.locator('.suggestion .verb-chip');
    await expect(chip).toBeVisible();
    const cardBox = await page.locator('.suggestion').boundingBox();
    const chipBox = await chip.boundingBox();
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: info.outputPath('home-layout-zh.png'), fullPage: true });
    await noHorizontalScroll(page);
  });
});
