import { scrubSecretText } from './secret-shapes.js';
import {
  PANEL_KINDS,
  PANEL_STATES,
  type PanelKind,
  type PanelState,
  type TaskEvent,
  type TaskId,
  type TaskPanel,
} from './types.js';

/** The longest narration line, in characters. */
export const MAX_NARRATION_CHARS = 160;
export const MAX_PANEL_TITLE_CHARS = 60;
export const MAX_PANEL_TAIL_LINES = 40;
export const MAX_PANEL_TAIL_BYTES = 4096;
/** Per task, how many narration lines and panel updates are kept in the log; later ones are dropped. */
export const MAX_NARRATIONS_PER_TASK = 400;
export const MAX_PANEL_UPDATES_PER_TASK = 400;

const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
// Colour and cursor codes, which a terminal shows as nothing and a reader shows as noise.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;

/**
 * What a panel's summary may say, by kind. A summary is built by the runner from a check's own
 * result (an exit status, a count, a diff), never written by a model, and the log takes nothing
 * else: free text cannot ride in it.
 */
const SUMMARIES: Record<PanelKind, RegExp> = {
  shell: /^(running|stopped|exit \d{1,3}|timed out|could not run)$/u,
  tests:
    /^(running|stopped|passed|timed out|could not run|failed|failed \(exit \d{1,3}\)|\d{1,6} passed|\d{1,6} failed|\d{1,6} passed, \d{1,6} failed)$/u,
  diff: /^(running|no changes|\d{1,5} files?|\+\d{1,7} −\d{1,7} in \d{1,5} files?)$/u,
  review: /^(running|stopped|not available|\d{1,4} P1, \d{1,4} P2, \d{1,4} P3)$/u,
  search: /^(running|stopped|\d{1,4} results?)$/u,
};

const oneLine = (text: string, max: number): string => {
  const line = text.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * A narration line as the log keeps it: one printable line without secrets, cut to size; undefined
 * when nothing is left of it.
 */
export function cleanNarration(line: unknown): string | undefined {
  if (typeof line !== 'string') return undefined;
  // Scrubbed whole before it is cut, so a key cut in two is not left half shown.
  const clean = oneLine(scrubSecretText(line), MAX_NARRATION_CHARS);
  return clean === '' ? undefined : clean;
}

/**
 * The last `MAX_PANEL_TAIL_LINES` lines of `text`, at most `MAX_PANEL_TAIL_BYTES` of them, scrubbed
 * of secrets first (the whole text, then the cut: a key cut in two is no longer one the scrubber
 * knows). The line breaks stay; control characters other than tab go.
 */
export function cleanTail(text: string): string {
  const scrubbed = scrubSecretText(text.replace(ANSI, '').replace(/\r\n?/gu, '\n'));
  const lines = scrubbed
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, (char) =>
      char === '\n' || char === '\t' ? char : ' ',
    )
    .replace(/\n+$/u, '')
    .split('\n')
    .slice(-MAX_PANEL_TAIL_LINES);
  let kept = lines.join('\n');
  if (Buffer.byteLength(kept) > MAX_PANEL_TAIL_BYTES) {
    // The last bytes, from a character boundary and a line start when there is one in reach.
    const tail = Buffer.from(kept).subarray(-MAX_PANEL_TAIL_BYTES).toString('utf8');
    const start = tail.search(/[^\u{FFFD}]/u);
    kept = tail.slice(Math.max(0, start));
    const firstBreak = kept.indexOf('\n');
    if (firstBreak >= 0 && firstBreak < kept.length - 1) kept = kept.slice(firstBreak + 1);
  }
  return kept;
}

/**
 * A panel as the log keeps it, or undefined when it is not one: the id, kind and state must be
 * exactly what is allowed, and the summary one of the fixed shapes of its kind. The title is one
 * scrubbed line; the tail is cut and scrubbed (`cleanTail`) and left out when empty.
 */
export function cleanPanel(panel: unknown): TaskPanel | undefined {
  if (typeof panel !== 'object' || panel === null) return undefined;
  const { panelId, kind, state, title, summary, tail } = panel as Record<string, unknown>;
  if (typeof panelId !== 'string' || !PANEL_ID.test(panelId)) return undefined;
  if (!PANEL_KINDS.includes(kind as PanelKind)) return undefined;
  if (!PANEL_STATES.includes(state as PanelState)) return undefined;
  if (typeof summary !== 'string' || !SUMMARIES[kind as PanelKind].test(summary)) return undefined;
  const name =
    typeof title === 'string' ? oneLine(scrubSecretText(title), MAX_PANEL_TITLE_CHARS) : '';
  if (name === '') return undefined;
  const lines = typeof tail === 'string' ? cleanTail(tail) : '';
  return {
    panelId,
    kind: kind as PanelKind,
    state: state as PanelState,
    title: name,
    summary,
    ...(lines === '' ? {} : { tail: lines }),
  };
}

/** The task event for a runner's narration or panel report, or undefined when it holds nothing usable. */
export function displayEvent(
  taskId: TaskId,
  report: { type: 'narration'; line: unknown } | { type: 'panel' },
): Extract<TaskEvent, { type: 'task_narration' | 'task_panel' }> | undefined {
  if (report.type === 'narration') {
    const line = cleanNarration(report.line);
    return line === undefined ? undefined : { type: 'task_narration', taskId, line };
  }
  const panel = cleanPanel(report);
  return panel === undefined ? undefined : { type: 'task_panel', taskId, ...panel };
}
