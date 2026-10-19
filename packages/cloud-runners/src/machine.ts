import {
  InstaboxApiError,
  type InstaboxClient,
  type InstaboxExecResult,
} from '@maka-cloud/instabox';
import {
  INSPECT_SCRIPT,
  KILL_SCRIPT,
  LAUNCH_SCRIPT,
  PREPARE_SCRIPT,
  REMOVE_DIR_SCRIPT,
  RESULT_CHUNK_SCRIPT,
  RESULT_CLEAN_SCRIPT,
  RESULT_STAGE_SCRIPT,
  SWEEP_SCRIPT,
} from './scripts.js';
import { assertSafeId } from './shell.js';

export const MAX_RESULT_BYTES = 1024 * 1024;
const RESULT_CHUNK_BYTES = 256 * 1024;

export type ResultRead = { ok: true; bytes: Buffer } | { ok: false; reason: string };

interface ExecOptions {
  envs?: Record<string, string>;
  stdin?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

/** The scripts of this package run against one sandbox. No state beyond ids. */
export class RemoteMachine {
  constructor(
    readonly client: InstaboxClient,
    readonly machineId: string,
    /** Directory in the sandbox that holds one folder per task. */
    readonly root: string,
  ) {}

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
    try {
      return await this.client.exec(this.machineId, request, call);
    } catch (error) {
      if (!(error instanceof InstaboxApiError) || error.code !== 'machine_not_running') throw error;
      await this.client.ensureRunning(this.machineId, call);
      return await this.client.exec(this.machineId, request, call);
    }
  }

  /** exec that must exit 0. */
  async execOk(script: string, options: ExecOptions = {}): Promise<string> {
    const result = await this.exec(script, options);
    if (result.exitCode !== 0) {
      throw new Error(
        `sandbox command failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-300) || result.stdout.trim().slice(-300)}`,
      );
    }
    return result.stdout;
  }

  /** Creates the task directory and, when given, writes the brief into it. */
  async prepare(dirName: string, brief?: string, signal?: AbortSignal): Promise<void> {
    await this.execOk(PREPARE_SCRIPT, {
      envs: {
        MAKA_DIR: this.taskDir(dirName),
        ...(brief === undefined ? {} : { MAKA_WRITE_BRIEF: '1' }),
      },
      ...(brief === undefined ? {} : { stdin: brief }),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Starts a run at most once. After an answer that may or may not have reached the sandbox
   * (transport failure), the lock file decides: locked means it started, free means it did not.
   */
  async launch(input: {
    dirName: string;
    run: string;
    script: string;
    envs: Record<string, string>;
    runToken: string;
    workdir: string;
    signal?: AbortSignal;
  }): Promise<'started' | 'already'> {
    const envs = {
      ...input.envs,
      MAKA_DIR: this.taskDir(input.dirName),
      MAKA_RUN: assertSafeId('run', input.run),
      MAKA_RUN_TOKEN: input.runToken,
      MAKA_WORKDIR: input.workdir,
    };
    const options = { envs, ...(input.signal ? { signal: input.signal } : {}) };
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await this.execOk(LAUNCH_SCRIPT, { ...options, stdin: input.script });
        return out.includes('ALREADY') ? 'already' : 'started';
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof InstaboxApiError && !error.retryable) throw error;
        // The answer was lost. Look before trying again; the lock file makes a second try safe.
        const state = await this.execOk(INSPECT_SCRIPT, {
          envs: { MAKA_DIR: envs.MAKA_DIR, MAKA_RUN: envs.MAKA_RUN },
          ...(input.signal ? { signal: input.signal } : {}),
        }).catch(() => undefined);
        if (state?.includes('LOCKED')) return 'started';
        if (attempt >= 2) throw error;
      }
    }
  }

  /** Stops every live run of a task. Returns the runs that were stopped. */
  async kill(
    dirName: string,
    options: { signal?: AbortSignal; graceTenths?: number } = {},
  ): Promise<string[]> {
    const out = await this.execOk(KILL_SCRIPT, {
      envs: {
        MAKA_DIR: this.taskDir(dirName),
        MAKA_GRACE_TENTHS: String(options.graceTenths ?? 30),
      },
      timeoutSeconds: 15,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return out
      .split('\n')
      .filter((line) => line.startsWith('KILLED '))
      .map((line) => line.slice('KILLED '.length).trim());
  }

  /** Names of task directories that still have a live run. */
  async liveTaskDirs(signal?: AbortSignal): Promise<string[]> {
    const out = await this.execOk(SWEEP_SCRIPT, {
      envs: { MAKA_ROOT: this.root },
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
}
