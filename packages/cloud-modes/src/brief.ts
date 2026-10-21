import { isModeId, type ModeId } from './modes.js';

/**
 * The mode a task runs in travels as one line of its brief, written by code:
 *
 *     maka-mode: deep
 *
 * It sits right after the brief's leading `maka-inputs:` / `maka-artifacts:` lines, if any, so
 * those are still the very start of the brief, and nowhere else counts. A runner takes the mode
 * from this line and from nothing a model wrote in the rest of the brief.
 */
export const MODE_PREFIX = 'maka-mode:';

/** The leading lines the runners read as requests; the mode line follows them. */
const DIRECTIVES = ['maka-inputs:', 'maka-artifacts:'] as const;

const MODE_LINE_ANYWHERE = /^[\s>*+\-#]*maka-mode\s*:/imu;

export type ParsedModeBrief =
  | { ok: true; mode?: ModeId; rest: string }
  | { ok: false; reason: string };

function leading(lines: string[]): number {
  let index = 0;
  while (index < lines.length && (lines[index] as string).trim() === '') index++;
  while (index < lines.length && DIRECTIVES.some((p) => (lines[index] as string).startsWith(p))) {
    index++;
  }
  return index;
}

/**
 * Reads the mode line out of a brief and returns the brief without it. A mode line that is not
 * the one line right after the leading directives is not read: it stays in `rest` as text.
 */
export function parseModeBrief(brief: string): ParsedModeBrief {
  const lines = brief.split('\n');
  const at = leading(lines);
  const line = lines[at]?.replace(/\r$/u, '');
  if (line === undefined || !line.startsWith(MODE_PREFIX)) return { ok: true, rest: brief };
  const value = line.slice(MODE_PREFIX.length);
  if (!value.startsWith(' ') || !isModeId(value.slice(1))) {
    return { ok: false, reason: `${MODE_PREFIX} is not followed by quick, standard or deep` };
  }
  const rest = [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n');
  return { ok: true, mode: value.slice(1) as ModeId, rest };
}

/** Whether any line of text looks like a mode line, quoted or indented or not. */
export function looksLikeModeLine(text: string): boolean {
  return MODE_LINE_ANYWHERE.test(text);
}

/** The brief with its one mode line, after the leading directives. The brief must not hold one. */
export function withModeLine(brief: string, mode: ModeId): string {
  if (looksLikeModeLine(brief)) throw new Error('the brief already has a mode line');
  const lines = brief.split('\n');
  const at = leading(lines);
  lines.splice(at, 0, `${MODE_PREFIX} ${mode}`);
  return lines.join('\n');
}
