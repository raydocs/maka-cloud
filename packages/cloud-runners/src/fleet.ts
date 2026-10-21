import { createHash, randomUUID } from 'node:crypto';
import type { InstaboxClient } from '@maka-cloud/instabox';
import type { TaskId } from '@maka-cloud/orchestrator';
import { DEFAULT_EXPORT_LIMITS, type ExportLimits } from './export.js';
import type { InputPolicy } from './inputs.js';
import {
  DEFAULT_LOG_ROOT,
  DEFAULT_STAGE_LIMITS,
  RemoteMachine,
  type StageLimits,
} from './machine.js';
import { MachinePoller, type PollBackoff } from './poller.js';
import { type AgentChannel, assertAgentChannel, checkAgentIsolation } from './agent-user.js';
import type { AgentSdk } from './sdk-turn.js';
import { DEFAULT_TENANT, noModelAccess } from './providers.js';
import { buildRunScript, cliCheckScript } from './scripts.js';
import { MemorySessionStore, referencedSnapshotIds } from './session-store.js';
import { errorMessage, shq } from './shell.js';
import type {
  ModelAccessProvider,
  RunnerSessionRecord,
  RunnerSessionStore,
  SandboxProvider,
  SandboxTool,
} from './types.js';
import type { TokenPrices, VendorAdapter } from './vendors.js';

export type RunnerName = 'claude-agent-sdk' | 'codex';

export interface CloudRunnersOptions {
  client: InstaboxClient;
  sandboxes: SandboxProvider;
  /**
   * Where each run gets its model key: the model gateway, with a token per run. Default: none, so
   * every run fails to start. Nothing in this package hands a sandbox a vendor key.
   */
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
  /**
   * Which tenant a task belongs to. Default: the single tenant. It throws for a task it cannot
   * place, and that task fails to start without a machine being asked for.
   */
  tenantOf?: (taskId: TaskId) => string;
  /** Maps the orchestrator's MCP URL to one the sandbox can reach. Default: unchanged. */
  mcpUrlForSandbox?: (url: string) => string;
  /** CLI versions to install. Defaults are pinned in the vendor adapters. */
  versions?: Partial<Record<RunnerName, string>>;
  /** Replaces the install step (it must leave the CLI on PATH, in `$HOME/.maka-cli/bin`). */
  installCommands?: Partial<Record<RunnerName, string>>;
  models?: Partial<Record<RunnerName, string>>;
  /**
   * Programs to put on every run's PATH in the sandbox (for example `cite-check`), installed once
   * per sandbox before a run starts and again when their content changes.
   */
  sandboxTools?: SandboxTool[];
  /**
   * Lets a task start with files of other tasks (`maka-inputs:` lines at the start of its brief).
   * Without it a brief that asks for inputs fails the task. `sameConversationInputPolicy` is the
   * usual choice.
   */
  inputs?: InputPolicy;
  /** Caps on the files one task may take from others. Defaults: 200 files, 5 MiB each, 32 MiB in all. */
  inputLimits?: Partial<StageLimits>;
  /**
   * Caps on the artifacts a task's result exports to its handoff directory. Defaults: 20 files,
   * 2 MiB each, 8 MiB in all.
   */
  exportLimits?: Partial<ExportLimits>;
  /**
   * Token prices for metering each run's spend against its budget, per runner. Defaults:
   * `DEFAULT_PRICES`. Claude's CLI also reports its own total at the end of each invocation.
   */
  prices?: Partial<Record<RunnerName, TokenPrices>>;
  pollIntervalMs?: number;
  /**
   * The Claude Agent SDK. With it the Claude runner drives its CLI through the SDK (hooks write the
   * task's step log, and the SDK owns the conversation); without it, it runs the CLI directly.
   * `loadAgentSdk()` loads the installed one.
   */
  agentSdk?: AgentSdk;
  /**
   * The account the CLI runs as when driven by the SDK, so that nothing the agent runs can write
   * the channel the SDK trusts. Required with `agentSdk`: without it SDK runs are refused. Each
   * machine is checked once (`checkAgentIsolation`) before it runs one.
   */
  agentChannel?: AgentChannel;
  /**
   * How often a run driven by the SDK is polled: every hook the CLI waits for costs a poll, so
   * these runs are polled much faster than `pollIntervalMs` while output is coming, and back off
   * (doubling) towards `maxMs` while it is quiet. Default 150 ms and 1 s.
   */
  agentSdkPollMs?: PollBackoff;
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
  /**
   * A page the agent fetched and got an answer for (T24 sources card). Only pages the CLI's own
   * tool reported as fetched come here, never a URL in the agent's text. A throw is ignored.
   */
  onOpenedPage?(taskId: TaskId, url: string): void;
  /** A cleanup step that failed or timed out. Cleanup goes on; this is how it is seen. */
  onCleanupError?(failure: { taskId: TaskId; step: string; error: unknown }): void;
  now?: () => number;
}

const SETUP_TIMEOUT_MS = 15 * 60_000;
const TOOL_NAME = /^[a-z][a-z0-9-]{0,40}$/u;
const MAX_TOOL_BYTES = 8 * 1024 * 1024;

interface PreparedTool {
  name: string;
  content: Buffer;
  hash: string;
}

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
  private readonly isolationChecks = new Map<string, Promise<void>>();
  private readonly setups = new Map<string, Promise<void>>();
  private readonly tools: PreparedTool[];
  private recordChain: Promise<unknown> = Promise.resolve();
  private lastCaptureStamp = 0;

  constructor(readonly options: CloudRunnersOptions) {
    this.client = options.client;
    this.sandboxes = options.sandboxes;
    this.modelAccess = options.modelAccess ?? noModelAccess();
    this.sessions = options.sessions ?? new MemorySessionStore();
    this.root = (options.workRoot ?? '/data/work').replace(/\/+$/u, '');
    this.logRoot = (options.logRoot ?? DEFAULT_LOG_ROOT).replace(/\/+$/u, '');
    // The log directory of a task is deleted as a whole, so it must be a path of its own.
    if (!this.logRoot.startsWith('/')) throw new Error('logRoot must be an absolute path');
    this.now = options.now ?? Date.now;
    this.tools = prepareTools(options.sandboxTools ?? []);
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
      machine = new RemoteMachine(
        this.client,
        machineId,
        this.root,
        this.logRoot,
        this.options.agentChannel?.user,
      );
      this.machines.set(machineId, machine);
    }
    return machine;
  }

  /** Checks once per machine that it keeps the agent channel private; a failed check is repeated on the next run. */
  ensureAgentIsolation(machine: RemoteMachine, signal?: AbortSignal): Promise<void> {
    const channel = this.options.agentChannel;
    if (channel === undefined) return Promise.reject(new Error('no agent channel is configured'));
    assertAgentChannel(channel);
    let checked = this.isolationChecks.get(machine.machineId);
    if (!checked) {
      checked = checkAgentIsolation(machine, channel, signal);
      this.isolationChecks.set(machine.machineId, checked);
      checked.catch(() => this.isolationChecks.delete(machine.machineId));
    }
    return checked;
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

  /** Installs the sandbox tools the machine does not have yet. Concurrent callers share each install. */
  async ensureTools(machine: RemoteMachine): Promise<void> {
    for (const tool of this.tools) await this.ensureTool(machine, tool);
  }

  get exportLimits(): ExportLimits {
    return { ...DEFAULT_EXPORT_LIMITS, ...this.options.exportLimits };
  }

  get stageLimits(): StageLimits {
    return { ...DEFAULT_STAGE_LIMITS, ...this.options.inputLimits };
  }

  private ensureTool(machine: RemoteMachine, tool: PreparedTool): Promise<void> {
    const key = `${machine.machineId}|tool|${tool.name}`;
    let pending = this.setups.get(key);
    if (!pending) {
      pending = this.installTool(machine, tool).finally(() => this.setups.delete(key));
      this.setups.set(key, pending);
    }
    return pending;
  }

  private async installTool(machine: RemoteMachine, tool: PreparedTool): Promise<void> {
    const marker = `${machine.root}/.setup/tool-${tool.name}.sha256`;
    try {
      if (await machine.hasTool(tool.name, tool.hash, marker)) return;
      await machine.installTool({
        name: tool.name,
        content: tool.content,
        hash: tool.hash,
        marker,
        tmpName: `.${tool.name}.${randomUUID()}.tmp`,
      });
    } catch (error) {
      throw new Error(`installing ${tool.name} in the sandbox failed (${errorMessage(error)})`);
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
   *
   * "Newest" is the order in which the snapshots were requested, a stamp taken before the request
   * is sent. It is not the order in which their uploads finish: a snapshot that is slow to become
   * ready was still captured before the ones requested after it, and files written after its
   * capture are not in it. So a record is only ever moved to a snapshot requested no earlier than
   * the one it points at.
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
    const capturedAt = this.captureStamp();
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
      ({ next, evicted } = await this.exclusive(() =>
        this.addSnapshot(record, machine, ready.id, capturedAt),
      ));
    } catch (error) {
      await this.deleteIfUnreferenced([ready.id]).catch(() => undefined);
      throw error;
    }
    await this.deleteIfUnreferenced(evicted).catch(() => undefined);
    return { record: next, snapshotId: ready.id };
  }

  /** A stamp that is above every earlier one, taken right before a snapshot is requested. */
  private captureStamp(): number {
    this.lastCaptureStamp = Math.max(this.now(), this.lastCaptureStamp + 1);
    return this.lastCaptureStamp;
  }

  /**
   * Inside `exclusive`: files `snapshotId` (requested at `capturedAt`) under the task, evicts the
   * oldest-requested beyond the retention.
   */
  private async addSnapshot(
    record: RunnerSessionRecord,
    machine: RemoteMachine,
    snapshotId: string,
    capturedAt: number,
  ): Promise<{ next: RunnerSessionRecord; evicted: string[] }> {
    const current = await this.sessions.get(record.taskId);
    const snapshotAt = { ...(current?.snapshotAt ?? record.snapshotAt), [snapshotId]: capturedAt };
    const mine: RunnerSessionRecord = {
      ...record,
      snapshotIds: [...(current?.snapshotIds ?? record.snapshotIds), snapshotId].sort(
        (a, b) => (snapshotAt[a] ?? 0) - (snapshotAt[b] ?? 0),
      ),
      snapshotAt,
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
      // `newest` was requested last of all of them, so it is never older than a record's own.
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

function prepareTools(tools: readonly SandboxTool[]): PreparedTool[] {
  const seen = new Set<string>(['claude', 'codex']);
  return tools.map((tool) => {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`Invalid sandbox tool name: ${tool.name}`);
    if (seen.has(tool.name)) throw new Error(`Sandbox tool name is taken: ${tool.name}`);
    seen.add(tool.name);
    const content = Buffer.from(tool.content);
    if (content.length === 0 || content.length > MAX_TOOL_BYTES) {
      throw new Error(
        `Sandbox tool ${tool.name} must be between 1 byte and ${MAX_TOOL_BYTES} bytes`,
      );
    }
    return { name: tool.name, content, hash: createHash('sha256').update(content).digest('hex') };
  });
}

export interface SweepResult {
  stopped: TaskId[];
  failed: { machineId: string; taskId?: TaskId; error: string }[];
}
