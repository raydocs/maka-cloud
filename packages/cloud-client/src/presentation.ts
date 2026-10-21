import { TERMINAL, type TaskView } from './contract';

// One presentation boundary for every untrusted string, including URLs and a11y.
const hiddenNames =
  /claude|codex|gpt|anthropic|open[\s_-]*ai|gemini|deepseek|grok|llama|mistral|qwen|google|meta\b|xai|cohere|sonnet|haiku|opus|instabox/giu;

// Control (but newline and tab), direction, zero-width and other format characters, and
// invisible letters and marks: a string from outside cannot show something other than what it is.
const hidden =
  /[\p{Cf}\p{Co}\p{Cn}\u0000-\u0008\u000B-\u001F\u007F-\u009F\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

export function displayText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(hidden, '')
    .replace(/[\u2028\u2029]/gu, '\n')
    .replace(hiddenNames, 'assistant');
}

// The text of an approval card, exactly as the server sent it, or undefined when it holds a
// hidden character. The approval binds that text word for word, so it is never normalised or
// name-filtered; the server builds it with none of those characters (T15).
export function exactText(value: string): string | undefined {
  return value.replaceAll('\n', '').search(hidden) === -1 ? value : undefined;
}

// What a value keeps only as a visible escape when it is shown to be approved.
const escaped =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}\u02BA\u02DD\u02EE\u05F4\u1CD3\u201C-\u201F\u2033\u2036\u275D\u275E\u2760\u3003\u301D-\u301F\uFF02]/gu;

// A held call's arguments as JSON with every hidden character as a `\uXXXX` escape, so the owner
// sees the value that will be used, not one with characters dropped.
export function displayJson(value: unknown): string {
  return (JSON.stringify(value) ?? '').replace(escaped, (char) =>
    char === ' '
      ? char
      : Array.from(
          { length: char.length },
          (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`,
        ).join(''),
  );
}

// The address must read as `https://host…` with no user name, backslash or space in the host part.
// This is checked on the text itself, because React Native's `URL` is a regular expression, not the
// WHATWG parser: it does not normalise, and it finds no user name in `https:host@evil.example/`.
const PLAIN_HTTPS = /^https:\/\/[^/?#@\\\s]+(?:[/?#]|$)/u;

export function publicLink(value: string | undefined): string | undefined {
  if (!value || !PLAIN_HTTPS.test(value)) return;
  try {
    const url = new URL(value);
    // Never expose a forbidden name via status bar, href, tooltip or a popup.
    const decoded = decodeURIComponent(url.href);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      displayText(decoded) !== decoded
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

export function dollars(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(value)
    : 'Not reported';
}

/** What the runner puts in front of a progress note that is the agent's own step line. */
export const STEP_PREFIX = 'step: ';

/**
 * A task's progress notes as the one updating line and the steps behind it. The step line is read
 * from what the agent records anyway; notes without the prefix (the conductor's own) still count
 * when no step was ever recorded.
 */
export function stepsOf(notes: readonly string[]): {
  current?: string;
  steps: string[];
} {
  const steps = notes.map((note) =>
    note.startsWith(STEP_PREFIX) ? note.slice(STEP_PREFIX.length) : note,
  );
  let recorded = notes.length - 1;
  while (recorded >= 0 && !notes[recorded]?.startsWith(STEP_PREFIX)) recorded -= 1;
  const current = recorded >= 0 ? steps[recorded] : steps.at(-1);
  return current === undefined ? { steps } : { current, steps };
}

const OUTCOME_MAX = 160;

/** The first sentence of a result summary, as the one-sentence outcome of a delivery card. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const end = /[.!?](?=\s|$)/u.exec(flat);
  const sentence = end && end.index >= 7 ? flat.slice(0, end.index + 1) : flat;
  if (sentence.length <= OUTCOME_MAX) return sentence;
  const cut = sentence.slice(0, OUTCOME_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : cut.length).trimEnd()}…`;
}

/** A file name said as a short caption: no extension, words not separators. */
export function captionOf(name: string): string {
  const words = name
    .replace(/\.[a-z0-9]{1,5}$/iu, '')
    .replace(/[-_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const caption = words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words;
  return caption === '' ? caption : caption[0]?.toUpperCase() + caption.slice(1);
}

export function taskLabel(task: TaskView): string {
  if (task.cancelRequested && !TERMINAL.has(task.state)) return 'Cancelling…';
  if (task.state === 'running' && task.pauseRequested) return 'Pausing…';
  return {
    queued: 'Queued',
    running: 'In progress',
    paused: 'Paused',
    succeeded: 'Finished',
    failed: 'Failed',
    cancelled: 'Cancelled',
  }[task.state];
}
