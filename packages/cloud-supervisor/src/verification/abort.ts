/**
 * Rejects when `signal` aborts, even if `work` ignores it. A value that arrives
 * after that is handed to `late`, so a resource it carries can still be released.
 */
export function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      settled = true;
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) late?.(value);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        if (!settled) reject(error);
      },
    );
  });
}
