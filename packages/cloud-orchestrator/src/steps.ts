import type { ReplayClass, StepId, StepIntent } from './types.js';

/** Steps one task may log. Past it a new intent is refused, so a runaway run cannot grow the log without bound. */
export const MAX_STEPS_PER_TASK = 5_000;
export const MAX_STEP_ID_LENGTH = 200;
export const MAX_STEP_KIND_LENGTH = 40;
export const MAX_STEP_LABEL_LENGTH = 200;
export const MAX_STEP_OUTPUT_LENGTH = 4_000;

/** What a runner learns when it asks to start a step. */
export type StepIntentResult =
  /** The intent is durable. Run the step, then report its outcome. */
  | { status: 'recorded' }
  /** An earlier attempt finished this step: do not run it, use `output`. */
  | { status: 'completed'; ok: boolean; output?: string }
  /** This attempt already started it and has not reported an outcome. */
  | { status: 'running' }
  /**
   * A `never` step an earlier attempt started and did not finish: it may or may not have taken
   * effect. Check before trying again; it is not run again by itself.
   */
  | { status: 'interrupted' }
  /** Do not run the step: the task is ending, a newer attempt drives it, or it logged too many steps. */
  | { status: 'refused'; reason: string };

/**
 * The step log of one attempt, handed to its runner. A runner that wants a step to survive a crash
 * calls `intent` before the step and waits for `recorded`, then `outcome` after it. Both are
 * written under the attempt's epoch, so a runner of an older attempt can neither start nor settle
 * anything.
 */
export interface StepLog {
  intent(step: StepIntent): Promise<StepIntentResult>;
  /** `ignored`: no step of this attempt was running under that id (or the attempt is no longer current). */
  outcome(
    stepId: StepId,
    result: { status: 'done' | 'failed'; output?: string },
  ): Promise<'recorded' | 'ignored'>;
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One printable line of at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The part of an intent a runner supplies, checked and cut to size; undefined when it is not a usable step. */
export function cleanIntent(step: StepIntent): StepIntent | undefined {
  if (
    typeof step.stepId !== 'string' ||
    step.stepId === '' ||
    step.stepId.length > MAX_STEP_ID_LENGTH
  ) {
    return undefined;
  }
  if (step.replay !== 'safe' && step.replay !== 'never') return undefined;
  const kind = oneLine(String(step.kind ?? ''), MAX_STEP_KIND_LENGTH);
  if (kind === '') return undefined;
  return {
    stepId: step.stepId,
    kind,
    replay: step.replay as ReplayClass,
    label: oneLine(String(step.label ?? ''), MAX_STEP_LABEL_LENGTH),
  };
}

/** Recorded output is text of bounded size; control characters stay (a rerun reuses it as it was). */
export function clipOutput(output: string): string {
  return output.length > MAX_STEP_OUTPUT_LENGTH ? output.slice(0, MAX_STEP_OUTPUT_LENGTH) : output;
}
