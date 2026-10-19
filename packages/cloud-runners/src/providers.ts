import type { TaskId } from '@maka-cloud/orchestrator';
import type { ModelAccess, ModelAccessProvider, SandboxLease, SandboxProvider } from './types.js';

export const DEFAULT_TENANT = 'default';

/**
 * One machine for one tenant (single tenant for now). Asking for another tenant fails: a
 * machine is never handed to a tenant it does not belong to.
 */
export class FixedMachineProvider implements SandboxProvider {
  constructor(
    private readonly machineId: string,
    private readonly tenantId: string = DEFAULT_TENANT,
  ) {
    if (!machineId) throw new Error('FixedMachineProvider: empty machine id');
  }

  async acquire(input: { tenantId: string; taskId: TaskId }): Promise<SandboxLease> {
    if (input.tenantId !== this.tenantId) {
      throw new Error(`No sandbox is assigned to tenant "${input.tenantId}"`);
    }
    return { machineId: this.machineId, release: () => undefined };
  }

  knownMachines(): string[] {
    return [this.machineId];
  }
}

/**
 * A machine per tenant, from a fixed table. An unknown tenant never falls back to another's, and
 * a table that gives one machine to two tenants is refused when it is built.
 */
export class TenantMachineProvider implements SandboxProvider {
  private readonly machines: ReadonlyMap<string, string>;

  constructor(machines: Readonly<Record<string, string>>) {
    // Copy first, then check the copy: the caller keeps its object, and what is checked is what is used.
    const table = new Map(Object.entries(machines));
    const owners = new Map<string, string>();
    for (const [tenantId, machineId] of table) {
      if (!machineId) throw new Error(`TenantMachineProvider: empty machine id for "${tenantId}"`);
      const owner = owners.get(machineId);
      if (owner !== undefined) {
        throw new Error(
          `TenantMachineProvider: machine "${machineId}" is assigned to both "${owner}" and "${tenantId}"`,
        );
      }
      owners.set(machineId, tenantId);
    }
    this.machines = table;
  }

  async acquire(input: { tenantId: string; taskId: TaskId }): Promise<SandboxLease> {
    const machineId = this.machines.get(input.tenantId);
    if (!machineId) throw new Error(`No sandbox is assigned to tenant "${input.tenantId}"`);
    return { machineId, release: () => undefined };
  }

  knownMachines(): string[] {
    return [...this.machines.values()];
  }
}

/**
 * Keys from the environment: `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` for the Claude runner and
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` for Codex. One shared key, not a per-task one; the model
 * gateway replaces this with a provider that issues and revokes a key per task.
 */
export function envModelAccess(env: NodeJS.ProcessEnv = process.env): ModelAccessProvider {
  return {
    async issue({ runner }): Promise<ModelAccess> {
      const codex = runner === 'codex';
      const apiKey = codex ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error(`${codex ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set.`);
      const baseUrl = codex ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL;
      return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
    },
  };
}
