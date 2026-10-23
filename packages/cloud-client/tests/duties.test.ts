import { expect, test } from 'vitest';
import { dutyTime } from '../src/duties';

const now = Date.parse('2026-03-08T07:30:00Z');

test.each([
  ['en', 'today', 'tomorrow'],
  ['zh-Hans', '今天', '明天'],
  ['zh-Hant', '今天', '明天'],
] as const)(
  'duty times use %s and calendar days in the viewer timezone across DST',
  (lang, today, tomorrow) => {
    // Still Saturday in Los Angeles; the same instant is Sunday in Taipei.
    const at = Date.parse('2026-03-08T10:30:00Z');
    const la = dutyTime(at, lang, now, 'America/Los_Angeles');
    const taipei = dutyTime(at, lang, now, 'Asia/Taipei');
    expect(la).toContain(tomorrow);
    expect(taipei).toContain(today);
    const locale = { en: 'en-US', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' }[lang];
    expect(la).toContain(
      new Intl.DateTimeFormat(locale, {
        timeZone: 'America/Los_Angeles',
        timeStyle: 'short',
      }).format(at),
    );
    expect(taipei).toContain(
      new Intl.DateTimeFormat(locale, {
        timeZone: 'Asia/Taipei',
        timeStyle: 'short',
      }).format(at),
    );
  },
);

test('later runs include a localized date and time, including the year', () => {
  const at = Date.parse('2027-01-05T18:00:00Z');
  expect(dutyTime(at, 'zh-Hant', now, 'Asia/Taipei')).toBe(
    new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(at),
  );
});

test('the default zone is the viewer timezone', () => {
  expect(dutyTime(now, 'en', now)).toBe(
    dutyTime(now, 'en', now, Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
});
