import { scrubSecretShapes } from '@maka-cloud/orchestrator';
import { UNSAFE } from '../brief.js';

const UNSAFE_ONCE = new RegExp(UNSAFE.source, UNSAFE.flags.replace('g', ''));

/**
 * Whether `text` could be shown as it is: no control, direction, zero-width, private-use or
 * look-alike quote characters, and no space but the plain one. Text that fails is refused, not
 * repaired, so a card cannot show something other than what is stored. `newlines` allows `\n`
 * (a task brief is several lines; a title or a detail is one).
 */
export function isPrintable(text: string, newlines = false): boolean {
  const rest = text.replaceAll(' ', '');
  return !UNSAFE_ONCE.test(newlines ? rest.replaceAll('\n', '') : rest);
}

/** Every character that reads as a double quote, the plain one included. */
const QUOTE_LIKE = /["ʺ˝ˮ״᳓“-‟″‶❝❞❠〃〝-〟＂]/gu;

/**
 * Text written by someone else, as one short printable line to show the owner: unsafe characters
 * become spaces, quote look-alikes become a plain apostrophe, runs of space collapse, and it is
 * cut at `max` characters with an ellipsis. The result always passes `isPrintable`, so it can sit
 * inside a title or a detail, and it cannot hold a line break or a hidden character.
 */
export function outside(text: string, max: number): string {
  const flat = scrubSecretShapes(text)
    .replace(QUOTE_LIKE, "'")
    .replace(UNSAFE, ' ')
    .replace(/ +/gu, ' ')
    .trim();
  const chars = [...flat];
  const cut =
    chars.length <= max
      ? flat
      : `${chars
          .slice(0, Math.max(0, max - 1))
          .join('')
          .trimEnd()}…`;
  return cut === '' ? '(untitled)' : cut;
}
