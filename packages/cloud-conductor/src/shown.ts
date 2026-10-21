/**
 * T15: text the owner is shown that came from outside them (a held call's arguments, the model's
 * words on a card or in a note, other people's text inside either) cannot show something other
 * than what it is. The idea is Reason Network's `defang` and `util::printable` (src/render.rs,
 * src/util.rs; MIT OR Apache-2.0); no code is taken from it.
 */

/** Control (but newline and tab), direction, zero-width and other format characters, and invisible letters and marks. */
const HIDDEN =
  /[\p{Cf}\p{Co}\p{Cn}\u0000-\u0008\u000B-\u001F\u007F-\u009F\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

/** What a value keeps only as a `\uXXXX` escape: the hidden characters, other line breaks and spaces, and double-quote look-alikes. */
const ESCAPED =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}\u02BA\u02DD\u02EE\u05F4\u1CD3\u201C-\u201F\u2033\u2036\u275D\u275E\u2760\u3003\u301D-\u301F\uFF02]/gu;

/**
 * Prose for the owner (a question, a note, an option label): control, direction and invisible
 * characters are dropped, and line and paragraph separators become plain newlines.
 */
export function printable(text: string): string {
  return text.replace(HIDDEN, '').replace(/[\u2028\u2029]/gu, '\n');
}

/**
 * A value exactly as it will be used, for the owner to approve: JSON in which every character that
 * would hide, reorder or pose as a quote or a line break is a visible `\uXXXX` escape, so
 * `JSON.parse` gives back the value and the owner sees all of it.
 */
export function shownValue(value: unknown): string {
  return (JSON.stringify(value) ?? 'undefined').replace(ESCAPED, (char) =>
    char === ' '
      ? char
      : Array.from(
          { length: char.length },
          (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`,
        ).join(''),
  );
}
