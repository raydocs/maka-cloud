import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { InstaboxApiError } from '@maka-cloud/instabox';
import type { RemoteMachine } from './machine.js';
import type { Watch } from './poller.js';
import { assertSafeId, errorMessage } from './shell.js';

/**
 * A process on a sandbox that looks like a local one. The Agent SDK wants a child process whose
 * stdin it can write to and whose stdout it can read; all we have of a sandbox is `exec`, one
 * request and one answer. So:
 *
 * - The process runs detached, as every run of this package does (`launch`), and its output is read
 *   the way the CLI path reads it: the machine poller asks for the bytes after an offset.
 * - Its stdin is a file, `<run>.in`, that the process reads as it grows (`maka_feed`, below). Each
 *   write is one exec that appends to the file at the offset the host believes it is at, so a
 *   request whose answer got lost can be sent again without writing twice.
 *
 * The design is durable-harness's process channel (Apache-2.0; its file tail, not its code). The
 * terminal WebSocket of the sandbox stays free for the user's handoff (T14).
 */

/** One request carries at most this many characters, so a request stays small. */
const WRITE_CHUNK_CHARS = 65_536;
/** All the input one run may be fed. Past it, the run is told its stdin broke. */
export const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 * 1024;
const APPEND_ATTEMPTS = 3;
const APPEND_TIMEOUT_SECONDS = 30;

/**
 * Appends stdin to `<run>.in`, at most once for a given offset. `MAKA_OFFSET` is where the file must
 * end before the append; `MAKA_LEN` is the length of the payload in bytes. The payload is read
 * whole into a private file first (`SHORT <n>` and nothing written when it did not all arrive),
 * and the check of the file's size and the append are one step under a lock, so a slow original
 * and its retry cannot both append. What the file already holds from `MAKA_OFFSET` on must be a
 * prefix of the payload: all of it means an earlier try finished (nothing is written again), part
 * of it means an earlier try was cut off and the rest is appended; anything else means the host
 * and the file disagree, and nothing is written. With `MAKA_EOF` it ends the input instead: the
 * feeder stops once it has passed on everything written before the marker. Prints `OK`,
 * `MISMATCH <size>`, `SHORT <n>` or `BUSY`.
 */
export const INPUT_APPEND_SCRIPT = `set -eu
umask 077
cd "$MAKA_DIR"
f="$MAKA_RUN.in"
if [ -n "\${MAKA_EOF:-}" ]; then
  : >> "$f"
  : > "$MAKA_RUN.in.eof"
  echo OK
  exit 0
fi
part=$(mktemp "$f.part.XXXXXX")
trap 'rm -f "$part" "$part.head"' EXIT
cat > "$part"
got=$(stat -c %s "$part")
if [ "$got" -ne "$MAKA_LEN" ]; then
  echo "SHORT $got"
  exit 0
fi
exec 9> "$f.lock"
if ! flock -w 20 9; then
  echo BUSY
  exit 0
fi
size=$(stat -c %s "$f" 2>/dev/null || echo 0)
if [ "$size" -lt "$MAKA_OFFSET" ] || [ "$size" -gt $((MAKA_OFFSET + MAKA_LEN)) ]; then
  echo "MISMATCH $size"
  exit 0
fi
have=$((size - MAKA_OFFSET))
head -c "$have" "$part" > "$part.head"
if tail -c +$((MAKA_OFFSET + 1)) "$f" | head -c "$have" | cmp -s - "$part.head"; then
  tail -c +$((have + 1)) "$part" >> "$f"
  echo OK
else
  echo "MISMATCH $size"
fi
`;

/**
 * Shell function for a run script's preamble: copies `<run>.in` to its stdout as the file grows. It
 * ends when the end marker is there and everything before it has been copied (the marker is read
 * first, so the size read after it is final), or when the run script that started it is gone.
 */
export const FEED_FUNCTION = `maka_feed() {
  local f="$MAKA_DIR/$MAKA_RUN.in" eof="$MAKA_DIR/$MAKA_RUN.in.eof" off=0 size done_
  while :; do
    done_=0
    [ -e "$eof" ] && done_=1
    size=$(stat -c %s "$f" 2>/dev/null || echo 0)
    if [ "$size" -gt "$off" ]; then
      tail -c +$((off + 1)) "$f" | head -c $((size - off)) || return 0
      off=$size
    elif [ "$done_" = 1 ]; then
      return 0
    elif kill -0 "$1" 2>/dev/null; then
      sleep 0.05 2>/dev/null || sleep 1
    else
      return 0
    fi
  done
}`;

/** The command line of a run whose stdin is the input file. `args` are quoted by the caller. */
export function fedCommand(commandLine: string): string {
  return `${commandLine} < <(maka_feed $$)`;
}

/** Variables the SDK sets for the process it spawns that we pass on; everything else of its env is the host's. */
const SDK_ENV_ALLOWED = /^(CLAUDE_AGENT_SDK_[A-Z0-9_]+|CLAUDE_CODE_(ENTRYPOINT|SDK_[A-Z0-9_]+))$/u;
const SDK_ENV_FORBIDDEN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/u;
const SDK_ENV_MAX_VALUE = 200;

/**
 * The environment the SDK asks for, reduced to what may reach a sandbox. The SDK hands the spawn
 * function the host's whole environment plus its own markers; the host's variables (keys, tokens,
 * paths) must not leave the host, so only the SDK's own markers pass, and never one that looks like
 * a credential. The run's real environment (its model key, MCP token) is built by the runner.
 */
export function allowedSdkEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !SDK_ENV_ALLOWED.test(name) || SDK_ENV_FORBIDDEN.test(name))
      continue;
    if (value.length > SDK_ENV_MAX_VALUE || /[\n\r\0]/u.test(value)) continue;
    out[name] = value;
  }
  return out;
}

export interface ExecProcessOptions {
  machine: RemoteMachine;
  dirName: string;
  run: string;
  /** Starts the run on the machine, at most once (`RemoteMachine.launch`). */
  launch(): Promise<'started' | 'already' | 'cancelled'>;
  /** The poller's watch on the run's output; the process owns it and stops it when it ends. */
  watch: Watch;
  /** Each chunk of output, in order, before the process's stdout gets it. */
  onOutput?(bytes: Buffer): void;
  /** Called after every poll, whether it brought output or not. */
  onTick?(): void;
  /** Stops the run's processes on the machine. */
  stop(): Promise<void>;
  /** How long the run may stay in "starting" after it was launched. */
  startTimeoutMs: number;
  now(): number;
  maxInputBytes?: number;
}

/** A sandbox process as the SDK's `SpawnedProcess`. */
export class ExecProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** Why the channel broke (sandbox unreachable, input refused), when it did. */
  failure: Error | undefined;
  /** Resolves once the process is over, however it ended. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private resolveExited!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private done = false;
  private consumed = 0;
  private offset = 0;
  private readonly decoder = new StringDecoder('utf8');
  private readonly maxInput: number;
  private killing: Promise<void> | undefined;
  private readonly launching: Promise<'started' | 'already' | 'cancelled'>;

  constructor(private readonly options: ExecProcessOptions) {
    super();
    assertSafeId('run', options.run);
    this.maxInput = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.stdout = new Readable({ read: () => undefined });
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.write(chunk).then(
          () => callback(),
          (error) => callback(asError(error)),
        );
      },
      final: (callback) => {
        this.end().then(
          () => callback(),
          (error) => callback(asError(error)),
        );
      },
    });
    // A broken channel is reported through `failure` and the process's own events; an error event on
    // a stream nobody listens to would take the server down.
    this.stdin.on('error', () => undefined);
    this.stdout.on('error', () => undefined);
    this.launching = options.launch();
    void this.pump();
  }

  /** Bytes of input written to the run so far. */
  get inputBytes(): number {
    return this.offset;
  }

  kill(_signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.done) return false;
    this.killed = true;
    this.killing ??= this.options.stop().catch((error) => {
      this.failure ??= asError(error);
    });
    return true;
  }

  /** Resolves when the stop `kill` asked for has been carried out. */
  async stopped(): Promise<void> {
    await this.killing;
  }

  /** Lets go of the run's output without stopping the run (the runner's cleanup does that). */
  dispose(): void {
    this.finish(null, 'SIGKILL');
  }

  // -- input ------------------------------------------------------------------------------------

  private async write(chunk: Buffer): Promise<void> {
    if (this.done) throw new Error('the process has ended');
    const text = this.decoder.write(chunk);
    for (let start = 0; start < text.length; ) {
      let end = Math.min(text.length, start + WRITE_CHUNK_CHARS);
      // A pair of surrogates is one character: never cut between them.
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
      await this.send(text.slice(start, end));
      start = end;
    }
  }

  private async end(): Promise<void> {
    if (this.done) return;
    const rest = this.decoder.end();
    if (rest !== '') await this.send(rest);
    await this.exec({ MAKA_EOF: '1' }, '');
  }

  private async send(piece: string): Promise<void> {
    if (piece === '') return;
    const bytes = Buffer.byteLength(piece);
    if (this.offset + bytes > this.maxInput) {
      throw this.broken(
        new Error(`the process was sent more than ${this.maxInput} bytes of input`),
      );
    }
    const answer = await this.exec(
      { MAKA_OFFSET: String(this.offset), MAKA_LEN: String(bytes) },
      piece,
    );
    if (!answer.startsWith('OK')) {
      throw this.broken(new Error(`the process's input file is out of step (${answer.trim()})`));
    }
    this.offset += bytes;
  }

  private async exec(extra: Record<string, string>, stdin: string): Promise<string> {
    const { machine, dirName, run } = this.options;
    for (let attempt = 1; ; attempt++) {
      try {
        return await machine.execOk(INPUT_APPEND_SCRIPT, {
          envs: { MAKA_DIR: machine.taskDir(dirName), MAKA_RUN: run, ...extra },
          stdin,
          timeoutSeconds: APPEND_TIMEOUT_SECONDS,
        });
      } catch (error) {
        // The answer may have been lost after the write landed: the offset check makes a second
        // try safe, so only an error that cannot get better stops here.
        if (
          this.done ||
          attempt >= APPEND_ATTEMPTS ||
          (error instanceof InstaboxApiError && !error.retryable)
        ) {
          throw this.broken(asError(error));
        }
      }
    }
  }

  private broken(error: Error): Error {
    this.failure ??= error;
    return error;
  }

  // -- output -----------------------------------------------------------------------------------

  private async pump(): Promise<void> {
    try {
      if ((await this.launching) === 'cancelled') {
        this.finish(143, null);
        return;
      }
      const launchedAt = this.options.now();
      for (;;) {
        const update = await this.options.watch.next();
        if (this.done) return;
        if (update.data.length > 0) {
          this.consumed += update.data.length;
          this.options.onOutput?.(update.data);
          this.stdout.push(update.data);
        }
        this.options.onTick?.();
        const state = update.state;
        if (state === 'starting' || state === 'none') {
          if (this.options.now() - launchedAt > this.options.startTimeoutMs) {
            throw new Error('the process did not start in the sandbox');
          }
          continue;
        }
        // The state is read before the bytes, so a run seen as over has all its output in what was read.
        if (state !== 'running' && this.consumed >= update.size) {
          if (typeof state === 'object') this.finish(state.exit, null);
          else this.finish(null, 'SIGKILL');
          return;
        }
      }
    } catch (error) {
      if (this.done) return;
      this.broken(asError(error));
      this.emit('error', this.failure);
      this.finish(null, 'SIGKILL');
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.done) return;
    this.done = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.options.watch.stop();
    this.stdout.push(null);
    this.stdin.destroy();
    this.resolveExited({ code, signal });
    this.emit('exit', code, signal);
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    // Nobody listening to an error is how a plain EventEmitter takes the process down.
    if (event === 'error' && this.listenerCount('error') === 0) return false;
    return super.emit(event, ...args);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}
