import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { SandboxPort } from './sandbox.js';

/** One headless executor process (Claude Code, Codex). Tests use a scripted runner. */
export interface ExecutorProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Instabox machine, for `BoxProcessRunner`. */
  machineId?: string;
}

export interface ExecutorProcessExit {
  code: number | null;
  signal: string | null;
  stderr: string;
}

export interface ExecutorProcess {
  /** stdout, one line at a time. */
  lines: AsyncIterable<string>;
  /** False once stdin is closed. */
  write(text: string): boolean;
  endInput(): void;
  kill(): void;
  exited: Promise<ExecutorProcessExit>;
}

export interface ProcessRunner {
  spawn(spec: ExecutorProcessSpec): ExecutorProcess;
}

const STDERR_KEEP = 8_000;

export class NodeProcessRunner implements ProcessRunner {
  spawn(spec: ExecutorProcessSpec): ExecutorProcess {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    let open = true;
    child.stdin.on('error', () => {
      open = false;
    });
    const exited = new Promise<ExecutorProcessExit>((resolve) => {
      child.on('error', (error) => {
        open = false;
        resolve({ code: null, signal: null, stderr: `${stderr}${error.message}` });
      });
      child.on('close', (code, signal) => {
        open = false;
        resolve({ code, signal, stderr });
      });
    });
    return {
      lines: createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }),
      write(text: string) {
        if (!open || child.stdin.destroyed) return false;
        child.stdin.write(text);
        return true;
      },
      endInput() {
        if (open && !child.stdin.destroyed) child.stdin.end();
        open = false;
      },
      kill() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      },
      exited,
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs the executor CLI inside the tenant's Instabox through `exec`, where
 * Claude Code and Codex are installed and signed in. Instabox exec answers
 * once the command exits, so stdin is everything written before the output
 * is first read, and stdout is replayed afterwards. `write` after that
 * returns false (the executor defers the text to its next turn). `kill`
 * runs `pkill -f` on the session id in a second exec.
 */
export class BoxProcessRunner implements ProcessRunner {
  constructor(
    private readonly sandbox: SandboxPort,
    private readonly options: { timeoutSeconds?: number } = {},
  ) {}

  spawn(spec: ExecutorProcessSpec): ExecutorProcess {
    const machineId = spec.machineId;
    if (!machineId) throw new Error('BoxProcessRunner needs spec.machineId.');
    const sandbox = this.sandbox;
    const timeoutSeconds = this.options.timeoutSeconds ?? 3600;
    let stdin = '';
    let accepting = true;
    let resolveExit: (value: ExecutorProcessExit) => void = () => undefined;
    const exited = new Promise<ExecutorProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const cmd = [spec.command, ...spec.args].map(shellWord).join(' ');
    // The box has its own PATH and HOME (where the signed-in CLI keeps its
    // login); only route variables such as a gateway URL go in.
    const env = Object.fromEntries(
      Object.entries(spec.env).filter(([key]) => !BASE_ENV_KEYS.includes(key)),
    );
    async function* lines(): AsyncIterable<string> {
      accepting = false;
      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        result = await sandbox.exec(machineId as string, {
          cmd,
          cwd: spec.cwd,
          ...(Object.keys(env).length ? { env } : {}),
          stdin,
          timeoutSeconds,
        });
      } catch (error) {
        resolveExit({
          code: null,
          signal: null,
          stderr: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      for (const line of result.stdout.split('\n')) if (line.trim()) yield line;
      resolveExit({
        code: result.exitCode,
        signal: null,
        stderr: result.stderr.slice(-STDERR_KEEP),
      });
    }
    return {
      lines: lines(),
      write(text: string) {
        if (!accepting) return false;
        stdin += text;
        return true;
      },
      endInput() {
        accepting = false;
      },
      kill() {
        const marker = spec.args.find((arg) => UUID_RE.test(arg));
        if (!marker) return;
        void sandbox
          .exec(machineId, { cmd: `pkill -f -- ${shellWord(marker)} || true`, timeoutSeconds: 30 })
          .catch(() => undefined);
      },
      exited,
    };
  }
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The executor process gets only these variables from the host, plus the
 * vendor keys the caller names. Never the whole host env: GitHub tokens and
 * other secrets stay on the host.
 */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'USER', 'SHELL'];

export function executorEnv(
  source: NodeJS.ProcessEnv,
  vendorKeys: readonly string[],
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...vendorKeys]) {
    const value = source[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return { ...out, ...extra };
}

/** Removes secret values (keys passed to the executor) from text the host keeps. */
export function redactSecrets(
  text: string,
  env: Record<string, string>,
  keys: readonly string[],
): string {
  let out = text;
  for (const key of keys) {
    const value = env[key];
    if (value && value.length >= 8) out = out.split(value).join(`[${key}]`);
  }
  return out;
}

/** Scripted process for tests: replays stdout lines, records stdin. */
export class ScriptedProcessRunner implements ProcessRunner {
  readonly spawned: Array<ExecutorProcessSpec & { stdin: string[]; killed: boolean }> = [];

  /**
   * Each spawn takes the next script. A script maps what was written to
   * stdin so far to the lines to print; it runs again after every write.
   */
  constructor(
    private readonly scripts: Array<
      (stdin: readonly string[]) => {
        lines: string[];
        done?: boolean;
        code?: number;
        stderr?: string;
      }
    >,
  ) {}

  spawn(spec: ExecutorProcessSpec): ExecutorProcess {
    const script = this.scripts.shift();
    if (!script) throw new Error(`ScriptedProcessRunner: no script left for ${spec.command}`);
    const row = { ...spec, stdin: [] as string[], killed: false };
    this.spawned.push(row);
    const queue: string[] = [];
    let printed = 0;
    let finished = false;
    let exit: ExecutorProcessExit = { code: 0, signal: null, stderr: '' };
    let wake: (() => void) | undefined;
    let resolveExit: (value: ExecutorProcessExit) => void = () => undefined;
    const exited = new Promise<ExecutorProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const step = () => {
      const out = script(row.stdin);
      queue.push(...out.lines.slice(printed));
      printed = out.lines.length;
      if (out.done) {
        finished = true;
        exit = { code: out.code ?? 0, signal: null, stderr: out.stderr ?? '' };
      }
      wake?.();
    };
    const finish = () => {
      finished = true;
      wake?.();
    };
    async function* lines(): AsyncIterable<string> {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        if (finished || row.killed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      resolveExit(row.killed ? { code: null, signal: 'SIGTERM', stderr: exit.stderr } : exit);
    }
    let open = true;
    return {
      lines: lines(),
      write(text: string) {
        if (!open) return false;
        row.stdin.push(text);
        queueMicrotask(step);
        return true;
      },
      endInput() {
        open = false;
        queueMicrotask(finish);
      },
      kill() {
        row.killed = true;
        open = false;
        wake?.();
      },
      exited,
    };
  }
}
