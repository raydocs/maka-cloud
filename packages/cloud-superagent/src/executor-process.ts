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
  /**
   * Box only: variables set from other box variables, e.g.
   * `CLAUDE_CODE_OAUTH_TOKEN` ← `CLAUDE_TOKEN_1`, an Instabox Secret whose
   * box value is a placeholder the outbound proxy swaps. The host never
   * sees or sends the value.
   */
  envFromBox?: Record<string, string>;
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

const RSS_MARK = 'MAKA_PEAK_RSS_KB=';
const POLL_MARK = '--MAKA-OUT--';
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs the executor CLI inside the tenant's Instabox, where Claude Code and
 * Codex are installed and signed in. One Instabox `exec` may last at most
 * 600 s, so the CLI starts detached (`nohup`, stdin from a file) and its
 * stdout file is polled; lines arrive while it runs, so budgets apply
 * mid-run. stdin is what was written before the output is first read;
 * `write` after that returns false (the executor keeps the text for its next
 * turn). `kill` runs `pkill -f` on the session id.
 */
export class BoxProcessRunner implements ProcessRunner {
  /**
   * Peak RSS (KiB) of the last run per machine: GNU time when `timeBin` is
   * set, else the largest sum of the session's processes seen at a poll.
   */
  readonly peakRssKb = new Map<string, number>();

  constructor(
    private readonly sandbox: SandboxPort,
    private readonly options: {
      /** Whole run, default 3600 s. */
      timeoutSeconds?: number;
      /** Between output polls, default 2000 ms. */
      pollMs?: number;
      /** GNU time in the box (e.g. `/usr/bin/time`): records peak RSS. */
      timeBin?: string;
    } = {},
  ) {}

  spawn(spec: ExecutorProcessSpec): ExecutorProcess {
    const machineId = spec.machineId;
    if (!machineId) throw new Error('BoxProcessRunner needs spec.machineId.');
    const refs = Object.entries(spec.envFromBox ?? {}).map(([name, from]) => {
      if (!ENV_NAME_RE.test(name) || !ENV_NAME_RE.test(from)) {
        throw new Error(`BoxProcessRunner: bad variable name ${name} or ${from}.`);
      }
      return `${name}="$${from}"`;
    });
    // The box has its own PATH and HOME (where the signed-in CLI keeps its
    // login); only route variables such as a gateway URL go in.
    const env = Object.fromEntries(
      Object.entries(spec.env).filter(([key]) => !BASE_ENV_KEYS.includes(key)),
    );
    const timed = this.options.timeBin ? [this.options.timeBin, '-f', `${RSS_MARK}%M`] : [];
    const cmd = [...refs, ...[...timed, spec.command, ...spec.args].map(shellWord)].join(' ');
    const sandbox = this.sandbox;
    const peak = this.peakRssKb;
    const pollMs = this.options.pollMs ?? 2000;
    const deadline = Date.now() + (this.options.timeoutSeconds ?? 3600) * 1000;
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const marker = spec.args.find((arg) => UUID_RE.test(arg));
    let stdin = '';
    let accepting = true;
    let killed = false;
    let resolveExit: (value: ExecutorProcessExit) => void = () => undefined;
    const exited = new Promise<ExecutorProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const exec = (request: Parameters<SandboxPort['exec']>[1]) => sandbox.exec(machineId, request);
    const kill = () => {
      killed = true;
      accepting = false;
      if (!marker) return;
      void exec({ cmd: `pkill -f -- ${shellWord(marker)} || true`, timeoutSeconds: 30 }).catch(
        () => undefined,
      );
    };
    async function* lines(): AsyncIterable<string> {
      accepting = false;
      let dir = '';
      let code: number | null = null;
      let sampledRss = 0;
      let failure: string | undefined;
      try {
        const script = [
          '#!/bin/sh',
          `${cmd} < "$1/in" > "$1/out" 2> "$1/err"`,
          'echo $? > "$1/code"',
          '',
        ].join('\n');
        const setup = await exec({
          cmd: `mkdir -p .maka-exec/${runId} && cd .maka-exec/${runId} && base64 -d > in && printf %s ${shellWord(Buffer.from(script).toString('base64'))} | base64 -d > run.sh && pwd`,
          stdin: Buffer.from(stdin).toString('base64'),
          timeoutSeconds: 60,
        });
        dir = setup.stdout.trim().split('\n').at(-1) ?? '';
        if (setup.exitCode !== 0 || !dir.startsWith('/')) {
          throw new Error(`box exec setup failed: ${setup.stderr.slice(-400)}`);
        }
        const started = await exec({
          cmd: `(nohup sh ${shellWord(`${dir}/run.sh`)} ${shellWord(dir)} > /dev/null 2>&1 < /dev/null &)`,
          cwd: spec.cwd,
          ...(Object.keys(env).length ? { env } : {}),
          timeoutSeconds: 60,
        });
        if (started.exitCode !== 0)
          throw new Error(`box exec start failed: ${started.stderr.slice(-400)}`);
        let offset = 0;
        // Sum of RSS over the processes whose argv carries the session id.
        const rssProbe = marker
          ? `printf '${RSS_MARK}%s\\n' "$(ps -eo rss=,args= 2>/dev/null | grep -F -- ${shellWord(marker)} | grep -v -e grep -e 'ps -eo' | awk '{s+=$1} END {print s+0}')"; `
          : '';
        while (!killed) {
          if (Date.now() > deadline) {
            kill();
            break;
          }
          const polled = await exec({
            cmd: `${rssProbe}cat ${shellWord(`${dir}/code`)} 2>/dev/null; printf '\\n${POLL_MARK}\\n'; tail -c +${offset + 1} ${shellWord(`${dir}/out`)} 2>/dev/null`,
            timeoutSeconds: 30,
          });
          const at = polled.stdout.indexOf(`\n${POLL_MARK}\n`);
          let head = at >= 0 ? polled.stdout.slice(0, at).trim() : '';
          const sampled = new RegExp(`^${RSS_MARK}(\\d+)\\n?`).exec(head);
          if (sampled) {
            sampledRss = Math.max(sampledRss, Number(sampled[1]));
            head = head.slice(sampled[0].length).trim();
          }
          const body = at >= 0 ? polled.stdout.slice(at + POLL_MARK.length + 2) : '';
          // Only whole lines count; a partial last line is read again next time.
          const end = head ? body.length : body.lastIndexOf('\n') + 1;
          const chunk = body.slice(0, end);
          offset += Buffer.byteLength(chunk);
          for (const line of chunk.split('\n')) if (line.trim()) yield line;
          if (head) {
            code = Number(head);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        // Also runs when the reader stops at the result line, so the run
        // directory (with the prompt) never stays in the box.
        let stderr = failure ?? '';
        if (dir) {
          const err = await exec({
            cmd: `tail -c ${STDERR_KEEP} ${shellWord(`${dir}/err`)} 2>/dev/null; rm -rf ${shellWord(dir)}`,
            timeoutSeconds: 30,
          }).catch(() => undefined);
          if (!failure) stderr = err?.stdout ?? '';
        }
        const rss = new RegExp(`${RSS_MARK}(\\d+)`).exec(stderr);
        if (rss) peak.set(machineId as string, Number(rss[1]));
        else if (sampledRss > 0) peak.set(machineId as string, sampledRss);
        resolveExit({
          code: killed || failure ? null : code,
          signal: killed ? 'SIGTERM' : null,
          stderr,
        });
      }
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
      kill,
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
