import {
  InstaboxApiError,
  type InstaboxMachine,
  type InstaboxOperation,
} from '@maka-cloud/instabox';
import type { BoxApi } from '../types.js';

type Method =
  | 'createMachine'
  | 'patchMachineMetadata'
  | 'getMachine'
  | 'deleteMachine'
  | 'listMachines';

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
