import { afterEach, expect, test, vi } from 'vitest';
import {
  ApiError,
  CloudClient,
  errorText,
  localizedQuotaText,
  quotaReason,
  quotaText,
  mergeViews,
} from '../src/index';
import type { ConversationState, QuotaReason, TaskView } from '../src/index';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const quota: QuotaReason = {
  scope: 'month',
  usedUsd: 4.5,
  limitUsd: 5,
  resetsAt: Date.UTC(2026, 10, 1),
  nextStep: 'wait',
};

test('quota parser rejects malformed and unrenderable values', () => {
  expect(quotaReason(quota)).toEqual(quota);
  for (const invalid of [
    null,
    {},
    { ...quota, scope: 'year' },
    { ...quota, usedUsd: -1 },
    { ...quota, limitUsd: Infinity },
    { ...quota, resetsAt: 1e100 },
  ])
    expect(quotaReason(invalid)).toBeUndefined();
});

test('typed refusal text explains scope, use, reset and next action in all languages', () => {
  expect(quotaText(quota, 'en')).toContain('Monthly spending limit: $4.50 of $5.00.');
  expect(quotaText(quota, 'en', false)).not.toContain('Wait until');
  expect(
    localizedQuotaText(
      'Daily spending limit: $1.00 of $2.00. Resets at invalid. Wait until invalid.',
      'zh-Hant',
    ),
  ).toBeUndefined();
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 23));
  expect(quotaText(quota)).toContain('请等到');
  expect(quotaText(quota, 'zh-Hant')).toContain('請等到');
  expect(quotaText(quota, 'en')).not.toContain('2026-11-01T');
  const text = errorText(new ApiError(429, 'budget_exceeded', { quota }));
  expect(localizedQuotaText(text, 'zh-Hant')).toBe(quotaText(quota, 'zh-Hant'));
  expect(
    quotaText({ ...quota, scope: 'task', resetsAt: null, nextStep: 'ask_owner' }, 'en'),
  ).toContain('Ask the workspace owner');
});

test('client reads readiness, reports later and permissions, and reads usage', async () => {
  const calls: [string, unknown][] = [];
  const readiness = { completed: ['language'], cards: [{ id: 'project', action: 'projects' }] };
  const client = new CloudClient('fake', (async (url, init) => {
    calls.push([String(url), init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json(
      String(url) === '/v1/usage' ? { limits: [quota] } : { cards: [], readiness },
    );
  }) as typeof fetch);
  expect((await client.homeReadiness()).readiness).toEqual(readiness);
  await client.setup({ dismiss: 'project' });
  await client.setup({ notificationsAllowed: true });
  expect(await client.usage()).toEqual({ limits: [quota] });
  expect(calls).toEqual([
    ['/v1/home', null],
    ['/v1/home/setup', { dismiss: 'project' }],
    ['/v1/home/setup', { notificationsAllowed: true }],
    ['/v1/usage', null],
  ]);
});

test('task refresh retains and clears the server-owned quota reason', () => {
  const task = { taskId: 't' } as TaskView;
  const state = { tasks: { t: task } } as unknown as ConversationState;
  const refreshed = mergeViews(state, [{ ...task, quota }]);
  expect(refreshed.tasks.t?.quota).toEqual(quota);
  expect(mergeViews(refreshed, [task]).tasks.t?.quota).toBeUndefined();
});

test.each(['zh-Hans', 'zh-Hant', 'en'] as const)(
  'service and historical refusals localize without amounts or expired advice (%s)',
  (language) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 23));
    const service: QuotaReason = {
      scope: 'service',
      resetsAt: Date.UTC(2026, 9, 24),
      nextStep: 'wait',
    };
    expect(quotaReason(service)).toEqual(service);
    expect(quotaReason({ ...service, usedUsd: 10, limitUsd: 100 })).toBeUndefined();
    const text = errorText(new ApiError(402, 'budget_exceeded', { quota: service }));
    vi.spyOn(Date, 'parse').mockImplementation(() => {
      throw new Error('No localized date parsing on this phone');
    });
    expect(localizedQuotaText(text, language)).toBe(quotaText(service, language));
    expect(quotaText(service, language)).not.toContain('$');
    expect(quotaText(service, language)).not.toContain('T00:00');
    vi.setSystemTime(Date.UTC(2026, 10, 2));
    const history = quotaText(quota, 'en');
    expect(history).toContain('Was limited until');
    expect(history).not.toMatch(/Wait until|Raise the limit|Ask the workspace owner/);
    expect(localizedQuotaText(history, language)).toBe(quotaText(quota, language));
    expect(localizedQuotaText(quotaText(service, 'en'), language)).toBe(
      quotaText(service, language),
    );
    expect(quotaText({ ...quota, scope: 'run', resetsAt: null }, 'en')).toContain(
      'Run spending limit',
    );
  },
);

test('reset uses the viewer timezone and language', () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Taipei';
    const text = quotaText({ ...quota, resetsAt: Date.UTC(2026, 9, 24) }, 'zh-Hant');
    expect(text).toContain('10月24日');
    expect(text).toMatch(/08:00:00/);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
