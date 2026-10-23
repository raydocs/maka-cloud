import { quotaReason, quotaText } from './quota';
import { ApiError, Unsupported } from './client';

const ERROR_TEXT: Record<string, string> = {
  pause_unsupported: 'This task cannot be paused.',
  computer_in_control: 'Hand back computer control before resuming this task.',
  invalid_state: 'The task is not in a state where that can be done.',
  not_open: 'This question is no longer open.',
  closed: 'This question is no longer open.',
  conflict: 'A different answer was already recorded for this question.',
  unknown_option: 'That answer is not one of the options.',
  text_too_long: 'The additional context is too long.',
  artifact_too_large: 'This result is too large to show here.',
  forgotten_fact: 'That fact was forgotten and cannot be saved again.',
  invalid_fact: 'Enter a fact between 1 and 500 characters.',
  fact_limit: 'You can save up to 50 facts. Delete one before adding another.',
  stale: 'This changed while you were looking. It has been refreshed; check it before you answer.',
  already_answered: 'This was already answered.',
  question_open:
    'The conversation is still waiting for an answer to its own question. Answer that first.',
  invalid_option: 'That answer is not one of the options.',
  text_not_allowed: 'This item does not take additional context.',
  stopped: 'The inbox is restarting. Try again in a moment.',
  invalid_endpoint: 'This browser’s notification service is not accepted by this server.',
  invalid_keys: 'This browser’s notification keys were not accepted.',
  not_approved: 'You have not approved this duty yet. Decide it from Home first.',
  duty_limit: 'You can have up to 20 duties on at once. Turn one off first.',
  too_many_subscriptions: 'Notifications are already on for as many devices as are allowed.',
};

export function errorText(error: unknown): string {
  if (error instanceof Unsupported)
    return 'This action is unavailable on this server. No change was made.';
  if (error instanceof ApiError) {
    if (error.code === 'budget_exceeded' && typeof error.body === 'object' && error.body !== null) {
      const quota = quotaReason((error.body as { quota?: unknown }).quota);
      if (quota) return quotaText(quota, 'en');
    }
    if (error.status === 401) return 'Your sign-in is no longer valid. Please sign in again.';
    const known = error.code === undefined ? undefined : ERROR_TEXT[error.code];
    if (known) return known;
    if (error.status === 429) return 'Too many requests. Try again in a moment.';
    if (error.status === 404) return 'That is no longer available.';
    return `Could not complete the request (${error.status}). Try again.`;
  }
  return 'Could not complete the request. Check your connection and try again.';
}
