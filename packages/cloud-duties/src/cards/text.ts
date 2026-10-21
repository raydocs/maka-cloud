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
