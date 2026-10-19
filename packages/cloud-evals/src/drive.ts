import type { RunHandle, RunnerEvent } from '@maka-cloud/orchestrator';
import type { DriverEnd } from './types.js';

export interface RunEnd {
  end: DriverEnd;
  /** The last cumulative figure the run reported; null when it reported none. */
  costUsd: number | null;
  failureReason: string | null;
}

/** How long a cancelled run may take to close its stream once it was asked to. */
const DRAIN_MS = 2_000;

/**
 * Reads a run's events to its end, its timeout or the caller's abort, and always cancels the run
 * handle afterwards (cancel is safe after the run has ended). A usage figure the run had already
 * queued when it was cut off is still counted.
 */
export async function drive(
  handle: RunHandle,
  options: { timeoutMs: number; signal: AbortSignal; onCost?: (costUsd: number) => void },
): Promise<RunEnd> {
  let cost: number | null = null;
  const note = (usd: number) => {
    cost = usd;
    options.onCost?.(usd);
  };
  const iterator = handle.events[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<RunnerEvent>> | undefined;
  const next = () => {
    pending = iterator.next();
    pending.catch(() => undefined);
    return pending;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<'timeout' | 'cancelled'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
    onAbort = () => resolve('cancelled');
    if (options.signal.aborted) resolve('cancelled');
    else options.signal.addEventListener('abort', onAbort, { once: true });
  });

  let ended: Omit<RunEnd, 'costUsd'>;
  try {
    for (;;) {
      const step = await Promise.race([next(), stop]);
      if (step === 'timeout') {
        ended = { end: 'timeout', failureReason: 'the run exceeded its time limit' };
        break;
      }
      if (step === 'cancelled') {
        ended = { end: 'cancelled', failureReason: null };
        break;
      }
      if (step.done) {
        ended = { end: 'failed', failureReason: 'the run ended without a result' };
        break;
      }
      const event = step.value;
      if (event.type === 'usage') note(event.costUsd);
      else if (event.type === 'finished') {
        ended = { end: 'finished', failureReason: null };
        break;
      } else if (event.type === 'failed') {
        ended = { end: 'failed', failureReason: event.reason };
        break;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal.removeEventListener('abort', onAbort);
    await handle.cancel();
  }

  if (ended.end === 'timeout' || ended.end === 'cancelled') {
    // The stream closes once the run is cancelled: take any usage it still holds.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<'limit'>((resolve) => {
      drainTimer = setTimeout(() => resolve('limit'), DRAIN_MS);
    });
    try {
      for (;;) {
        const step = await Promise.race([pending ?? next(), limit]);
        if (step === 'limit' || step.done) break;
        if (step.value.type === 'usage') note(step.value.costUsd);
        next();
      }
    } catch {
      // A stream that fails while closing has nothing more to report.
    } finally {
      if (drainTimer) clearTimeout(drainTimer);
    }
  }
  return { ...ended, costUsd: cost };
}
