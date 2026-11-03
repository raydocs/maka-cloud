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
  /**
   * Box only: a string that appears in this run's argv, which stop and RSS
   * sampling find the process by (`pkill -f`). Default: a bare UUID argument.
   */
  marker?: string;
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
    // The box has its own PATH, HOME and CODEX_HOME (where the signed-in CLI
    // keeps its login and sessions); only route variables such as a gateway
    // URL go in.
    const env = Object.fromEntries(
      Object.entries(spec.env).filter(([key]) => !HOST_ONLY_KEYS.includes(key)),
    );
    // Box Secret values are known only inside the box, so the box filters
    // them out of the CLI's output before the host reads it.
    const boxSecrets = Object.values(spec.envFromBox ?? {});
    const filter = (whole: boolean) =>
      boxSecrets.length
        ? `awk -v names=${shellWord(boxSecrets.join(' '))}${whole ? ' -v whole=1' : ''} ${shellWord(SCRUB_AWK)}`
        : '';
    const timed = this.options.timeBin ? [this.options.timeBin, '-f', `${RSS_MARK}%M`] : [];
    const cmd = [...refs, ...[...timed, spec.command, ...spec.args].map(shellWord)].join(' ');
    const sandbox = this.sandbox;
    const peak = this.peakRssKb;
    const pollMs = this.options.pollMs ?? 2000;
    const deadline = Date.now() + (this.options.timeoutSeconds ?? 3600) * 1000;
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const marker =
      spec.marker && spec.args.some((arg) => arg.includes(spec.marker as string))
        ? spec.marker
        : spec.args.find((arg) => UUID_RE.test(arg));
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
      let running = false;
      try {
        // Instabox exec drops its `env` field, so variables (a gateway key
        // among them) reach the box on stdin as a 0600 file that run.sh
        // sources and deletes before the CLI starts.
        const envScript = Object.entries(env)
          .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
          .join('\n');
        const script = [
          '#!/bin/sh',
          '. "$1/env"',
          'rm -f "$1/env"',
          // A stop that came while the start request ran: never start the CLI.
          '[ -e "$1/stop" ] && { echo 143 > "$1/code"; exit 0; }',
          ...(boxSecrets.length
            ? [
                `{ ${cmd} < "$1/in" 2> "$1/err.raw"; echo $? > "$1/rc"; } | ${filter(false)} > "$1/out"`,
                `${filter(true)} < "$1/err.raw" > "$1/err"`,
                'rm -f "$1/err.raw"',
                'mv "$1/rc" "$1/code"',
              ]
            : [`${cmd} < "$1/in" > "$1/out" 2> "$1/err"`, 'echo $? > "$1/code"']),
          '',
        ].join('\n');
        const setup = await exec({
          cmd: `umask 077 && mkdir -p .maka-exec/${runId} && cd .maka-exec/${runId} && read -r e && read -r p && printf %s "$e" | base64 -d > env && printf %s "$p" | base64 -d > in && printf %s ${shellWord(Buffer.from(script).toString('base64'))} | base64 -d > run.sh && pwd`,
          stdin: `${Buffer.from(envScript).toString('base64')}\n${Buffer.from(stdin).toString('base64')}\n`,
          timeoutSeconds: 60,
        });
        dir = setup.stdout.trim().split('\n').at(-1) ?? '';
        if (setup.exitCode !== 0 || !dir.startsWith('/')) {
          throw new Error(`box exec setup failed: ${setup.stderr.slice(-400)}`);
        }
        // Stopped while the setup ran: never start the CLI.
        if (killed) return;
        const started = await exec({
          cmd: `(nohup sh ${shellWord(`${dir}/run.sh`)} ${shellWord(dir)} > /dev/null 2>&1 < /dev/null &)`,
          cwd: spec.cwd,
          timeoutSeconds: 60,
        });
        if (started.exitCode !== 0)
          throw new Error(`box exec start failed: ${started.stderr.slice(-400)}`);
        running = true;
        // Stopped while the start request ran: the CLI may have started after
        // kill()'s pkill. Keep stopping it until run.sh reports an exit.
        if (killed) {
          for (let tries = 0; tries < 30; tries += 1) {
            const stopped = await exec({
              cmd: `touch ${shellWord(`${dir}/stop`)}; ${marker ? `pkill -f -- ${shellWord(marker)}; ` : ''}test -e ${shellWord(`${dir}/code`)} && echo stopped || true`,
              timeoutSeconds: 30,
            });
            if (stopped.stdout.includes('stopped')) break;
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
          return;
        }
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
        // A poll that failed leaves a detached CLI nobody watches: stop it.
        if (failure && running && !killed && marker) {
          killed = true;
          await exec({ cmd: `pkill -f -- ${shellWord(marker)} || true`, timeoutSeconds: 30 }).catch(
            () => undefined,
          );
        }
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

/**
 * Runs a CLI's login check (`claude auth status`, `codex login status`) and
 * reports whether it exited 0. Any error counts as not signed in.
 */
export async function signedIn(runner: ProcessRunner, spec: ExecutorProcessSpec): Promise<boolean> {
  try {
    const proc = runner.spawn(spec);
    proc.endInput();
    for await (const _line of proc.lines) {
      // Drain; the exit code is the answer.
    }
    return (await proc.exited).code === 0;
  } catch {
    return false;
  }
}

/** Always-quoted shell word, for values (an empty value stays an empty string). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Replaces each box Secret's value, raw and as JSON escapes it, with
 * `[NAME]`. The cursor moves past each replacement, so a value that is part
 * of its own tag cannot loop. With `whole`, the input is one record (stderr
 * read from a file), so a value that spans lines is still found.
 */
const SCRUB_AWK = String.raw`function rep(str, a, b,   out, i) {
  out = ""
  while ((i = index(str, a)) > 0) { out = out substr(str, 1, i - 1) b; str = substr(str, i + length(a)) }
  return out str
}
BEGIN {
  n = split(names, k, " ")
  for (j = 1; j <= n; j++) {
    v[j] = ENVIRON[k[j]]
    e = rep(v[j], "\\", "\\\\"); e = rep(e, "\"", "\\\""); e = rep(e, "\n", "\\n"); e = rep(e, "\r", "\\r"); e = rep(e, "\t", "\\t")
    w[j] = e
  }
  if (whole) { RS = "\001"; ORS = "" }
}
{
  for (j = 1; j <= n; j++) if (length(v[j]) >= 8) {
    $0 = rep($0, v[j], "[" k[j] "]")
    if (w[j] != v[j]) $0 = rep($0, w[j], "[" k[j] "]")
  }
  print
  fflush()
}`;

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The executor process gets only these variables from the host, plus the
 * vendor keys the caller names. Never the whole host env: GitHub tokens and
 * other secrets stay on the host.
 */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'USER', 'SHELL'];
/** Host paths that must never reach a box. */
const HOST_ONLY_KEYS = [...BASE_ENV_KEYS, 'CODEX_HOME'];

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

/** `redactSecrets` over every string inside a value (an executor event, say). */
export function redactDeep<T>(value: T, env: Record<string, string>, keys: readonly string[]): T {
  if (typeof value === 'string') return redactSecrets(value, env, keys) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, env, keys)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item, env, keys)]),
    ) as T;
  }
  return value;
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
    let stepped = false;
    let finished = false;
    let exit: ExecutorProcessExit = { code: 0, signal: null, stderr: '' };
    let wake: (() => void) | undefined;
    let resolveExit: (value: ExecutorProcessExit) => void = () => undefined;
    const exited = new Promise<ExecutorProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const step = () => {
      stepped = true;
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
      // A process that got no stdin (a login check) still runs its script once.
      if (!stepped) step();
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
