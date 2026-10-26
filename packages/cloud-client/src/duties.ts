import type { DutyView } from './contract';
import { dollars } from './presentation';

const TRIGGER_WORDS: Record<string, string> = {
  ci_failed_default_branch: 'When CI fails on the default branch',
  ci_failed_own_pr: 'When CI fails on its own pull request',
  issue_opened: 'When an issue is opened',
  review_comment_own_pr: 'When someone comments on its pull request',
};

export const AUTHORITY_WORDS: Record<DutyView['authority'], string> = {
  'read-only': 'Reads only',
  'open-pr': 'Opens pull requests',
  'merge-when-green': 'Merges when checks are green',
};

/** "Every 2 h", "Every 15 min", "When CI fails on the default branch": a trigger in a person's words. */
export function triggerWords(trigger: DutyView['trigger']): string {
  if (trigger.kind !== 'schedule') return TRIGGER_WORDS[trigger.kind] ?? 'When something happens';
  const minutes = trigger.everyMinutes ?? 0;
  if (minutes > 0 && minutes % 1440 === 0)
    return `Every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes > 0 && minutes % 60 === 0) return `Every ${minutes / 60} h`;
  return `Every ${minutes} min`;
}

export function budgetWords(duty: DutyView): string {
  return `Up to ${dollars(duty.runBudgetUsd)} a run, ${dollars(duty.dailyCapUsd)} a day`;
}

/** A run's calendar day and clock time in the viewer's language and local timezone. */
export function dutyTime(
  at: number,
  language: 'en' | 'zh-Hans' | 'zh-Hant',
  now = Date.now(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const locale = { en: 'en-US', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' }[language];
  // Compare calendar days in the viewer's zone, including across daylight-saving changes.
  const day = (value: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(value);
    const part = (name: string) => Number(parts.find((item) => item.type === name)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
  };
  const difference = day(at) - day(now);
  const clock = new Intl.DateTimeFormat(locale, { timeZone, timeStyle: 'short' }).format(at);
  if (difference === 0 || difference === 1) {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      difference,
      'day',
    );
    return `${relative} ${clock}`;
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}
