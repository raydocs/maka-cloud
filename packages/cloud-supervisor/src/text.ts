/**
 * Agents write task titles, failure reasons and manifests, so everything built
 * from them is shown as quoted data: one line, no control characters, bounded.
 */

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function clip(text: string, max: number): string {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

export function quoted(text: string | undefined | null, max = 80): string {
  const flat = clip(text ?? '', max).replace(/[“”"]/gu, "'");
  return flat === '' ? '(untitled)' : `“${flat}”`;
}

export interface MessageContext {
  taskId?: string;
  taskTitle?: string;
  detail?: string;
  count?: number;
  idleMinutes?: number;
}

const PREFIX = 'From my inbox:';

/**
 * The user message each message option posts. Built by code from ids and
 * counts; agent-written parts are quoted and clipped. The human's own words go
 * after a delimiter.
 */
const TEMPLATES: Record<string, (context: MessageContext) => string> = {
  check_stalled: (c) =>
    `${PREFIX} the task ${quoted(c.taskTitle)} (${c.taskId}) has had no progress for ${c.idleMinutes} minutes. Please check on it and either get it moving or cancel it, then tell me what you did.`,
  cancel_stalled: (c) =>
    `${PREFIX} cancel the task ${quoted(c.taskTitle)} (${c.taskId}). It has had no progress for ${c.idleMinutes} minutes.`,
  retry_differently: (c) =>
    `${PREFIX} the step ${quoted(c.taskTitle)} has failed ${c.count} times (last reason: ${quoted(c.detail, 200)}). Please try a different approach.`,
  stop_work: (c) =>
    `${PREFIX} stop working on ${quoted(c.taskTitle)}. It has failed ${c.count} times.`,
  fix_verification: (c) =>
    `${PREFIX} the independent check of ${quoted(c.taskTitle)} (${c.taskId}) did not pass: ${quoted(c.detail, 300)}. Please fix this and report again.`,
  redo_low_confidence: (c) =>
    `${PREFIX} the result of ${quoted(c.taskTitle)} (${c.taskId}) was reported with low confidence. Please redo it more carefully, or tell me exactly what is uncertain.`,
};

export function messageKeys(): string[] {
  return Object.keys(TEMPLATES);
}

export function buildMessage(key: string, context: MessageContext, humanText?: string): string {
  const template = TEMPLATES[key];
  if (!template) throw new Error(`Unknown message template ${key}`);
  const base = template(context);
  return humanText ? `${base}\n\nThe user wrote: ${JSON.stringify(humanText)}` : base;
}
