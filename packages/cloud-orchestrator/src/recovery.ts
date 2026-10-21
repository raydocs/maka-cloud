import { oneLine } from './steps.js';
import type { StepRecord, StoredEvent } from './types.js';

/** A task is given up on, for the user to look at, when this many resumes in a row got nowhere. */
export const MAX_RESUMES_IN_A_ROW = 3;

/** Longest recovery note; steps that do not fit are counted, not listed. */
export const MAX_RECOVERY_NOTE_LENGTH = 5_000;
const LISTED_STEPS = 8;
const LABEL_LENGTH = 100;

/**
 * Attempts since the task last got somewhere, the current one included. Getting somewhere is a
 * step that finished or spend recorded for the task (`costSeqs`: log positions of its `task_cost`
 * events, which live on the top-level task of its tree): a task that keeps crashing before either
 * is not worth resuming forever. A run that logs no steps and spends nothing counts every attempt.
 */
export function resumesInARow(
  log: readonly StoredEvent[],
  costSeqs: readonly number[] = [],
): number {
  let lastProgress = costSeqs.reduce((latest, seq) => Math.max(latest, seq), 0);
  for (const { seq, event } of log) {
    if (event.type === 'step_outcome' && event.status === 'done')
      lastProgress = Math.max(lastProgress, seq);
  }
  let attempts = 0;
  for (const { seq, event } of log) {
    if (event.type === 'task_attempt' && seq > lastProgress) attempts += 1;
  }
  return attempts;
}

/**
 * The first thing a resumed agent reads. Each line is a step's label as a JSON string, so text an
 * agent put in a label cannot pass for a line of this note.
 */
export function recoveryNote(steps: Iterable<StepRecord>, resumes: number): string {
  const done: StepRecord[] = [];
  const maybe: StepRecord[] = [];
  const again: StepRecord[] = [];
  for (const step of steps) {
    if (step.state === 'done') done.push(step);
    else if (step.state === 'interrupted' || step.state === 'running') {
      (step.replay === 'never' ? maybe : again).push(step);
    }
  }
  const line = (step: StepRecord) =>
    `- ${step.kind}: ${JSON.stringify(oneLine(step.label, LABEL_LENGTH))}`;
  const list = (title: string, items: StepRecord[]): string[] => {
    if (items.length === 0) return [];
    const shown = items.slice(-LISTED_STEPS);
    const hidden = items.length - shown.length;
    return ['', title, ...(hidden > 0 ? [`- ... and ${hidden} earlier`] : []), ...shown.map(line)];
  };
  const head = [
    `The server running this task restarted (resume ${resumes} in a row). You are continuing the same session; the turn you were in did not finish.`,
    ...list('Steps that finished (do not do them again):', done),
    ...list(
      'Steps that were cut off and may or may not have taken effect (a push, a pull request, a message, a payment). Check the real state first, and do not repeat them blindly:',
      maybe,
    ),
    ...list('Steps that were cut off and are safe to run again:', again),
  ].join('\n');
  const tail =
    '\n\nYour workspace files are as the machine left them; they are not transactional, so re-check the files you were editing. Before you push, open a pull request or send anything, check that it has not already been done.';
  // The closing advice always survives; a list that is too long loses its end.
  return head.length + tail.length > MAX_RECOVERY_NOTE_LENGTH
    ? `${head.slice(0, MAX_RECOVERY_NOTE_LENGTH - tail.length - 1)}…${tail}`
    : head + tail;
}
