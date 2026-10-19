import type { TaskEvent, TaskView } from '@maka-cloud/orchestrator';

/**
 * What the public API shows of a task. The runner id names the vendor behind a
 * run, so it never leaves the server. `costUsd` comes from the view: the
 * orchestrator's `task_cost` events add up there, and it is absent until the
 * first one.
 */
export type PublicTaskView = Omit<TaskView, 'runner'>;

/** The names cloud-web hides (packages/cloud-web/src/presentation.ts); error text a runner wrote can carry them. */
const HIDDEN_NAMES =
  /claude|codex|gpt|anthropic|open[\s_-]*ai|gemini|deepseek|grok|llama|mistral|qwen|google|meta\b|xai|cohere|sonnet|haiku|opus/giu;

/** Error text as clients see it: no model or vendor names, by the rule cloud-web applies. */
export function scrubErrorText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\p{Cf}]/gu, '')
    .replace(HIDDEN_NAMES, 'assistant');
}

/**
 * An inbox item as clients see it. The supervisor builds its ask from agent-written
 * text (a failure reason, a summary), so it is scrubbed like error text.
 */
export function toPublicItem(item: unknown): unknown {
  if (typeof item !== 'object' || item === null || !('ask' in item)) return item;
  return typeof item.ask === 'string' ? { ...item, ask: scrubErrorText(item.ask) } : item;
}

export function toPublicView(view: TaskView): PublicTaskView {
  const { runner: _runner, ...rest } = view;
  return rest.failureReason === undefined
    ? rest
    : { ...rest, failureReason: scrubErrorText(rest.failureReason) };
}

/** A logged event as clients see it: without the runner id, and with error text scrubbed. */
export function toPublicEvent(event: TaskEvent): unknown {
  switch (event.type) {
    case 'task_created': {
      const { runner: _runner, ...rest } = event;
      return rest;
    }
    case 'task_failed':
    case 'task_pause_failed':
    case 'task_resume_failed':
      return { ...event, reason: scrubErrorText(event.reason) };
    default:
      return event;
  }
}
