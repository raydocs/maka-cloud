import type { WorkerState } from './types.js';

/** States that mean the worker is still executing. Pause must verify a stop. */
export const PAUSE_ACTIVE: readonly WorkerState[] = ['spawning', 'running', 'waking'];

export function isPauseActive(state: WorkerState): boolean {
  return (PAUSE_ACTIVE as readonly string[]).includes(state);
}

/** Instabox / FakeSandbox machine states that mean the box is still executing. */
export function boxLooksRunning(state: string): boolean {
  return /^(running|active|starting|creating|booting)$/i.test(state.trim());
}

/** Resume never jumps back into an executing state. Only an explicit resume ends a pause. */
export function resumeState(pausedFrom: WorkerState | undefined): WorkerState {
  if (!pausedFrom || pausedFrom === 'paused' || isPauseActive(pausedFrom)) return 'sleeping';
  return pausedFrom;
}
