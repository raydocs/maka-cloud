import { randomUUID } from 'node:crypto';
import type { InstaboxClient } from '@maka-cloud/instabox';
import type { TaskId } from '@maka-cloud/orchestrator';
import { RemoteMachine } from './machine.js';
import { MachinePoller } from './poller.js';
import { DEFAULT_TENANT, envModelAccess } from './providers.js';
import { buildRunScript, cliCheckScript } from './scripts.js';
import { MemorySessionStore, referencedSnapshotIds } from './session-store.js';
import { errorMessage, shq } from './shell.js';
import type {
  ModelAccessProvider,
  RunnerSessionRecord,
  RunnerSessionStore,
  SandboxProvider,
} from './types.js';
import type { VendorAdapter } from './vendors.js';

export type RunnerName = 'claude-agent-sdk' | 'codex';

export interface CloudRunnersOptions {
  client: InstaboxClient;
  sandboxes: SandboxProvider;
  /** Default: keys from the environment. */
  modelAccess?: ModelAccessProvider;
  /** Default: in memory. Use `JsonFileSessionStore` for resume across restarts. */
  sessions?: RunnerSessionStore;
  /** Directory in the sandbox that holds one folder per task. Default `/data/work`. */
  workRoot?: string;
  /** Which tenant a task belongs to. Default: the single tenant. */
  tenantOf?: (taskId: TaskId) => string;
  /** Maps the orchestrator's MCP URL to one the sandbox can reach. Default: unchanged. */
  mcpUrlForSandbox?: (url: string) => string;
  /** CLI versions to install. Defaults are pinned in the vendor adapters. */
  versions?: Partial<Record<RunnerName, string>>;
  /** Replaces the install step (it must leave the CLI on PATH, in `$HOME/.maka-cli/bin`). */
  installCommands?: Partial<Record<RunnerName, string>>;
  models?: Partial<Record<RunnerName, string>>;
  pollIntervalMs?: number;
  /** Consecutive failed polls before a run fails with "sandbox unreachable". */
  pollMaxFailures?: number;
  leaseTtlSeconds?: number;
  /** Snapshots kept per task. Default 2. */
  keepSnapshots?: number;
  /** Snapshot the sandbox after each turn. Default true. */
  snapshots?: boolean;
  snapshotTimeoutMs?: number;
  /** How long a started run may stay in "starting". */
  startTimeoutMs?: number;
  setupTimeoutMs?: number;
  /** Progress notes reported per run. Default 300. */
  maxProgressNotes?: number;
  now?: () => number;
}

const SETUP_TIMEOUT_MS = 15 * 60_000;

/** State shared by the runners of one deployment. */
export class Fleet {
  readonly client: InstaboxClient;
  readonly sandboxes: SandboxProvider;
  readonly modelAccess: ModelAccessProvider;
  readonly sessions: RunnerSessionStore;
  readonly root: string;
  readonly poller: MachinePoller;
  readonly now: () => number;
  /** Runs between their start and their cleanup. Zero when nothing is in flight. */
  openRuns = 0;
  private readonly machines = new Map<string, RemoteMachine>();
  private readonly setups = new Map<string, Promise<void>>();

  constructor(readonly options: CloudRunnersOptions) {
    this.client = options.client;
    this.sandboxes = options.sandboxes;
    this.modelAccess = options.modelAccess ?? envModelAccess();
    this.sessions = options.sessions ?? new MemorySessionStore();
    this.root = (options.workRoot ?? '/data/work').replace(/\/+$/u, '');
    this.now = options.now ?? Date.now;
    this.poller = new MachinePoller({
      intervalMs: options.pollIntervalMs ?? 2_000,
      ...(options.pollMaxFailures === undefined ? {} : { maxFailures: options.pollMaxFailures }),
    });
  }

  tenantOf(taskId: TaskId): string {
    return this.options.tenantOf?.(taskId) ?? DEFAULT_TENANT;
  }

  machine(machineId: string): RemoteMachine {
    let machine = this.machines.get(machineId);
    if (!machine) {
      machine = new RemoteMachine(this.client, machineId, this.root);
      this.machines.set(machineId, machine);
    }
    return machine;
  }

  leaseId(taskId: TaskId): string {
    return `maka-${taskId}`;
  }

  // -- CLI install ---------------------------------------------------------------------------

  /** Installs the pinned CLI once per machine. Concurrent callers share one install. */
  ensureCli(machine: RemoteMachine, vendor: VendorAdapter): Promise<void> {
    const key = `${machine.machineId}|${vendor.name}`;
    let pending = this.setups.get(key);
    if (!pending) {
      pending = this.installCli(machine, vendor).finally(() => this.setups.delete(key));
      this.setups.set(key, pending);
    }
    return pending;
  }

  private async installCli(machine: RemoteMachine, vendor: VendorAdapter): Promise<void> {
    const version = this.options.versions?.[vendor.name] ?? vendor.defaultVersion;
    const marker = `${machine.root}/.setup/${vendor.binary}-${version}.ok`;
    const check = await machine.exec(cliCheckScript(vendor.binary), {
      envs: { MAKA_MARKER: marker, MAKA_VERSION: version },
    });
    if (check.exitCode === 0) return;

    const install =
      this.options.installCommands?.[vendor.name] ??
      `command -v npm >/dev/null 2>&1 || { echo "npm is not installed in the sandbox image"; exit 1; }
npm install -g --prefix "$HOME/.maka-cli" --no-audit --no-fund ${shq(`${vendor.npmPackage}@${version}`)}`;
    const script = buildRunScript({
      preamble: '',
      command: `( set -e
${install}
mkdir -p "$(dirname ${shq(marker)})"
: > ${shq(marker)}
)`,
    });
    const dirName = `.setup-${vendor.binary}`;
    const run = `i-${version}`;
    await machine.launch({
      dirName,
      run,
      script,
      envs: {},
      runToken: randomUUID(),
      workdir: machine.taskDir(dirName),
    });

    const watch = this.poller.watch(machine, { dir: dirName, run });
    const deadline = this.now() + (this.options.setupTimeoutMs ?? SETUP_TIMEOUT_MS);
    let output = '';
    let consumed = 0;
    try {
      for (;;) {
        if (this.now() > deadline) throw new Error('timed out');
        const update = await watch.next();
        output = (output + update.data.toString('utf8')).slice(-1_500);
        consumed += update.data.length;
        const state = update.state;
        if (typeof state === 'object' && consumed >= update.size) {
          if (state.exit === 0) return;
          throw new Error(`exit ${state.exit}: ${output.trim()}`);
        }
        if (state === 'dead' && consumed >= update.size)
          throw new Error(`the install was killed: ${output.trim()}`);
      }
    } catch (error) {
      // Drop the lock so the next task tries again instead of waiting on a finished failure.
      await machine.removeDir(dirName).catch(() => undefined);
      throw new Error(
        `installing ${vendor.binary}@${version} in the sandbox failed (${errorMessage(error)})`,
      );
    } finally {
      watch.stop();
    }
  }

  // -- snapshots -----------------------------------------------------------------------------

  /**
   * Snapshots the machine, records the snapshot in the task's record, and deletes older ones of
   * this task beyond the retention. A snapshot some record still points at is never deleted:
   * retention covers a whole machine, shared by every task on it.
   */
  async snapshotTurn(
    record: RunnerSessionRecord,
    machine: RemoteMachine,
    signal?: AbortSignal,
  ): Promise<{ record: RunnerSessionRecord; snapshotId: string }> {
    const name = `maka-${record.taskId}-t${record.turns}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/gu, '-')
      .slice(0, 63)
      .replace(/-+$/u, '');
    const created = await this.client.createSnapshot(
      machine.machineId,
      { name, description: `task ${record.taskId}, turn ${record.turns}` },
      signal ? { signal } : {},
    );
    const ready = await this.client.waitForSnapshot(created.id, {
      deadlineMs: this.options.snapshotTimeoutMs ?? 5 * 60_000,
      ...(signal ? { signal } : {}),
    });
    const keep = Math.max(1, this.options.keepSnapshots ?? 2);
    const ids = [...record.snapshotIds, ready.id];
    const dropped = ids.slice(0, Math.max(0, ids.length - keep));
    const next: RunnerSessionRecord = {
      ...record,
      snapshotIds: ids.slice(dropped.length),
      updatedAt: this.now(),
    };
    await this.sessions.put(next);
    const referenced = referencedSnapshotIds(await this.sessions.list());
    for (const id of dropped) {
      if (referenced.has(id)) continue;
      await this.client.deleteSnapshot(id).catch(() => undefined);
    }
    return { record: next, snapshotId: ready.id };
  }

  // -- leftovers after a restart ---------------------------------------------------------------

  /** Stops whatever runs for `taskId`, found by id alone. Idempotent. */
  async stopTask(taskId: TaskId, signal?: AbortSignal): Promise<boolean> {
    const record = await this.sessions.get(taskId);
    const machineIds = record ? [record.machineId] : await this.sandboxes.knownMachines();
    let stopped = false;
    let failure: unknown;
    for (const machineId of machineIds) {
      try {
        const machine = this.machine(machineId);
        const runs = await machine.kill(taskId, signal ? { signal } : {});
        if (runs.length > 0) stopped = true;
        await this.client
          .deleteActivityLease(machineId, this.leaseId(taskId), signal ? { signal } : {})
          .catch(() => undefined);
      } catch (error) {
        failure ??= error;
      }
    }
    await this.modelAccess.revokeForTask?.(taskId);
    if (failure !== undefined) throw failure;
    return stopped;
  }

  /**
   * Stops live runs whose task is not in `knownTaskIds` (for example a crash between starting the
   * CLI and recording `task_started`). Never throws for an unreachable sandbox.
   */
  async sweepOrphans(
    knownTaskIds: Iterable<TaskId>,
    options: { timeoutMs?: number } = {},
  ): Promise<SweepResult> {
    const known = new Set(knownTaskIds);
    const machineIds = new Set<string>(await this.sandboxes.knownMachines());
    for (const record of await this.sessions.list()) machineIds.add(record.machineId);
    const result: SweepResult = { stopped: [], failed: [] };
    await Promise.all(
      [...machineIds].map(async (machineId) => {
        const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
        try {
          const machine = this.machine(machineId);
          for (const dir of await machine.liveTaskDirs(signal)) {
            if (known.has(dir)) continue;
            try {
              await machine.kill(dir, { signal });
              await this.client
                .deleteActivityLease(machineId, this.leaseId(dir))
                .catch(() => undefined);
              await this.modelAccess.revokeForTask?.(dir);
              result.stopped.push(dir);
            } catch (error) {
              result.failed.push({ machineId, taskId: dir, error: errorMessage(error) });
            }
          }
        } catch (error) {
          result.failed.push({ machineId, error: errorMessage(error) });
        }
      }),
    );
    return result;
  }
}

export interface SweepResult {
  stopped: TaskId[];
  failed: { machineId: string; taskId?: TaskId; error: string }[];
}
