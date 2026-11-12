/**
 * Agents write task titles, failure reasons and manifests, so everything built
 * from them is shown as quoted data: one line, no control characters, bounded.
 */

/** Control, direction, zero-width and other format characters, and invisible letters and marks (T15). */
const CONTROL =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

/** Everything that reads as a double quote, so quoted text cannot seem to close its quotes (T15). */
const QUOTES =
  /["\u02BA\u02DD\u02EE\u05F4\u1CD3\u201C-\u201F\u2033\u2036\u275D\u275E\u2760\u3003\u301D-\u301F\uFF02]/gu;

export function clip(text: string, max: number): string {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** What a held call's arguments keep only as a visible `\uXXXX` escape: hidden characters, other line breaks and spaces, quote look-alikes. */
const ESCAPED =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}\u02BA\u02DD\u02EE\u05F4\u1CD3\u201C-\u201F\u2033\u2036\u275D\u275E\u2760\u3003\u301D-\u301F\uFF02]/gu;

/**
 * A held call's arguments for the owner to approve: JSON with every hidden character as a visible
 * escape (the conductor's `shownValue` rule), so nothing is dropped from what will run; then cut.
 */
export function shownJson(value: unknown, max: number): string {
  const json = (JSON.stringify(value) ?? 'null').replace(ESCAPED, (char) =>
    char === ' '
      ? char
      : Array.from(
          { length: char.length },
          (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`,
        ).join(''),
  );
  return json.length <= max ? json : `${json.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Text the owner approves, as it is: the conductor builds a card with no hidden characters (only
 * newlines), so it is kept whole. One that holds any other is flattened like any agent text.
 */
export function exactText(text: string): string {
  return text.replaceAll('\n', '').search(CONTROL) === -1 ? text : clip(text, 600);
}

/** What `quoted` puts between its quotes: one clipped line that cannot seem to close them. */
export function quotable(text: string | undefined | null, max = 80): string {
  return clip(text ?? '', max).replace(QUOTES, "'");
}

export function quoted(text: string | undefined | null, max = 80): string {
  const flat = quotable(text, max);
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
  retry_checks: (c) =>
    `${PREFIX} ${quoted(c.detail, 300)} (task ${c.taskId}). Please look at the failing checks of its pull request, fix them, and tell me what you did.`,
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
