import { createInterface } from 'node:readline';
import type { SetupIO } from './setup.js';

/**
 * The wizard's questions on the terminal, or on piped input one answer per line. A secret is read
 * without echo: while it is typed nothing reaches the screen, so a key never lands in a scrollback
 * or a recording of the session.
 */
export function terminalIO(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): SetupIO & { close(): void } {
  const lines = createInterface({ input, output, terminal: input.isTTY === true });
  let muted = false;
  // readline echoes typed characters through this method; while muted it writes nothing.
  const echo = lines as unknown as { _writeToOutput(text: string): void };
  const write = echo._writeToOutput.bind(lines);
  echo._writeToOutput = (text: string) => {
    if (!muted) write(text);
  };
  // Piped input arrives all at once: lines are queued until a question takes them.
  const queued: string[] = [];
  const waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let ended = false;
  lines.on('line', (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line);
    else queued.push(line);
  });
  lines.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) {
      next.reject(new Error('the input ended before setup was done'));
    }
  });
  return {
    ask: async (question, options = {}) => {
      output.write(question);
      muted = options.secret === true;
      try {
        const queuedLine = queued.shift();
        if (queuedLine !== undefined) return queuedLine;
        if (ended) throw new Error('the input ended before setup was done');
        return await new Promise<string>((resolve, reject) => waiting.push({ resolve, reject }));
      } finally {
        if (muted || input.isTTY !== true) output.write('\n');
        muted = false;
      }
    },
    say: (line) => {
      output.write(`${line}\n`);
    },
    close: () => lines.close(),
  };
}
