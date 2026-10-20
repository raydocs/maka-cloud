import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ComputerInput, ComputerSource } from '../../../cloud-server/dist/index.js';

/** Fixture images and an inert terminal; never opens a sandbox or executes input. */
export async function fakeComputer() {
  const base64 = (await readFile(new URL('../fixtures/desktop.png', import.meta.url))).toString(
    'base64',
  );
  const inputs: Array<{ taskId: string; input: ComputerInput }> = [];
  const disconnected = new Set<string>();
  const source: ComputerSource = {
    available: async () => true,
    async *watch(taskId, signal) {
      let position = inputs.length;
      yield { desktop: { mime: 'image/png', base64 }, terminal: 'workspace $ ready\n' };
      while (!signal.aborted && !disconnected.has(taskId)) {
        await sleep(100, undefined, { signal }).catch(() => {});
        if (signal.aborted || disconnected.has(taskId)) return;
        const recent = inputs.slice(position).filter((entry) => entry.taskId === taskId);
        position = inputs.length;
        yield {
          terminal: recent
            .map(({ input }) =>
              input.type === 'terminal'
                ? `workspace $ ${input.text}Input received (fake terminal).\n`
                : '',
            )
            .join(''),
        };
      }
    },
    async input(taskId, input, signal) {
      signal.throwIfAborted();
      inputs.push({ taskId, input });
    },
  };
  return { source, inputs, disconnected };
}
