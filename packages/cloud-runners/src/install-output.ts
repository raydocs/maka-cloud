import { scrubSecretShapes, secretFieldValueStarts } from '@maka-cloud/orchestrator';

/** How much of an install's output is kept, scrubbed, for the error that names it. */
export const INSTALL_OUTPUT_TAIL = 1_500;
/** How much raw output is kept to scrub as a whole when the tail is asked for: far more than the tail, so context is there. */
const WINDOW = 24_000;
/** The most an unfinished line is held before it is taken as it is. */
export const INSTALL_OUTPUT_HELD = 1_000_000;

const BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/u;
const END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/u;
/** The longest end marker; kept from a dropped stretch so that one cut in two by a chunk is still found. */
const MARKER_TAIL = 64;

/** What npm puts in front of each line it logs (`npm ERR! `, `npm warn `). */
const LOG_PREFIX =
  /^[ \t]*npm (?:ERR!|error|WARN|warn|notice|info|http|verb|verbose|sill|silly|timing)[ \t]+/u;

/**
 * Where the value of a secret field stands when its line ended before it did: the name was seen and
 * the value has not started, or it is a string, an array or object, or a bare word under way.
 */
type OpenValue =
  | { kind: 'start'; slashes: number }
  | { kind: 'string'; quote: string; slashes: number; run: number }
  | { kind: 'nested'; depth: number; inString: boolean; escaped: boolean }
  | { kind: 'word' };

/**
 * Reads `text` from `from` as the rest of an open value, the way the scrubber reads a value
 * (`endOfValue` in the orchestrator's secret-shapes): the index just after its end, or, when the
 * value runs on past `text`, where it stands then.
 */
function readValue(
  value: OpenValue,
  text: string,
  from: number,
): { end: number } | { open: OpenValue } {
  let state: OpenValue = { ...value };
  for (let i = from; i < text.length; i++) {
    const c = text[i] as string;
    if (state.kind === 'start') {
      if (/\s/u.test(c)) continue;
      if (state.slashes === 0 && (c === '"' || c === "'")) {
        state = { kind: 'string', quote: c, slashes: 0, run: 0 };
      } else if (state.slashes > 0 && c === '\\') {
        // The backslashes and the quote that open an escaped string.
        i += state.slashes;
        state = { kind: 'string', quote: '"', slashes: state.slashes, run: 0 };
      } else if (c === '{' || c === '[') {
        state = { kind: 'nested', depth: 1, inString: false, escaped: false };
      } else {
        state = { kind: 'word' };
        i--;
      }
    } else if (state.kind === 'string') {
      if (c === '\\') state.run++;
      else if (c === state.quote && state.run === state.slashes) return { end: i + 1 };
      else state.run = 0;
    } else if (state.kind === 'nested') {
      if (state.inString) {
        if (state.escaped) state.escaped = false;
        else if (c === '\\') state.escaped = true;
        else if (c === '"') state.inString = false;
      } else if (c === '"') state.inString = true;
      else if (c === '{' || c === '[') state.depth++;
      else if (c === '}' || c === ']') {
        state.depth--;
        if (state.depth === 0) return { end: i + 1 };
      }
    } else if (/[\s,}\]]/u.test(c)) return { end: i };
  }
  return { open: state };
}

/**
 * One line, with what is inside the value of a secret field that runs past it taken out, and the
 * value still open after it. A value that ends on the line it started on is left to the scrubber,
 * which sees the whole line.
 */
function holdBack(
  open: OpenValue | undefined,
  text: string,
): { kept: string; open: OpenValue | undefined } {
  let at = 0;
  if (open) {
    // A value that starts on the next line may come after the prefix the tool puts on every line.
    const from = open.kind === 'start' ? (LOG_PREFIX.exec(text)?.[0].length ?? 0) : 0;
    const read = readValue(open, text, from);
    if ('open' in read) return { kept: '', open: read.open };
    at = read.end;
  }
  const rest = text.slice(at);
  let ended = 0;
  for (const { start, slashes } of secretFieldValueStarts(rest)) {
    if (start < ended) continue;
    const read = readValue({ kind: 'start', slashes }, rest, start);
    if ('open' in read) {
      return {
        kept: `${rest.slice(0, start)}[secret]${rest.endsWith('\n') ? '\n' : ''}`,
        open: read.open,
      };
    }
    ended = read.end;
  }
  return { kept: rest, open: undefined };
}

/**
 * What an install printed, kept so that it can be scrubbed as a text and then cut to its tail.
 *
 * The text is scrubbed whole, from a window of the last lines (not line by line and not chunk by
 * chunk: a secret may start a line before its value, or end in the next chunk). A private key block
 * (PEM, OpenSSH, PGP) is never kept: from its BEGIN line to its END line, however much comes
 * between and however it is cut into chunks, nothing is stored, and `[secret]` stands in its place.
 * Nor is the value of a secret field that runs on past its line (`"credentials": {` and the lines
 * up to its closing brace): the window may lose the line with its name before the scrub, and a
 * line of a certificate can be longer than the window by itself.
 */
export class InstallOutput {
  private lines: string[] = [];
  private size = 0;
  private partial = '';
  private inBlock = false;
  /** The secret field's value the lines so far left open: nothing is kept until it ends. */
  private open: OpenValue | undefined;

  push(chunk: string): void {
    this.partial += chunk;
    for (;;) {
      const at = this.partial.indexOf('\n');
      if (at === -1) break;
      this.line(this.partial.slice(0, at + 1));
      this.partial = this.partial.slice(at + 1);
    }
    if (this.partial.length > INSTALL_OUTPUT_HELD) {
      if (this.inBlock) {
        // Still inside a key block with no line break in sight: drop it, keep what an end marker
        // cut in two would need.
        this.partial = this.partial.slice(-MARKER_TAIL);
        if (END.test(this.partial)) this.leaveBlock();
      } else {
        this.line(this.partial);
        this.partial = '';
      }
    }
  }

  private line(text: string): void {
    if (this.inBlock) {
      const end = END.exec(text);
      if (end) {
        this.leaveBlock();
        // A key inside a secret field's value: the rest of the line still says where the value ends.
        if (this.open) this.keep(this.release(text.slice(end.index + end[0].length)));
      }
      return;
    }
    const begin = BEGIN.exec(text);
    if (begin && !END.test(text.slice(begin.index))) {
      this.inBlock = true;
      this.keep(`${this.release(text.slice(0, begin.index))}[secret]\n`);
      return;
    }
    this.keep(this.release(text));
  }

  /** `text` as it may be kept, given the secret value left open before it. */
  private release(text: string): string {
    const held = holdBack(this.open, text);
    this.open = held.open;
    return held.kept;
  }

  private leaveBlock(): void {
    this.inBlock = false;
  }

  private keep(text: string): void {
    if (text === '') return;
    this.lines.push(text);
    this.size += text.length;
    while (this.size > WINDOW && this.lines.length > 1) {
      this.size -= (this.lines.shift() as string).length;
    }
  }

  tail(): string {
    // What is still unfinished reads as it is, unless a key block is open: that is not shown.
    const rest = this.inBlock ? '' : holdBack(this.open, this.partial).kept;
    return scrubSecretShapes(`${this.lines.join('')}${rest}`)
      .trim()
      .slice(-INSTALL_OUTPUT_TAIL);
  }
}
