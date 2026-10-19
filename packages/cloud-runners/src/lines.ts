/**
 * Splits streamed text into lines without ever holding more than `maxChars` of an unfinished one.
 * A line that passes the cap is dropped up to its next newline, and `onDrop` is told once for it.
 * A CLI that prints megabytes without a newline would otherwise fill the server's memory.
 */
export class LineSplitter {
  private buffer = '';
  private skipping = false;

  constructor(
    private readonly maxChars: number,
    private readonly onLine: (line: string) => void,
    private readonly onDrop: () => void,
  ) {}

  /** Characters of the unfinished line held right now. */
  get pending(): number {
    return this.buffer.length;
  }

  push(text: string): void {
    let rest = text;
    while (rest.length > 0) {
      const newline = rest.indexOf('\n');
      if (this.skipping) {
        if (newline < 0) return;
        rest = rest.slice(newline + 1);
        this.skipping = false;
        continue;
      }
      if (newline < 0) {
        this.buffer += rest;
        if (this.buffer.length > this.maxChars) this.drop();
        return;
      }
      const line = this.buffer + rest.slice(0, newline);
      this.buffer = '';
      rest = rest.slice(newline + 1);
      if (line.length > this.maxChars) this.onDrop();
      else this.onLine(line);
    }
  }

  /** The output ended: the unfinished line, if any, is a line. */
  end(): void {
    const line = this.buffer;
    this.buffer = '';
    if (!this.skipping && line.trim() !== '') this.onLine(line);
  }

  private drop(): void {
    this.buffer = '';
    this.skipping = true;
    this.onDrop();
  }
}
