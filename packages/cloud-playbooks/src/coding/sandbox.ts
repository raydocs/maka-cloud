import type { Fleet, RemoteMachine } from '@maka-cloud/runners';
import { CHECK_STOP_SCRIPT, checkTagPrefix } from './scripts.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The sandbox cut the output short. */
  truncated?: boolean;
  /** The sandbox ended the command at the exec's time limit. */
  timedOut?: boolean;
}

export interface ExecOptions {
  envs?: Record<string, string>;
  stdin?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

/** The task's directory in the sandbox, on the machine its agent runs on. */
export interface SandboxWorkspace {
  /** The task directory; the repository is `${dir}/workspace`. */
  readonly dir: string;
  exec(script: string, options?: ExecOptions): Promise<ExecResult>;
  /** Stops every process of the task: agent runs and checks. Idempotent. */
  stopAll(signal?: AbortSignal): Promise<void>;
  /** Whether the agent's runs for this task ran on this workspace's machine. */
  agentOnSameMachine(): Promise<boolean>;
  /** Gives the sandbox lease back. Idempotent. */
  release(): Promise<void>;
}

export interface CodingSandbox {
  open(taskId: string, signal?: AbortSignal): Promise<SandboxWorkspace>;
  /** Stops whatever a task left running, found by id alone (after a restart). Idempotent. */
  stopTask(taskId: string, signal?: AbortSignal): Promise<void>;
}

/**
 * The sandbox of the T6 runners: the same tenant machine, the same task directory and the same
 * task-wide stop, so the agent's runs and the runner's checks share one workspace.
 */
export class FleetCodingSandbox implements CodingSandbox {
  constructor(private readonly fleet: Fleet) {}

  async open(taskId: string, signal?: AbortSignal): Promise<SandboxWorkspace> {
    const { fleet } = this;
    const lease = await fleet.sandboxes.acquire({ tenantId: fleet.tenantOf(taskId), taskId });
    if (signal?.aborted) {
      await lease.release();
      throw signal.reason;
    }
    const machine: RemoteMachine = fleet.machine(lease.machineId);
    let released = false;
    return {
      dir: machine.taskDir(taskId),
      exec: async (script, options = {}) => {
        const result = await machine.exec(script, options);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
          timedOut: result.timedOut,
        };
      },
      stopAll: async (stopSignal) => {
        await machine.kill(taskId, stopSignal ? { signal: stopSignal } : {});
        await stopChecks(machine, taskId, stopSignal);
      },
      agentOnSameMachine: async () =>
        (await fleet.sessions.get(taskId))?.machineId === lease.machineId,
      release: async () => {
        if (released) return;
        released = true;
        await lease.release();
      },
    };
  }

  async stopTask(taskId: string, signal?: AbortSignal): Promise<void> {
    const { fleet } = this;
    let failure: unknown;
    await fleet.stopTask(taskId, signal).catch((error: unknown) => {
      failure = error;
    });
    // The checks ran on the machine the task's lease gives, as in open().
    try {
      const lease = await fleet.sandboxes.acquire({ tenantId: fleet.tenantOf(taskId), taskId });
      try {
        await stopChecks(fleet.machine(lease.machineId), taskId, signal);
      } finally {
        await lease.release();
      }
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }
}

/** Stops every check of a task on one machine: their PID namespaces, whole. */
async function stopChecks(
  machine: RemoteMachine,
  taskId: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const out = await machine.exec(CHECK_STOP_SCRIPT, {
    envs: { MAKA_CHECK_TAG: checkTagPrefix(taskId) },
    timeoutSeconds: 30,
    ...(signal ? { signal } : {}),
  });
  const status = out.stdout.trim();
  if (status !== 'NONE' && status !== 'STOPPED') {
    throw new Error(`the checks of ${taskId} could not be stopped (${status.slice(0, 200)})`);
  }
}
