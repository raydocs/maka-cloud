import type { Fleet, RemoteMachine } from '@maka-cloud/runners';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The sandbox cut the output short. */
  truncated?: boolean;
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
        };
      },
      stopAll: async (stopSignal) => {
        await machine.kill(taskId, stopSignal ? { signal: stopSignal } : {});
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
    await this.fleet.stopTask(taskId, signal);
  }
}
