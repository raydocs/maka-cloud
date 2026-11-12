import type { MemorySpill, WorkerRecord } from './types.js';

/** Keep `worker.memory` under this many characters; older text goes to `spills`. */
export const INLINE_MEMORY_CHARS = 4_000;
export const SPILL_CHUNK_CHARS = 2_000;
export const MAX_SPILLS = 32;

export function spillMemory(
  memory: string,
  current: readonly MemorySpill[],
  at: number,
): { inline: string; spills: MemorySpill[] } {
  if (memory.length <= INLINE_MEMORY_CHARS) {
    return { inline: memory, spills: [...current] };
  }
  const overflow = memory.slice(0, memory.length - INLINE_MEMORY_CHARS);
  const inline = memory.slice(memory.length - INLINE_MEMORY_CHARS);
  const added: MemorySpill[] = [];
  for (let offset = 0; offset < overflow.length; offset += SPILL_CHUNK_CHARS) {
    added.push({
      id: `spill:${at}:${offset}`,
      at,
      text: overflow.slice(offset, offset + SPILL_CHUNK_CHARS),
    });
  }
  return { inline, spills: [...current, ...added].slice(-MAX_SPILLS) };
}

/** Chain of Recall: spilled chunks in order, then the inline window. */
export function recallMemory(worker: Pick<WorkerRecord, 'memory' | 'spills'>): string {
  const spilled = (worker.spills ?? []).map((row) => row.text).join('');
  return `${spilled}${worker.memory}`;
}
