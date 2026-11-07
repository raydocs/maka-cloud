/*
 * LoopGuard and stableJson are copied from Coworkers (https://github.com/fayazara/coworkers,
 * src/agents/guards.ts at 0d0ed021), under the MIT License:
 *
 * Copyright (c) 2026 Fayaz Ahmed
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Changed here: the private fields are plain fields, and the block message says the run stops.
 */

/** Identical consecutive calls allowed before the guard blocks the next one. */
export const MAX_IDENTICAL_CALLS = 5;

/** JSON with sorted keys, so `{a, b}` and `{b, a}` are the same call. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * Stops a model that keeps making the exact same tool call. A call that differs in any argument
 * resets the count, so polling with a changing cursor or retrying with a fix is never blocked.
 */
export class LoopGuard {
  last = '';
  count = 0;

  reset(): void {
    this.last = '';
    this.count = 0;
  }

  /** Returns a block reason once the same call repeats too often. */
  check(toolName: string, input: unknown): string | null {
    const key = `${toolName}:${stableJson(input)}`;
    this.count = key === this.last ? this.count + 1 : 1;
    this.last = key;
    if (this.count <= MAX_IDENTICAL_CALLS) return null;
    return `the same ${toolName} call ran ${MAX_IDENTICAL_CALLS} times in a row without changing anything, so the run was stopped`;
  }
}
