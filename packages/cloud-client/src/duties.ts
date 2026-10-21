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
