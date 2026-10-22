import {
  type AgentChannel,
  asAgentScript,
  asRootScript,
  type Fleet,
  type RemoteMachine,
} from '@maka-cloud/runners';
import { BASE_RESTORE_SCRIPT, CHECK_STOP_SCRIPT, checkTagPrefix } from './scripts.js';

/** What CHECK_STOP_SCRIPT reads from its environment. */
const CHECK_STOP_ENV = ['MAKA_CHECK_TAG', 'MAKA_CHECK_UP_TO'];

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
  /**
   * Runs a check (a repository's own test command, which is the agent's code) as the agent's
   * account, never as the sandbox user who holds the channel, the task's files and the egress
   * rules. It fails, running nothing, where no agent account is configured or the box does not
   * keep it out.
   */
  execCheck(script: string, options?: ExecOptions): Promise<ExecResult>;
  /** Ends checks run by `execCheck`: their processes belong to the agent's account, so this runs as root. */
  execCheckStop(script: string, options?: ExecOptions): Promise<ExecResult>;
  /** Stops every process of the task: agent runs and checks. Idempotent. */
  stopAll(signal?: AbortSignal): Promise<void>;
  /** Whether the agent's runs for this task ran on this workspace's machine. */
  agentOnSameMachine(): Promise<boolean>;
  /** Gives the sandbox lease back. Idempotent. */
  release(): Promise<void>;
}

export interface CodingSandbox {
  /** `attempt`: the attempt (epoch) of the run that opens it; its stop leaves a later attempt's runs alone. */
  open(taskId: string, signal?: AbortSignal, attempt?: number): Promise<SandboxWorkspace>;
  /** Stops whatever a task left running, found by id alone (after a restart). Idempotent. */
  stopTask(taskId: string, signal?: AbortSignal, upToAttempt?: number): Promise<void>;
}

/**
 * The sandbox of the T6 runners: the same tenant machine, the same task directory and the same
 * task-wide stop, so the agent's runs and the runner's checks share one workspace.
 */
export class FleetCodingSandbox implements CodingSandbox {
  constructor(private readonly fleet: Fleet) {}

  async open(taskId: string, signal?: AbortSignal, attempt?: number): Promise<SandboxWorkspace> {
    const { fleet } = this;
    const lease = await fleet.sandboxes.acquire({ tenantId: fleet.tenantOf(taskId), taskId });
    if (signal?.aborted) {
      await lease.release();
      throw signal.reason;
    }
    const machine: RemoteMachine = fleet.machine(lease.machineId);
    let released = false;
    const channel = fleet.options.agentChannel;
    const run = async (
      script: string,
      options: ExecOptions,
      taskCode = true,
    ): Promise<ExecResult> => {
      // Whatever runs in the workspace is the task's code: the egress guard is checked before it.
      // The agent's group goes to every script, for the ones that hand files to the agent.
      const envs =
        channel === undefined ? options.envs : { ...options.envs, MAKA_AGENT_GROUP: channel.group };
      const result = await machine.exec(script, {
        ...options,
        ...(envs === undefined ? {} : { envs }),
        taskCode,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };
    };
    return {
      dir: machine.taskDir(taskId),
      // Putting the change back after a base check is the host's own fixed script: like the check
      // stop, it must reach a box whose guard now fails, or the change stays in the backup.
      exec: (script, options = {}) => run(script, options, script !== BASE_RESTORE_SCRIPT),
      execCheck: async (script, options = {}) => {
        if (channel === undefined) {
          throw new Error('checks run as the agent account, and none is configured');
        }
        await fleet.ensureAgentIsolation(machine, options.signal);
        // The task directory and workspace belong to the agent's group before its tests enter them.
        await machine.prepareAgent(taskId, channel.group, options.signal);
        return run(asAgentScript(script, channel, Object.keys(options.envs ?? {})), options);
      },
      // The host's own stop, not task code: it must reach a box whose guard now fails.
      execCheckStop: (script, options = {}) =>
        run(channel === undefined ? script : asRootScript(script, CHECK_STOP_ENV), options, false),
      stopAll: async (stopSignal) => {
        await machine.kill(taskId, {
          ...(stopSignal ? { signal: stopSignal } : {}),
          ...(attempt === undefined ? {} : { upToAttempt: attempt }),
        });
        await stopChecks(machine, taskId, stopSignal, channel, attempt);
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

  async stopTask(taskId: string, signal?: AbortSignal, upToAttempt?: number): Promise<void> {
    const { fleet } = this;
    let failure: unknown;
    await fleet.stopTask(taskId, signal, upToAttempt).catch((error: unknown) => {
      failure = error;
    });
    // The checks ran on the machine the task's lease gives, as in open().
    try {
      const lease = await fleet.sandboxes.acquire({ tenantId: fleet.tenantOf(taskId), taskId });
      try {
        await stopChecks(
          fleet.machine(lease.machineId),
          taskId,
          signal,
          fleet.options.agentChannel,
          upToAttempt,
        );
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
  channel: AgentChannel | undefined,
  upToAttempt?: number,
): Promise<void> {
  // A bound that is not a whole attempt number would make the script stop everything.
  if (upToAttempt !== undefined && !Number.isSafeInteger(upToAttempt)) {
    throw new Error(`not an attempt number: ${upToAttempt}`);
  }
  const out = await machine.exec(
    channel === undefined ? CHECK_STOP_SCRIPT : asRootScript(CHECK_STOP_SCRIPT, CHECK_STOP_ENV),
    {
      envs: {
        MAKA_CHECK_TAG: checkTagPrefix(taskId),
        ...(upToAttempt === undefined ? {} : { MAKA_CHECK_UP_TO: String(upToAttempt) }),
      },
      timeoutSeconds: 30,
      ...(signal ? { signal } : {}),
    },
  );
  const status = out.stdout.trim();
  if (status !== 'NONE' && status !== 'STOPPED') {
    throw new Error(
      `the checks of ${taskId} could not be stopped (${status.slice(0, 200)}${out.stderr.trim() ? ` ${out.stderr.trim().slice(0, 200)}` : ''})`,
    );
  }
}
