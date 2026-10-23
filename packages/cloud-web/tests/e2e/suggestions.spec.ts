import { expect, test } from '@playwright/test';
import {
  contrastOf,
  control,
  conversationsOf,
  noHorizontalScroll,
  openSection,
  signIn,
} from './support';

const facts = {
  kind: 'fix_main_ci',
  mode: 'standard',
  estimateUsd: 3,
  typical: false,
  repo: 'acme/widgets',
  detail: 'CI has failed on main since this morning.',
  external: false,
};

async function started(page: Parameters<typeof signIn>[0], request: Parameters<typeof signIn>[1]) {
  const invite = await signIn(page, request);
  await page.getByLabel('What would you like to get done?').fill('Look after widgets');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Look after widgets');
  const [{ conversationId }] = await conversationsOf(request, invite.token);
  return { invite, conversationId: conversationId as string };
}

const decisions = (request: Parameters<typeof signIn>[1]) =>
  control<Array<{ cardId: string; action: string; caller?: string }>>(
    request,
    'suggestion-decisions',
  );

test('a proposed card shows on Home with its cost, and one tap delivers one accept', async ({
  page,
  request,
}, info) => {
  const { invite, conversationId } = await started(page, request);
  await control(request, 'suggest', {
    choice: {
      lineage: 'prj_1:fix_main_ci:main',
      conversationId,
      cardId: `card_${info.project.name}_1`,
      title: 'Fix the failing test on main',
      facts,
    },
  });
  await openSection(page, 'Home');
  const region = page.getByRole('region', { name: 'Suggestions' });
  await expect(region.getByText('Noticed for you (1)')).toBeVisible({ timeout: 20_000 });
  await expect(region.getByRole('heading', { level: 3 })).toHaveText(
    'Fix the failing test on main',
  );
  await expect(region.getByText('Standard · about $3.00 · acme/widgets')).toBeVisible();
  // It is an offer, not something that needs the person.
  await expect(page.getByRole('region', { name: 'Decisions waiting' })).toHaveCount(0);
  const order = await page
    .getByRole('region')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(order.indexOf('Suggestions')).toBeGreaterThanOrEqual(0);
  if (info.project.name === 'phone')
    expect(order.indexOf('Suggestions')).toBeLessThan(order.indexOf('Start something'));
  else await expect(page.locator('.chat-dock')).toBeVisible();
  await noHorizontalScroll(page);
  const doIt = region.getByRole('button', { name: 'Do it' });
  expect(await contrastOf(doIt)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: info.outputPath('suggestion.png') });

  await doIt.dblclick();
  await expect(page.getByRole('region', { name: 'Suggestions' })).toHaveCount(0, {
    timeout: 20_000,
  });
  const delivered = await decisions(request);
  expect(delivered.filter((d) => d.cardId === `card_${info.project.name}_1`)).toEqual([
    { cardId: `card_${info.project.name}_1`, action: 'accept', caller: invite.inviteId },
  ]);
});

test('a card that moved is replaced on the screen and the old tap starts nothing', async ({
  page,
  request,
}, info) => {
  const { conversationId } = await started(page, request);
  const old = `card_${info.project.name}_old`;
  const next = `card_${info.project.name}_new`;
  await control(request, 'suggest', {
    choice: {
      lineage: 'prj_1:fix_main_ci:main2',
      conversationId,
      cardId: old,
      title: 'Fix the failing test on main',
      facts,
    },
  });
  await control(request, 'suggestion-moves', {
    cardId: old,
    next: {
      lineage: 'prj_1:fix_main_ci:main2',
      cardId: next,
      title: 'Fix the 2 failing tests on main',
      facts: { ...facts, detail: 'Two tests fail now.' },
    },
  });
  await openSection(page, 'Home');
  const region = page.getByRole('region', { name: 'Suggestions' });
  await region.getByRole('button', { name: 'Do it' }).click({ timeout: 20_000 });
  await expect(region.getByRole('heading', { level: 3 })).toHaveText(
    'Fix the 2 failing tests on main',
    { timeout: 20_000 },
  );
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await decisions(request)).filter((d) => d.cardId === old)).toEqual([]);
  // The next tap is on the fresh card.
  await region.getByRole('button', { name: 'Do it' }).click();
  await expect(page.getByRole('region', { name: 'Suggestions' })).toHaveCount(0, {
    timeout: 20_000,
  });
  expect((await decisions(request)).filter((d) => d.cardId === next)).toHaveLength(1);
  await noHorizontalScroll(page);
});

test('"Not now" dismisses once, and the offer to turn a kind off can be answered', async ({
  page,
  request,
}, info) => {
  const { conversationId } = await started(page, request);
  const card = `card_${info.project.name}_dismiss`;
  await control(request, 'suggest', {
    choice: {
      lineage: 'prj_1:fix_main_ci:main3',
      conversationId,
      cardId: card,
      title: 'Fix the failing test on main',
      facts,
    },
  });
  await control(request, 'suggest-offer', {
    offer: {
      conversationId,
      projectId: `prj_${info.project.name}`,
      kind: 'update_dependencies',
      label: 'Update vulnerable dependencies',
      repo: 'acme/widgets',
      ignored: 3,
    },
  });
  await openSection(page, 'Home');
  const region = page.getByRole('region', { name: 'Suggestions' });
  await expect(region.getByText('Noticed for you (2)')).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath('suggestion-offer.png') });
  await region.getByRole('button', { name: 'Not now' }).click();
  await expect(region.getByText('Noticed for you (1)')).toBeVisible({ timeout: 20_000 });
  await region.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('region', { name: 'Suggestions' })).toHaveCount(0, {
    timeout: 20_000,
  });
  const delivered = await decisions(request);
  expect(delivered.filter((d) => d.cardId === card)).toEqual([
    expect.objectContaining({ action: 'dismiss' }),
  ]);
  expect(delivered.some((d) => d.action === 'turn_off' && d.cardId.startsWith('offer:'))).toBe(
    true,
  );
});
