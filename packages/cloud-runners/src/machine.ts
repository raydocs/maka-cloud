import { createHash, randomBytes } from 'node:crypto';
import {
  InstaboxApiError,
  type InstaboxClient,
  type InstaboxExecResult,
} from '@maka-cloud/instabox';
import { scrubSecretShapes } from '@maka-cloud/orchestrator';
import { asAgentUser, PREPARE_AGENT_SCRIPT } from './agent-user.js';
import {
  FILE_CHUNK_SCRIPT,
  FILE_CLEAN_SCRIPT,
  FILE_STAGE_SCRIPT,
  INSPECT_SCRIPT,
  KILL_SCRIPT,
  LAUNCH_SCRIPT,
  PREPARE_SCRIPT,
  REMOVE_DIR_SCRIPT,
  RESULT_CHUNK_SCRIPT,
  RESULT_CLEAN_SCRIPT,
  RESULT_STAGE_SCRIPT,
  STAGE_INPUTS_SCRIPT,
  SWEEP_SCRIPT,
  TRANSCRIPT_ABORT_SCRIPT,
  TRANSCRIPT_CHUNK_SCRIPT,
  TRANSCRIPT_PROBE_SCRIPT,
  TOOL_ABORT_SCRIPT,
  TOOL_CHECK_SCRIPT,
  TOOL_CHUNK_SCRIPT,
  buildRunScript,
} from './scripts.js';
import { FEED_FUNCTION, fedCommand } from './process-channel.js';
import { assertSafeId, shq } from './shell.js';

/**
 * Closes the box's network to its host's own addresses and says so only when the rules read back
 * right. It rejects when it cannot, and the box is not used.
 */
export type EgressGuard = (signal?: AbortSignal) => Promise<void>;

/** Installs run in a hidden `.setup-` directory of their own, never in a task's. */
function assertInstallDir(dirName: string): void {
  if (!dirName.startsWith('.setup-')) throw new Error(`not an install directory: ${dirName}`);
}

export const MAX_RESULT_BYTES = 1024 * 1024;
export const DEFAULT_LOG_ROOT = '/dev/shm/maka-logs';
const RESULT_CHUNK_BYTES = 256 * 1024;

const TOOL_CHUNK_BYTES = 256 * 1024;
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
const TRANSCRIPT_ATTEMPTS = 3;

/** Caps on what one task may copy from another's workspace. */
export interface KillOptions {
  signal?: AbortSignal;
  graceTenths?: number;
  cancelRuns?: string[];
  runs?: string[];
  /** Leave alone the runs of an attempt after this one. */
  upToAttempt?: number;
}

function assertAttempt(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error(`Unsafe attempt: ${attempt}`);
  return attempt;
}

/** A run's name: the attempt that started it, when known, and its turn. Stops tell attempts apart by it. */
export function runNameOf(attempt: number | undefined, turn: number): string {
  return attempt === undefined ? `t${turn}` : `e${assertAttempt(attempt)}.t${turn}`;
}

export interface StageLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_STAGE_LIMITS: StageLimits = {
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
};

export type StageResult =
  | { ok: true; files: number; bytes: number }
  | { ok: false; reason: string };

export type ResultRead = { ok: true; bytes: Buffer } | { ok: false; reason: string };

interface ExecOptions {
  /**
   * Wake a paused sandbox and run the command again when it answers `machine_not_running`
   * (default). Task code turns this off: after a wake its caller must look at the box again first.
   */
  wake?: boolean;
  /**
   * The command runs repo, task or CLI code. Such a command only reaches a box whose egress was
   * checked and passed since the box was made or last woken here: until then it is guarded first,
   * and a failure is final (the box is awake, which is not the same as closed).
   */
  taskCode?: boolean;
  envs?: Record<string, string>;
  stdin?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

/**
 * The end of what a failed command printed, for the error that names it. Scrubbed before it is
 * cut, so a key is never cut into a piece the scrubber no longer knows.
 */
function commandOutputTail(result: { stderr: string; stdout: string }): string {
  const text = scrubSecretShapes(result.stderr).trim() || scrubSecretShapes(result.stdout).trim();
  return text.slice(-300);
}

/** The sandbox answered that it is not running; the command did not start. */
function isAsleep(error: unknown): boolean {
  return error instanceof InstaboxApiError && error.code === 'machine_not_running';
}

/** The scripts of this package run against one sandbox. No state beyond ids. */
export class RemoteMachine {
  constructor(
    readonly client: InstaboxClient,
    readonly machineId: string,
    /** Directory in the sandbox that holds one folder per task. */
    readonly root: string,
    /** Memory-backed directory in the sandbox that holds each task's raw CLI output. */
    readonly logRoot: string = DEFAULT_LOG_ROOT,
    /** The account the CLI runs as when it is not the sandbox user; its processes are stopped through sudo. */
    readonly agentUser?: string,
    /** Run before any task code starts in the box; see `launch`. */
    private readonly egress?: EgressGuard,
  ) {}

  private guarding: Promise<void> | undefined;
  /** Errors the egress check threw: a retry must not start task code after one of these. */
  private readonly refusals = new WeakSet<object>();

  /** Wakes the box. Its rules may be gone, so nothing runs in it until the next check passes. */
  private async wake(signal?: AbortSignal): Promise<void> {
    await this.client.ensureRunning(this.machineId, signal ? { signal } : {});
  }

  /**
   * The egress guard, checked right now. One check at a time: callers that arrive while it runs
   * share it, and a later caller checks again, because a box that was restarted, restored or
   * resumed may have lost its rules without anything telling us. A box that fails is refused.
   */
  private guardEgress(signal?: AbortSignal): Promise<void> {
    // A caller that has already given up does not wait for a check.
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.egress) {
      const missing = new Error('this sandbox has no egress guard, so no task starts in it');
      this.refusals.add(missing);
      return Promise.reject(missing);
    }
    const egress = this.egress;
    this.guarding ??= (async () => {
      try {
        // No caller's signal: the check is shared and one caller giving up must not fail the rest.
        try {
          try {
            await egress();
          } catch (error) {
            if (!isAsleep(error)) throw error;
            // Asleep: wake it, and look again, because its rules may be gone.
            await this.wake();
            await egress();
          }
        } catch (error) {
          if (typeof error === 'object' && error !== null) this.refusals.add(error);
          throw error;
        }
      } finally {
        this.guarding = undefined;
      }
    })();
    return signal
      ? Promise.race([
          this.guarding,
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        ])
      : this.guarding;
  }

  /** Where the raw output of a task's runs lives while they run. */
  logDir(dirName: string): string {
    this.taskDir(dirName);
    return `${this.logRoot}/${dirName}`;
  }

  /**
   * The Claude CLI's configuration directory for a task: its transcripts are under `projects/`.
   * Kept in the task's own directory, so no other task reads it and removing the task removes it.
   */
  configDir(dirName: string): string {
    return `${this.taskDir(dirName)}/claude-config`;
  }

  /**
   * A task's directory, or a hidden `.setup-<name>` directory for installs. The sweep for leftover
   * runs only looks at the former.
   */
  taskDir(dirName: string): string {
    const name = dirName.startsWith('.setup-')
      ? `.setup-${assertSafeId('setup name', dirName.slice('.setup-'.length))}`
      : assertSafeId('directory name', dirName);
    return `${this.root}/${name}`;
  }

  /** exec, waking a paused sandbox once if it answers `machine_not_running` (the command did not start). */
  async exec(script: string, options: ExecOptions = {}): Promise<InstaboxExecResult> {
    const request = {
      cmd: script,
      ...(options.envs ? { envs: options.envs } : {}),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    };
    const call = options.signal ? { signal: options.signal } : {};
    // Look first, every time: a box that passed before may have been restarted, restored or woken by
    // someone else since, and lost its rules without this process seeing it.
    if (options.taskCode) await this.guardEgress(options.signal);
    try {
      return await this.client.exec(this.machineId, request, call);
    } catch (error) {
      if (!isAsleep(error) || options.wake === false) throw error;
      await this.wake(options.signal);
      if (options.taskCode) await this.guardEgress(options.signal);
      return await this.client.exec(this.machineId, request, call);
    }
  }

  /** exec that must exit 0. */
  async execOk(script: string, options: ExecOptions = {}): Promise<string> {
    const result = await this.exec(script, options);
    if (result.exitCode !== 0) {
      throw new Error(
        `sandbox command failed (exit ${result.exitCode}): ${commandOutputTail(result)}`,
      );
    }
    return result.stdout;
  }

  /** Creates the task directory and, when given, writes the brief into it. */
  async prepare(
    dirName: string,
    brief?: string,
    signal?: AbortSignal,
    agentGroup?: string,
  ): Promise<void> {
    await this.execOk(PREPARE_SCRIPT, {
      envs: {
        MAKA_DIR: this.taskDir(dirName),
        ...(agentGroup === undefined
          ? {}
          : { MAKA_AGENT_GROUP: assertSafeId('group', agentGroup) }),
        ...(brief === undefined ? {} : { MAKA_WRITE_BRIEF: '1' }),
      },
      ...(brief === undefined ? {} : { stdin: brief }),
      ...(signal ? { signal } : {}),
    });
  }

  /** Gives a task's directory to the agent's group; see `PREPARE_AGENT_SCRIPT`. */
  async prepareAgent(dirName: string, group: string, signal?: AbortSignal): Promise<void> {
    await this.execOk(PREPARE_AGENT_SCRIPT, {
      envs: { MAKA_DIR: this.taskDir(dirName), MAKA_AGENT_GROUP: assertSafeId('group', group) },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Starts the program of a run, as the agent's account, at most once. The program and its
   * arguments come as they are and are quoted here; nothing the caller passes is shell, so no
   * argument can add a command that would run as the sandbox user, who may change the egress rules
   * (the guard does, through sudo). Only `preamble` is shell: lines of the host's own (dropping
   * login selectors, refusing a subscription login) that run before the program. A machine with no
   * agent account starts nothing.
   *
   * After an answer that may or may not have reached the sandbox (transport failure), the lock
   * file decides: locked means it started, free means it did not.
   */
  async launch(input: {
    dirName: string;
    run: string;
    /** Host shell run as the sandbox user before the program. Never built from task content. */
    preamble: string;
    program: string;
    args: readonly string[];
    /** The program's stdin is the run's input file (see `FEED_FUNCTION`). */
    fed?: boolean;
    envs: Record<string, string>;
    runToken: string;
    workdir: string;
    /** Keep the raw output in the memory-backed log directory (default), or next to the run. */
    rawLogs?: boolean;
    signal?: AbortSignal;
  }): Promise<'started' | 'already' | 'cancelled'> {
    if (this.agentUser === undefined) {
      throw new Error('this sandbox has no agent account, so no task code starts in it');
    }
    const line = asAgentUser(
      [input.program, ...input.args].map((word) => shq(word)).join(' '),
      this.agentUser,
      Object.keys(input.envs),
    );
    return await this.start(
      buildRunScript({
        preamble: input.fed ? `${input.preamble}\n${FEED_FUNCTION}` : input.preamble,
        command: input.fed ? fedCommand(line) : line,
      }),
      input,
    );
  }

  /**
   * Runs the pinned install of a CLI, as the sandbox user: it writes the sandbox user's own
   * `~/.maka-cli`, which the agent's account cannot. `install` is the operator's or the pinned
   * command, never task content; nothing of an agent runs in it.
   */
  async launchInstall(input: {
    dirName: string;
    run: string;
    install: string;
    runToken: string;
    signal?: AbortSignal;
  }): Promise<'started' | 'already' | 'cancelled'> {
    assertInstallDir(input.dirName);
    return await this.start(buildRunScript({ preamble: '', command: input.install }), {
      ...input,
      envs: {},
      workdir: this.taskDir(input.dirName),
      rawLogs: false,
    });
  }

  private async start(
    script: string,
    input: {
      dirName: string;
      run: string;
      envs: Record<string, string>;
      runToken: string;
      workdir: string;
      rawLogs?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<'started' | 'already' | 'cancelled'> {
    const envs = {
      ...input.envs,
      MAKA_DIR: this.taskDir(input.dirName),
      ...(input.rawLogs === false ? {} : { MAKA_LOG_DIR: this.logDir(input.dirName) }),
      MAKA_RUN: assertSafeId('run', input.run),
      MAKA_RUN_TOKEN: input.runToken,
      MAKA_WORKDIR: input.workdir,
    };
    const options = { envs, ...(input.signal ? { signal: input.signal } : {}) };
    // Every run, install and resume starts here, so this is where a box is refused: nothing the
    // CLI or a package script does starts before the box's egress is closed and read back.
    input.signal?.throwIfAborted();
    await this.guardEgress(input.signal);
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await this.startOnce(options, script, input.signal);
        if (out.includes('CANCELLED')) return 'cancelled';
        return out.includes('ALREADY') ? 'already' : 'started';
      } catch (error) {
        input.signal?.throwIfAborted();
        // A box that failed its check is refused for good: retrying would find it awake and open.
        if (typeof error === 'object' && error !== null && this.refusals.has(error)) throw error;
        if (error instanceof InstaboxApiError && !error.retryable) throw error;
        // The answer was lost. Look before trying again; the lock file makes a second try safe.
        // The look does not wake the box: asleep, nothing of ours is running, and the retry below
        // wakes it through startOnce, which checks it first.
        const state = await this.execOk(INSPECT_SCRIPT, {
          wake: false,
          envs: { MAKA_DIR: envs.MAKA_DIR, MAKA_RUN: envs.MAKA_RUN },
          ...(input.signal ? { signal: input.signal } : {}),
        }).catch(() => undefined);
        if (state?.includes('LOCKED')) return 'started';
        if (attempt >= 2) throw error;
      }
    }
  }

  /**
   * The launch command, once. The box may have gone to sleep since it was guarded: it answers
   * `machine_not_running` and the command does not start. It is then woken, guarded and read back
   * again, and only then is the command sent a second time; the plain retry of `exec` would run the
   * task's code in a box whose rules a restore may have dropped.
   */
  private async startOnce(
    options: { envs: Record<string, string>; signal?: AbortSignal },
    script: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const run = () => this.execOk(LAUNCH_SCRIPT, { ...options, stdin: script, wake: false });
    try {
      return await run();
    } catch (error) {
      if (!isAsleep(error)) throw error;
      await this.wake(signal);
      await this.guardEgress(signal);
      return await run();
    }
  }

  /**
   * Stops every live run of a task and whatever they started, and deletes their raw output. Returns
   * the runs that had something to stop. Throws when a process survived KILL. `cancelRuns` names
   * runs that may be about to start (a launch in flight); they will not. With `runs`, only those
   * runs are touched (processes, lock, raw output): a run that is done uses this, because a later
   * turn of the same task may already be running.
   */
  async kill(dirName: string, options: KillOptions = {}): Promise<string[]> {
    return (await this.killRuns(dirName, options)).killed;
  }

  /**
   * `kill`, and also the runs it left alone: with `upToAttempt`, the runs of a later attempt are
   * not touched (a stop that was slow must not reach the run of the attempt that took the task over).
   */
  async killRuns(
    dirName: string,
    options: KillOptions = {},
  ): Promise<{ killed: string[]; left: string[] }> {
    const result = await this.exec(KILL_SCRIPT, {
      envs: {
        MAKA_DIR: this.taskDir(dirName),
        MAKA_LOG_DIR: this.logDir(dirName),
        MAKA_GRACE_TENTHS: String(options.graceTenths ?? 30),
        ...(this.agentUser === undefined ? {} : { MAKA_AGENT_USER: this.agentUser }),
        ...(options.runs
          ? { MAKA_ONLY_RUNS: options.runs.map((run) => assertSafeId('run', run)).join(' ') }
          : {}),
        ...(options.cancelRuns?.length
          ? {
              MAKA_CANCEL_RUNS: options.cancelRuns.map((run) => assertSafeId('run', run)).join(' '),
            }
          : {}),
        ...(options.upToAttempt === undefined
          ? {}
          : { MAKA_UP_TO_ATTEMPT: String(assertAttempt(options.upToAttempt)) }),
      },
      timeoutSeconds: 15,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const lines = result.stdout.split('\n');
    const survivors = lines
      .filter((line) => line.startsWith('SURVIVORS '))
      .map((line) => line.slice('SURVIVORS '.length).trim());
    if (survivors.length > 0) {
      throw new Error(`processes of ${dirName} (${survivors.join(', ')}) survived SIGKILL`);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `sandbox command failed (exit ${result.exitCode}): ${commandOutputTail(result)}`,
      );
    }
    const named = (prefix: string) =>
      lines
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length).trim());
    return { killed: named('KILLED '), left: named('LEFT ') };
  }

  /** Names of task directories that still have a live run. */
  async liveTaskDirs(signal?: AbortSignal): Promise<string[]> {
    const out = await this.execOk(SWEEP_SCRIPT, {
      envs: {
        MAKA_ROOT: this.root,
        ...(this.agentUser === undefined ? {} : { MAKA_AGENT_USER: this.agentUser }),
      },
      timeoutSeconds: 15,
      ...(signal ? { signal } : {}),
    });
    return out
      .split('\n')
      .filter((line) => line.startsWith('LIVE '))
      .map((line) => line.slice('LIVE '.length).trim());
  }

  async removeDir(dirName: string): Promise<void> {
    await this.execOk(REMOVE_DIR_SCRIPT, { envs: { MAKA_DIR: this.taskDir(dirName) } });
  }

  /**
   * Reads `result.json` of a task as the sandbox user with `exec`, never `GET /files` (which reads
   * as root and would follow a symlink to files the task must not see). Symlinks and anything but
   * a regular file are refused; at most 1 MiB + 1 byte is copied, in chunks that fit an exec reply.
   */
  async readResult(dirName: string, signal?: AbortSignal): Promise<ResultRead> {
    const dir = this.taskDir(dirName);
    const callOptions = (extra: Record<string, string>): ExecOptions => ({
      envs: { MAKA_DIR: dir, ...extra },
      ...(signal ? { signal } : {}),
    });
    const staged = (await this.execOk(RESULT_STAGE_SCRIPT, callOptions({}))).trim();
    try {
      if (staged === 'MISSING') return { ok: false, reason: 'result.json was not written' };
      if (staged === 'SYMLINK') return { ok: false, reason: 'result.json is a symlink' };
      if (staged === 'NOTFILE') return { ok: false, reason: 'result.json is not a regular file' };
      const match = /^OK (\d+)$/u.exec(staged);
      if (!match) return { ok: false, reason: 'result.json could not be read' };
      const size = Number(match[1]);
      if (size > MAX_RESULT_BYTES) {
        return { ok: false, reason: `result.json is larger than ${MAX_RESULT_BYTES} bytes` };
      }
      const parts: Buffer[] = [];
      for (let offset = 0; offset < size; offset += RESULT_CHUNK_BYTES) {
        const out = await this.execOk(
          RESULT_CHUNK_SCRIPT,
          callOptions({ MAKA_OFF: String(offset), MAKA_LEN: String(RESULT_CHUNK_BYTES) }),
        );
        parts.push(Buffer.from(out.trim(), 'base64'));
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length !== size) {
        return { ok: false, reason: 'result.json changed while it was being copied' };
      }
      return { ok: true, bytes };
    } finally {
      await this.exec(RESULT_CLEAN_SCRIPT, callOptions({})).catch(() => undefined);
    }
  }

  /**
   * Copies `paths` of task `fromDir`'s workspace into `toDir`'s `workspace/inputs/<fromDir>/`. All
   * checks and the copy happen in the sandbox as the sandbox user (see `STAGE_INPUTS_SCRIPT`); the
   * answer is a refusal with its reason, or the number of files and bytes copied. Repeating it
   * replaces the earlier copy.
   */
  async stageInputs(input: {
    fromDir: string;
    toDir: string;
    paths: string[];
    limits?: StageLimits;
    signal?: AbortSignal;
  }): Promise<StageResult> {
    const limits = input.limits ?? DEFAULT_STAGE_LIMITS;
    const out = await this.execOk(STAGE_INPUTS_SCRIPT, {
      envs: {
        MAKA_ROOT: this.root,
        MAKA_FROM: assertSafeId('task id', input.fromDir),
        MAKA_DIR: this.taskDir(input.toDir),
        MAKA_PATHS: input.paths.join('\n'),
        MAKA_MAX_FILES: String(limits.maxFiles),
        MAKA_MAX_FILE_BYTES: String(limits.maxFileBytes),
        MAKA_MAX_TOTAL_BYTES: String(limits.maxTotalBytes),
      },
      timeoutSeconds: 120,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const line = out.trim().split('\n').pop() ?? '';
    const ok = /^OK (\d+) (\d+)$/u.exec(line);
    if (ok) return { ok: true, files: Number(ok[1]), bytes: Number(ok[2]) };
    if (line.startsWith('REFUSED ')) return { ok: false, reason: line.slice('REFUSED '.length) };
    return { ok: false, reason: 'the copy did not report a result' };
  }

  /** Whether the tool is installed with exactly this content (`hash` is its sha256, hex). */
  async hasTool(name: string, hash: string, marker: string): Promise<boolean> {
    const result = await this.exec(TOOL_CHECK_SCRIPT, {
      envs: { MAKA_TOOL_NAME: name, MAKA_TOOL_HASH: hash, MAKA_TOOL_MARKER: marker },
    });
    return result.exitCode === 0;
  }

  /**
   * Writes the tool to `$HOME/.maka-cli/bin/<name>` in chunks, checks its sha256 in the sandbox and
   * renames it into place, so a run never starts a half-written file. A failed install removes its
   * temporary file.
   */
  async installTool(input: {
    name: string;
    content: Buffer;
    hash: string;
    marker: string;
    tmpName: string;
  }): Promise<void> {
    const chunks = Math.max(1, Math.ceil(input.content.length / TOOL_CHUNK_BYTES));
    try {
      for (let index = 0; index < chunks; index++) {
        const slice = input.content.subarray(
          index * TOOL_CHUNK_BYTES,
          (index + 1) * TOOL_CHUNK_BYTES,
        );
        await this.execOk(TOOL_CHUNK_SCRIPT, {
          envs: {
            MAKA_TOOL_NAME: input.name,
            MAKA_TOOL_HASH: input.hash,
            MAKA_TOOL_MARKER: input.marker,
            MAKA_TOOL_TMP: input.tmpName,
            MAKA_FIRST: index === 0 ? '1' : '0',
            MAKA_LAST: index === chunks - 1 ? '1' : '0',
          },
          stdin: slice.toString('base64'),
        });
      }
    } catch (error) {
      await this.exec(TOOL_ABORT_SCRIPT, { envs: { MAKA_TOOL_TMP: input.tmpName } }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  /**
   * Reads one file of a task's workspace as the sandbox user, never through `GET /files` (which
   * reads as root and would follow a symlink to files the task must not see). The path must be
   * plain and relative; symlinks anywhere on it and anything but a regular file are refused; at
   * most `maxBytes` are read, in chunks that fit an exec reply.
   */
  async readWorkspaceFile(
    dirName: string,
    relPath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<ResultRead> {
    const stage = `export-${randomBytes(8).toString('hex')}.read`;
    const callOptions = (extra: Record<string, string>): ExecOptions => ({
      envs: { MAKA_DIR: this.taskDir(dirName), MAKA_STAGE: stage, ...extra },
      ...(signal ? { signal } : {}),
    });
    try {
      const staged = (
        await this.execOk(
          FILE_STAGE_SCRIPT,
          callOptions({ MAKA_REL: relPath, MAKA_CAP: String(maxBytes) }),
        )
      ).trim();
      const refused = /^REFUSED (.*)$/u.exec(staged);
      if (refused) return { ok: false, reason: refused[1] as string };
      const match = /^OK (\d+)$/u.exec(staged);
      if (!match) return { ok: false, reason: 'it could not be read' };
      const size = Number(match[1]);
      const parts: Buffer[] = [];
      for (let offset = 0; offset < size; offset += RESULT_CHUNK_BYTES) {
        const out = await this.execOk(
          FILE_CHUNK_SCRIPT,
          callOptions({ MAKA_OFF: String(offset), MAKA_LEN: String(RESULT_CHUNK_BYTES) }),
        );
        parts.push(Buffer.from(out.trim(), 'base64'));
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length !== size)
        return { ok: false, reason: 'it changed while it was being copied' };
      return { ok: true, bytes };
    } finally {
      await this.exec(FILE_CLEAN_SCRIPT, callOptions({})).catch(() => undefined);
    }
  }

  /** Lines in a session's transcript in the task's configuration directory (0 when there is none). */
  async transcriptLines(dirName: string, projectKey: string, sessionId: string): Promise<number> {
    const out = await this.execOk(TRANSCRIPT_PROBE_SCRIPT, {
      envs: transcriptEnvs(this.taskDir(dirName), projectKey, sessionId),
    });
    const lines = Number(out.trim());
    return Number.isSafeInteger(lines) && lines >= 0 ? lines : 0;
  }

  /**
   * Puts a session's transcript where the CLI looks for it, from a stream of its bytes: in chunks
   * into a temporary file, checked by sha256 and renamed into place at the end. A chunk whose answer
   * was lost is sent again safely (the file's size says whether it landed). A failed upload removes
   * its temporary file.
   */
  async installTranscript(input: {
    dirName: string;
    projectKey: string;
    sessionId: string;
    bytes: AsyncIterable<Buffer>;
    signal?: AbortSignal;
  }): Promise<void> {
    const base = transcriptEnvs(this.taskDir(input.dirName), input.projectKey, input.sessionId);
    const hash = createHash('sha256');
    let offset = 0;
    let held: Buffer | undefined;
    const send = async (chunk: Buffer, last: boolean): Promise<void> => {
      const envs = {
        ...base,
        MAKA_OFFSET: String(offset),
        MAKA_LEN: String(chunk.length),
        MAKA_LAST: last ? '1' : '0',
        ...(last ? { MAKA_HASH: hash.copy().digest('hex') } : {}),
      };
      for (let attempt = 1; ; attempt++) {
        try {
          await this.execOk(TRANSCRIPT_CHUNK_SCRIPT, {
            envs,
            stdin: chunk.toString('base64'),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          break;
        } catch (error) {
          if (attempt >= TRANSCRIPT_ATTEMPTS || input.signal?.aborted) throw error;
        }
      }
      offset += chunk.length;
    };
    try {
      for await (const piece of input.bytes) {
        hash.update(piece);
        for (let at = 0; at < piece.length; at += TRANSCRIPT_CHUNK_BYTES) {
          // One chunk is held back so that the last one is known to be the last.
          if (held) await send(held, false);
          held = piece.subarray(at, at + TRANSCRIPT_CHUNK_BYTES);
        }
      }
      await send(held ?? Buffer.alloc(0), true);
    } catch (error) {
      await this.exec(TRANSCRIPT_ABORT_SCRIPT, { envs: base }).catch(() => undefined);
      throw error;
    }
  }
}

function transcriptEnvs(
  dir: string,
  projectKey: string,
  sessionId: string,
): Record<string, string> {
  return { MAKA_DIR: dir, MAKA_KEY: projectKey, MAKA_SESSION: sessionId };
}
