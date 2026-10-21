import {
  InstaboxApiError,
  type InstaboxExecResult,
  type InstaboxMachine,
  type InstaboxOperation,
  type InstaboxSnapshot,
} from '@maka-cloud/instabox';
import type { BoxApi } from '../types.js';

type Method =
  | 'createMachine'
  | 'patchMachineMetadata'
  | 'getMachine'
  | 'deleteMachine'
  | 'listMachines'
  | 'exec'
  | 'suspendMachine'
  | 'ensureRunning'
  | 'createSnapshot'
  | 'listSnapshots'
  | 'deleteSnapshot'
  | 'waitForSnapshot';

export interface FakeBox extends InstaboxMachine {
  metadata: Record<string, string>;
  snapshot: { id: string } | null;
}

/**
 * An in-memory instabox account for the pool: machines with names, labels and states, an account
 * sandbox limit, and gates a test can close on any call to hold it half way (a handshake, not a
 * sleep).
 */
export class FakeFleet implements BoxApi {
  readonly machines = new Map<string, FakeBox>();
  readonly calls: { method: Method | 'waitForOperation'; args: unknown[] }[] = [];
  /** The most live sandboxes the account may have (all of them, pool or not). */
  accountLimit = Number.POSITIVE_INFINITY;
  /** Machine states a created sandbox goes through; the fake finishes at once. */
  failNextCreate: { status: number; code: string; message?: string } | undefined;
  failNextOperation = false;
  /** What each `ensureRunning` call does, in order; `ok` when the script runs out. */
  wakeScript: ('ok' | 'hang' | 'fail' | 'gone')[] = [];
  /** The suspend is accepted but the operation fails, once. */
  failNextSuspend = false;
  /** Every command run on a box. */
  readonly execLog: { machineId: string; cmd: string }[] = [];
  /** Makes `exec` fail, once. */
  failNextExec = false;
  /** Decides the result of a command; the default is exit 0 with no output. */
  execHandler:
    | ((
        machineId: string,
        request: { cmd: string; envs?: Record<string, string> },
      ) => Partial<InstaboxExecResult>)
    | undefined;
  readonly snapshots = new Map<string, InstaboxSnapshot & { createdAt: string }>();
  /** The next snapshot ends up `failed`. */
  failNextSnapshot = false;
  /** Full requests of every exec, for the environment they carried. */
  readonly execRequests: { machineId: string; cmd: string; envs: Record<string, string> }[] = [];
  /** Alters a created machine's labels, to look like a box that is not what was asked for. */
  tamper: ((machine: FakeBox) => void) | undefined;
  private counter = 0;
  private readonly failedOperations = new Set<string>();
  private readonly keys = new Map<string, string>();
  private readonly gates = new Map<Method, Gate[]>();

  /** Holds the next call of `method` until `release()`; `reached` resolves when the call is held. */
  hold(method: Method): { reached: Promise<void>; release(): void } {
    let reached!: () => void;
    let release!: () => void;
    const gate: Gate = {
      reached: new Promise<void>((resolve) => {
        reached = resolve;
      }),
      open: new Promise<void>((resolve) => {
        release = resolve;
      }),
      signal: () => reached(),
    };
    const list = this.gates.get(method) ?? [];
    list.push(gate);
    this.gates.set(method, list);
    return { reached: gate.reached, release };
  }

  /** A machine made outside the pool, or by an earlier process. */
  seed(fields: {
    name: string;
    metadata?: Record<string, string>;
    state?: InstaboxMachine['state'];
  }): FakeBox {
    const machine: FakeBox = {
      id: `m_${++this.counter}`,
      name: fields.name,
      state: fields.state ?? 'running',
      metadata: { ...(fields.metadata ?? {}) },
      snapshot: null,
    };
    this.machines.set(machine.id, machine);
    return machine;
  }

  callsTo(method: Method): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  private async pass(method: Method, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    const gate = this.gates.get(method)?.shift();
    if (gate) {
      gate.signal();
      await gate.open;
    }
  }

  private live(): FakeBox[] {
    return [...this.machines.values()].filter((m) => m.state !== 'deleted');
  }

  async createMachine(
    request: Parameters<BoxApi['createMachine']>[0],
    options: Parameters<BoxApi['createMachine']>[1] = {},
  ): Promise<InstaboxOperation> {
    await this.pass('createMachine', [request, options]);
    if (this.failNextCreate) {
      const { status, code, message } = this.failNextCreate;
      this.failNextCreate = undefined;
      throw new InstaboxApiError(status, { code, message: message ?? code });
    }
    const key = options.idempotencyKey;
    const seen = key ? this.keys.get(key) : undefined;
    if (seen) return operation(seen);
    if (this.live().some((m) => m.name === request.name)) {
      throw new InstaboxApiError(409, { code: 'operation_conflict', message: 'name in use' });
    }
    if (this.live().length >= this.accountLimit) {
      throw new InstaboxApiError(429, {
        code: 'quota_exceeded',
        message: `sandbox limit of ${this.accountLimit} reached`,
      });
    }
    if (this.failNextOperation) {
      // A create that fails before it gets a host leaves no sandbox behind.
      this.failNextOperation = false;
      const failed = `op_failed_${++this.counter}`;
      this.failedOperations.add(failed);
      return {
        id: failed,
        machineId: `m_failed_${this.counter}`,
        type: 'create',
        state: 'failed',
        error: null,
      };
    }
    const machine = this.seed({
      name: request.name ?? `m-${this.counter + 1}`,
      state: 'running',
      ...(request.metadata ? { metadata: request.metadata } : {}),
    });
    machine.snapshot = request.snapshotId ? { id: request.snapshotId } : null;
    this.tamper?.(machine);
    if (key) this.keys.set(key, machine.id);
    return operation(machine.id);
  }

  async waitForOperation(id: string): Promise<InstaboxOperation> {
    this.calls.push({ method: 'waitForOperation', args: [id] });
    if (this.failedOperations.has(id)) {
      throw new Error(`instabox operation ${id} (create) failed: no_capacity`);
    }
    return operation(id.replace(/^op_/, ''));
  }

  async getMachine(id: string): Promise<InstaboxMachine> {
    await this.pass('getMachine', [id]);
    const machine = this.machines.get(id);
    if (!machine || machine.state === 'deleted') {
      throw new InstaboxApiError(404, { code: 'not_found', message: 'no such sandbox' });
    }
    return structuredClone(machine);
  }

  async listMachines(
    options: Parameters<BoxApi['listMachines']>[0] = {},
  ): Promise<InstaboxMachine[]> {
    await this.pass('listMachines', [options]);
    const terms = Object.entries(options?.metadata ?? {});
    return this.live()
      .filter((m) => terms.every(([key, value]) => m.metadata[key] === value))
      .map((m) => structuredClone(m));
  }

  async patchMachineMetadata(
    id: string,
    metadata: Record<string, string>,
  ): Promise<InstaboxMachine> {
    await this.pass('patchMachineMetadata', [id, { ...metadata }]);
    const machine = this.machines.get(id);
    if (!machine || machine.state === 'deleted') {
      throw new InstaboxApiError(404, { code: 'not_found', message: 'no such sandbox' });
    }
    machine.metadata = { ...metadata };
    return structuredClone(machine);
  }

  async exec(
    machineId: string,
    request: { cmd: string; envs?: Record<string, string>; timeoutSeconds?: number },
  ): Promise<InstaboxExecResult> {
    await this.pass('exec', [machineId, request]);
    this.execLog.push({ machineId, cmd: request.cmd });
    this.execRequests.push({ machineId, cmd: request.cmd, envs: { ...(request.envs ?? {}) } });
    if (this.failNextExec) {
      this.failNextExec = false;
      throw new Error('exec failed: connection reset');
    }
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      truncated: false,
      ...(this.execHandler?.(machineId, request) ?? {}),
    };
  }

  async createSnapshot(
    machineId: string,
    request: { name: string; description?: string },
  ): Promise<InstaboxSnapshot> {
    await this.pass('createSnapshot', [machineId, request]);
    if ([...this.snapshots.values()].some((snapshot) => snapshot.name === request.name)) {
      throw new InstaboxApiError(409, { code: 'conflict', message: 'snapshot name in use' });
    }
    const snapshot = {
      id: `sn_${++this.counter}`,
      name: request.name,
      ...(request.description === undefined ? {} : { description: request.description }),
      status: 'pending' as const,
      sourceMachineId: machineId,
      createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, this.counter)).toISOString(),
    };
    this.snapshots.set(snapshot.id, snapshot);
    return { ...snapshot };
  }

  async listSnapshots(): Promise<InstaboxSnapshot[]> {
    await this.pass('listSnapshots', []);
    return [...this.snapshots.values()].map((snapshot) => ({ ...snapshot }));
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.pass('deleteSnapshot', [id]);
    this.snapshots.delete(id);
  }

  async waitForSnapshot(id: string): Promise<InstaboxSnapshot> {
    await this.pass('waitForSnapshot', [id]);
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error(`no snapshot ${id}`);
    if (snapshot.status === 'pending') {
      snapshot.status = this.failNextSnapshot ? 'failed' : 'ready';
      this.failNextSnapshot = false;
    }
    if (snapshot.status === 'failed')
      throw new Error(`instabox snapshot ${id} failed: upload failed`);
    return { ...snapshot };
  }

  async suspendMachine(machineId: string): Promise<InstaboxOperation> {
    await this.pass('suspendMachine', [machineId]);
    const machine = this.machines.get(machineId);
    if (this.failNextSuspend) {
      this.failNextSuspend = false;
      this.failedOperations.add(`op_suspend_${machineId}`);
    } else if (machine) machine.state = 'suspended';
    return {
      id: `op_suspend_${machineId}`,
      machineId,
      type: 'suspend',
      state: 'queued',
      error: null,
    };
  }

  async ensureRunning(machineId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.pass('ensureRunning', [machineId]);
    const machine = this.machines.get(machineId);
    const step = this.wakeScript.shift() ?? 'ok';
    if (step === 'gone' || !machine || machine.state === 'deleted') {
      throw new InstaboxApiError(404, { code: 'not_found', message: 'no such sandbox' });
    }
    if (step === 'fail') throw new Error('instabox sandbox did not reach running.');
    if (step === 'hang') {
      await new Promise<never>((_, reject) => {
        const signal = options.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    machine.state = 'running';
  }

  async deleteMachine(id: string): Promise<InstaboxOperation> {
    await this.pass('deleteMachine', [id]);
    const machine = this.machines.get(id);
    if (machine) machine.state = 'deleted';
    return operation(id);
  }
}

interface Gate {
  reached: Promise<void>;
  open: Promise<void>;
  signal: () => void;
}

function operation(machineId: string): InstaboxOperation {
  return { id: `op_${machineId}`, machineId, type: 'create', state: 'succeeded', error: null };
}
