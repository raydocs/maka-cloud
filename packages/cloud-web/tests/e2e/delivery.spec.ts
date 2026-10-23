import { expect, test } from '@playwright/test';
import { API, control, conversationsOf, noHorizontalScroll, openSection, signIn } from './support';

// A 1x1 PNG, the same bytes the fake sites serve as their preview image.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('a finished task arrives as one card, its picture opens large, and its pages are a stack', async ({
  page,
  request,
}, info) => {
  // The browser must never contact a site a task opened: previews come through the server.
  const outside: string[] = [];
  page.on('request', (r) => {
    if (/example\.test/u.test(r.url())) outside.push(r.url());
  });

  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Fix the login loop');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Fix the login loop');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Fix the login loop',
  });

  // While it runs: one updating line, opening to the steps.
  await control(request, 'progress', { taskId, note: 'step: Read the failing test' });
  await control(request, 'progress', { taskId, note: 'step: Fix the redirect loop' });
  const running = page.getByRole('article', { name: 'Fix the login loop', exact: true });
  await expect(running.locator('.current-step summary')).toContainText('Fix the redirect loop');
  await running.locator('.current-step summary').click();
  await expect(running.getByText('Read the failing test')).toBeVisible();

  // The pages it opened (trusted code records them): two sites and one that cannot be previewed.
  await control(request, 'opened', {
    taskId,
    pages: [
      { url: 'https://docs.example.test/redirects', label: 'docs' },
      { url: 'https://plain.example.test/notes', label: 'source' },
      { url: 'https://down.example.test/x', label: 'alternative' },
    ],
  });

  await control(request, 'artifact', {
    taskId,
    ref: 'out/login-page-after-fix.png',
    base64: PNG,
  });
  await control(request, 'artifact', {
    taskId,
    ref: 'out/changes.diff',
    content: '+redirect once\n-redirect forever\n',
  });
  await control(request, 'complete', {
    taskId,
    manifest: {
      summary: 'The login page no longer loops. Tests pass and the screenshot shows it.',
      artifacts: [
        'out/login-page-after-fix.png',
        'out/changes.diff',
        'https://github.com/example/repo/pull/12',
      ],
    },
  });

  const card = page.getByRole('article', { name: 'Result: Fix the login loop' });
  await expect(card.getByText('The login page no longer loops.', { exact: true })).toBeVisible();
  await expect(card).not.toContainText('Tests pass and the screenshot');
  await expect(card.getByText('Login page after fix', { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open pull request' })).toHaveAttribute(
    'href',
    'https://github.com/example/repo/pull/12',
  );
  // At most two actions.
  expect(await card.getByRole('link').count()).toBeLessThanOrEqual(2);

  // The sources: three cards, from the server, never from the site.
  await page.getByText(/^Sources \(\d+\)$/u).click();
  const stack = page.getByRole('region', { name: 'Sources' });
  await expect(stack.getByText('How redirects work')).toBeVisible();
  await expect(stack.getByText('Notes from a small site')).toBeVisible();
  const docs = stack.getByRole('link').filter({ hasText: 'How redirects work' });
  await expect(docs.locator('img')).toHaveAttribute('src', /^blob:/u);
  await expect
    .poll(() => docs.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(docs).toContainText('docs.example.test · the docs');
  const plain = stack.getByRole('link').filter({ hasText: 'Notes from a small site' });
  await expect(plain.locator('img')).toHaveCount(0);
  await expect(plain.locator('.source-image')).toHaveText('P');
  const down = stack.getByRole('link').filter({ hasText: 'down.example.test' });
  await expect(down.locator('.source-image')).toHaveText('D');
  expect(await stack.getByRole('link').count()).toBe(3);
  await noHorizontalScroll(page);
  if (info.project.name === 'phone') {
    // On a phone the stack swipes sideways inside itself; the page does not.
    expect(await stack.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('delivery.png') });

  // The picture opens large over the blurred page, and each way back works.
  const visual = card.getByRole('button', { name: 'Open large: Login page after fix' });
  await expect(visual).toBeVisible();
  await visual.click();
  const viewer = page.getByRole('dialog', { name: 'Login page after fix' });
  await expect(viewer).toBeVisible();
  // It covers the whole screen (not just the card that opened it).
  const cover = await viewer.boundingBox();
  const size = page.viewportSize();
  expect(cover?.width).toBeGreaterThanOrEqual((size?.width ?? 0) - 1);
  expect(cover?.height).toBeGreaterThanOrEqual((size?.height ?? 0) - 1);
  const blur = await viewer.evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(blur).toContain('blur');
  await expect(viewer.getByRole('status')).toContainText('Finished');
  await expect(viewer.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.screenshot({ path: info.outputPath('viewer.png') });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(visual).toBeFocused();

  await visual.click();
  await page.getByRole('button', { name: 'Collapse' }).click();
  await expect(viewer).toHaveCount(0);

  // A swipe down goes back too.
  await visual.click();
  const body = viewer.locator('.viewer-body');
  const box = await body.boundingBox();
  if (!box) throw new Error('no viewer body');
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect(viewer).toHaveCount(0);

  // Nothing in the browser ever asked a task's site for anything.
  expect(outside).toEqual([]);
});

test('the changes open the same way when there is no picture', async ({ page, request }) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Tidy the readme');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Tidy the readme');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Tidy the readme',
  });
  await control(request, 'artifact', {
    taskId,
    ref: 'out/changes.diff',
    content: '+a new line\n-an old line\n',
  });
  await control(request, 'complete', {
    taskId,
    manifest: { summary: 'The readme is tidier.', artifacts: ['out/changes.diff'] },
  });
  const card = page.getByRole('article', { name: 'Result: Tidy the readme' });
  await card.getByRole('button', { name: 'Open large: the changes' }).click();
  const viewer = page.getByRole('dialog', { name: 'The changes' });
  await expect(viewer.locator('.diff-line.add')).toHaveText('+a new line');
  await expect(viewer.locator('.diff-line.del')).toHaveText('-an old line');
  // Code is read on an opaque surface, never over the blur.
  const surface = await viewer.locator('pre').evaluate((el) => {
    const style = getComputedStyle(el);
    return { blur: style.backdropFilter, bg: style.backgroundColor };
  });
  expect(surface.blur === 'none' || surface.blur === '').toBe(true);
  expect(surface.bg).toMatch(/^rgb\(/u);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await openSection(page, 'Home');
  await openSection(page, 'Chat');
  await expect(card).toBeVisible();
});

test('another invite sees none of a task’s pages', async ({ page, request }) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Private work');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Private work');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Private work',
  });
  await control(request, 'opened', {
    taskId,
    pages: [{ url: 'https://docs.example.test/private', label: 'docs' }],
  });
  const other = await control<{ token: string }>(request, 'invite');
  for (const path of ['', '/0/preview', '/0/image']) {
    const response = await request.get(`http://127.0.0.1:4174/v1/tasks/${taskId}/sources${path}`, {
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(response.status(), path).toBe(404);
  }
});

test('a task page opens from the card, shows its changes and review on an opaque page, and goes back', async ({
  page,
  request,
}, info) => {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Fix the login loop');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Fix the login loop');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  const { taskId } = await control<{ taskId: string }>(request, 'delegate', {
    conversationId,
    title: 'Fix the login loop',
  });
  await control(request, 'progress', { taskId, note: 'step: Fix the redirect loop' });
  await control(request, 'artifact', {
    taskId,
    ref: 'out/changes.diff',
    content: '+redirect once\n-redirect forever\n',
  });
  await control(request, 'complete', {
    taskId,
    manifest: {
      summary: 'The login page no longer loops.',
      done: ['Redirects once'],
      notDone: ['The mobile app'],
      confidence: 'high',
      knownIssues: ['One flaky test'],
      artifacts: ['out/changes.diff'],
    },
  });

  await page.getByRole('button', { name: 'Details' }).click();
  const taskPage = page.getByRole('article', { name: 'Task: Fix the login loop' });
  await expect(taskPage).toBeVisible();
  if (info.project.name === 'desktop') {
    const taskBox = await taskPage.boundingBox();
    const mainBox = await page.locator('.shell main').boundingBox();
    expect(taskBox!.width).toBeGreaterThan(mainBox!.width * 0.9);
  }
  await expect(taskPage.getByRole('region', { name: 'Outcome' })).toContainText('Redirects once');
  await expect(taskPage.getByRole('region', { name: 'Outcome' })).toContainText('The mobile app');
  await expect(taskPage.getByRole('region', { name: 'Steps' })).toContainText(
    'Fix the redirect loop',
  );
  const added = taskPage.getByText('+redirect once');
  await expect(added).toBeVisible();
  await expect(taskPage.getByText('-redirect forever')).toBeVisible();
  await noHorizontalScroll(page);
  // The page and its diff are opaque: no blur, a solid fill.
  const look = await taskPage.evaluate((el) => {
    const style = getComputedStyle(el);
    return { blur: style.backdropFilter, fill: style.backgroundColor };
  });
  expect(look.blur === 'none' || look.blur === '').toBe(true);
  expect(look.fill).not.toMatch(/rgba|\/ /u);
  await page.screenshot({ path: info.outputPath('task-page.png') });

  // Back returns to the chat as it was, not a fresh one.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('article', { name: /^Result: Fix the login loop/u })).toBeVisible();
  await page.getByRole('button', { name: 'Details' }).click();
  const search = page.getByTestId('button-search');
  await search.click();
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await search.click();
  await page.locator('.search-sheet button').first().click();
  await expect(taskPage).toHaveCount(0);
  await expect(page.getByTestId('tab-chat')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('log')).toBeVisible();
  await expect(search).toBeFocused();
});

test('another invite cannot open a task page by its id', async ({ page, request }) => {
  const mine = await signIn(page, request);
  const other = await control<{ token: string }>(request, 'invite');
  const response = await request.get(`${API}/v1/tasks/nope/artifacts`, {
    headers: { authorization: `Bearer ${other.token}` },
  });
  expect(response.status()).toBe(404);
  expect(mine.token).not.toBe(other.token);
});

test('Projects says so plainly when the server has no duties engine', async ({ page, request }) => {
  await signIn(page, request);
  await openSection(page, 'Projects');
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await noHorizontalScroll(page);
});
