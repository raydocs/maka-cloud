import { randomUUID } from 'node:crypto';
import type { InstaboxClient } from '@maka-cloud/instabox';
import type { TaskId } from '@maka-cloud/orchestrator';
import { DEFAULT_LOG_ROOT, RemoteMachine } from './machine.js';
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
  /**
   * Directory in the sandbox for the raw output of the CLI, which can contain secrets. It must be
   * memory-backed (tmpfs), so that a snapshot of the sandbox's files never holds it: a run
   * refuses to start otherwise. Default `/dev/shm/maka-logs`.
   */
  logRoot?: string;
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
  /** Snapshots kept per machine, across all its tasks. Default 2. */
  keepSnapshots?: number;
  /** Snapshot the sandbox after each turn. Default true. */
  snapshots?: boolean;
  snapshotTimeoutMs?: number;
  /** How long a started run may stay in "starting". */
  startTimeoutMs?: number;
  setupTimeoutMs?: number;
  /** Progress notes reported per run. Default 300. */
  maxProgressNotes?: number;
  /** How long one step of a run's cleanup may take before the next one goes ahead. Default 20 s. */
  cleanupTimeoutMs?: number;
  /** How long a stopped run's processes get to exit on TERM before they are killed. Default 3 s. */
  stopGraceMs?: number;
  /** A cleanup step that failed or timed out. Cleanup goes on; this is how it is seen. */
  onCleanupError?(failure: { taskId: TaskId; step: string; error: unknown }): void;
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
  /** Activity lease renewal timers running. Zero when nothing is in flight. */
  leaseRenewals = 0;
  readonly logRoot: string;
  private readonly machines = new Map<string, RemoteMachine>();
  private readonly setups = new Map<string, Promise<void>>();
  private recordChain: Promise<unknown> = Promise.resolve();
  private lastSnapshotAt = 0;

  constructor(readonly options: CloudRunnersOptions) {
    this.client = options.client;
    this.sandboxes = options.sandboxes;
    this.modelAccess = options.modelAccess ?? envModelAccess();
    this.sessions = options.sessions ?? new MemorySessionStore();
    this.root = (options.workRoot ?? '/data/work').replace(/\/+$/u, '');
    this.logRoot = (options.logRoot ?? DEFAULT_LOG_ROOT).replace(/\/+$/u, '');
    // The log directory of a task is deleted as a whole, so it must be a path of its own.
    if (!this.logRoot.startsWith('/')) throw new Error('logRoot must be an absolute path');
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
      machine = new RemoteMachine(this.client, machineId, this.root, this.logRoot);
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
      rawLogs: false,
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

  // -- session records ------------------------------------------------------------------------

  /**
   * Runs `work` after every earlier exclusive section has ended. Every read-modify-write of the
   * session records goes through here, so two runs on one machine never overwrite each other's
   * record (retention edits the records of other tasks).
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.recordChain.catch(() => undefined).then(work);
    this.recordChain = run;
    return run;
  }

  /** Reads a task's record, changes it, and writes it back, with nobody in between. */
  updateRecord(
    taskId: TaskId,
    change: (current: RunnerSessionRecord | undefined) => RunnerSessionRecord,
  ): Promise<RunnerSessionRecord> {
    return this.exclusive(async () => {
      const next = change(await this.sessions.get(taskId));
      await this.sessions.put(next);
      return next;
    });
  }

  // -- snapshots -----------------------------------------------------------------------------

  /**
   * Snapshots the machine, records the snapshot in the task's record, and trims the machine's
   * snapshots to the newest `keepSnapshots`. A snapshot holds the whole machine, so any task on
   * it can be restored from the newest one: records that pointed at an evicted snapshot are moved
   * to the newest, and an evicted snapshot is deleted only once no record points at it.
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
    let ready;
    try {
      ready = await this.client.waitForSnapshot(created.id, {
        deadlineMs: this.options.snapshotTimeoutMs ?? 5 * 60_000,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // No record points at it and none ever will; it would sit in the account forever.
      await this.client.deleteSnapshot(created.id).catch(() => undefined);
      throw error;
    }

    let evicted: string[];
    let next: RunnerSessionRecord;
    try {
      ({ next, evicted } = await this.exclusive(() => this.addSnapshot(record, machine, ready.id)));
    } catch (error) {
      await this.deleteIfUnreferenced([ready.id]).catch(() => undefined);
      throw error;
    }
    await this.deleteIfUnreferenced(evicted).catch(() => undefined);
    return { record: next, snapshotId: ready.id };
  }

  /** Inside `exclusive`: files `snapshotId` under the task, evicts the oldest beyond the retention. */
  private async addSnapshot(
    record: RunnerSessionRecord,
    machine: RemoteMachine,
    snapshotId: string,
  ): Promise<{ next: RunnerSessionRecord; evicted: string[] }> {
    const current = await this.sessions.get(record.taskId);
    this.lastSnapshotAt = Math.max(this.now(), this.lastSnapshotAt + 1);
    const mine: RunnerSessionRecord = {
      ...record,
      snapshotIds: [...(current?.snapshotIds ?? record.snapshotIds), snapshotId],
      snapshotAt: {
        ...(current?.snapshotAt ?? record.snapshotAt),
        [snapshotId]: this.lastSnapshotAt,
      },
      updatedAt: this.now(),
    };
    const onMachine = [
      mine,
      ...(await this.sessions.list()).filter(
        (other) => other.taskId !== mine.taskId && other.machineId === machine.machineId,
      ),
    ];
    const takenAt = new Map<string, number>();
    for (const other of onMachine) {
      for (const id of other.snapshotIds) {
        takenAt.set(id, Math.max(takenAt.get(id) ?? 0, other.snapshotAt?.[id] ?? 0));
      }
    }
    const oldestFirst = [...takenAt.keys()].sort(
      (a, b) => (takenAt.get(a) ?? 0) - (takenAt.get(b) ?? 0),
    );
    const keep = Math.max(1, this.options.keepSnapshots ?? 2);
    const evicted = oldestFirst.slice(0, Math.max(0, oldestFirst.length - keep));
    const newest = oldestFirst.at(-1) as string;

    let next = mine;
    for (const other of onMachine) {
      const kept = other.snapshotIds.filter((id) => !evicted.includes(id));
      if (other !== mine && kept.length === other.snapshotIds.length) continue;
      const snapshotIds = kept.length > 0 ? kept : other.snapshotIds.length > 0 ? [newest] : [];
      const snapshotAt = Object.fromEntries(
        snapshotIds.map((id) => [id, takenAt.get(id) ?? 0] as const),
      );
      const updated: RunnerSessionRecord = { ...other, snapshotIds, snapshotAt };
      await this.sessions.put(updated);
      if (other === mine) next = updated;
    }
    return { next, evicted };
  }

  /** Deletes snapshots no record points at (any machine's record counts). */
  private async deleteIfUnreferenced(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const referenced = referencedSnapshotIds(await this.exclusive(() => this.sessions.list()));
    for (const id of ids) {
      if (referenced.has(id)) continue;
      await this.client.deleteSnapshot(id).catch(() => undefined);
    }
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
