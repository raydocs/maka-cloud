import { expect, test } from '@playwright/test';
import { control, conversationsOf, finishedTask, noHorizontalScroll } from './support';

// A Taiwan browser uses Traditional Chinese without a saved override.
test.use({ locale: 'zh-TW' });

test('Traditional Home and Chat preserve server text; Settings remembers an English override', async ({
  page,
  request,
}, info) => {
  // This test stack has no grant ledger; exercise its optional Settings panel with an empty ledger.
  await page.route('**/v1/inbox/grants', (route) => route.fulfill({ json: { grants: [] } }));
  const invite = await control<{ token: string }>(request, 'invite');
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await page.getByLabel('邀請權杖').fill(invite.token);
  await page.getByRole('button', { name: '進入工作區' }).click();
  await expect(page.getByRole('heading', { name: '給下一個想法留個位置。' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '導航' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('home-zh.png') });
  await page.getByPlaceholder('想完成什麼？').fill('Keep this English message');
  await page.getByRole('button', { name: '開始', exact: true }).click();
  await expect(page.getByRole('log', { name: '訊息' })).toContainText('Keep this English message');
  await expect(page.getByRole('log')).toContainText('Got it. I will start on that.');
  await expect(page.getByPlaceholder('接下來想做什麼？')).toBeVisible();
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
  const decision = page.getByRole('region', { name: '你的決定' });
  await expect(
    decision.getByRole('heading', { name: 'This server question stays in English.' }),
  ).toBeVisible();
  await expect(decision.getByRole('button', { name: '可以執行' })).toBeVisible();
  await expect(decision.getByRole('button', { name: 'Go ahead' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('chat-zh.png') });
  await page.getByRole('navigation').getByRole('button', { name: '專案' }).click();
  await expect(page.getByRole('heading', { name: '專案', exact: true })).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('navigation').getByRole('button', { name: '我的' }).click();
  await page.getByText('記憶', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '已儲存的資訊' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '已記住的授權' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('settings-zh-Hant.png'), fullPage: true });
  await expect(page.getByRole('heading', { name: '我的' })).toBeVisible();
  await page.getByRole('button', { name: '繁體中文' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await page.getByLabel('邀請權杖').fill(invite.token);
  await page.getByRole('button', { name: '進入工作區' }).click();
  await page.getByRole('navigation').getByRole('button', { name: '我的' }).click();
  await page.getByRole('group', { name: '語言' }).getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Me', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Enter your workspace' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

for (const locale of ['zh-CN', 'zh-TW']) {
  test.describe(`Chinese Home layout (${locale})`, () => {
    test.use({ locale });
    const copy = (simplified: string, traditional: string) =>
      locale === 'zh-TW' ? traditional : simplified;

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
      await page.getByLabel(copy('邀请令牌', '邀請權杖')).fill(invite.token);
      await page.getByRole('button', { name: copy('进入工作区', '進入工作區') }).click();
      await page.getByPlaceholder(copy('想完成什么？', '想完成什麼？')).fill('Layout test');
      await page.getByRole('button', { name: copy('开始', '開始'), exact: true }).click();
      await expect(page.getByRole('log')).toContainText('Layout test');
      const [{ conversationId }] = await conversationsOf(request, invite.token);
      await finishedTask(request, conversationId, 'Weekly report');
      await control(request, 'suggest', {
        choice: {
          lineage: `layout_${locale}_${info.project.name}:fix_main_ci:main`,
          conversationId,
          cardId: `layout_${locale}_${info.project.name}`,
          title: '修復主分支上持續失敗的測試並檢查所有相關改動確保發布順利完成',
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
      await page
        .getByRole('navigation')
        .getByRole('button', { name: copy('首页', '首頁'), exact: true })
        .click();
      const waiting = page.getByRole('region', { name: copy('待你处理的决定', '待你處理的決定') });
      await expect(waiting).toBeVisible();
      const next = page.getByRole('region', { name: copy('即将运行', '即將執行') });
      await expect(next).toBeVisible();
      const regions = await page
        .getByRole('region')
        .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
      if (info.project.name === 'phone')
        expect(regions.indexOf(copy('待你处理的决定', '待你處理的決定'))).toBeLessThan(
          regions.indexOf(copy('开始新任务', '開始新任務')),
        );
      else {
        const pane = page.locator('.content-pane');
        const sections = await pane
          .getByRole('region')
          .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
        expect(sections.indexOf(copy('待你处理的决定', '待你處理的決定'))).toBeGreaterThanOrEqual(
          0,
        );
        expect(sections.indexOf(copy('待你处理的决定', '待你處理的決定'))).toBeLessThan(
          sections.indexOf(copy('即将运行', '即將執行')),
        );
      }
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
}
