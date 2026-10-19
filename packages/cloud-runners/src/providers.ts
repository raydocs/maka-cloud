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
  ) {}

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

/** A machine per tenant, from a fixed table. An unknown tenant never falls back to another's. */
export class TenantMachineProvider implements SandboxProvider {
  constructor(private readonly machines: Readonly<Record<string, string>>) {}

  async acquire(input: { tenantId: string; taskId: TaskId }): Promise<SandboxLease> {
    const machineId = this.machines[input.tenantId];
    if (!machineId) throw new Error(`No sandbox is assigned to tenant "${input.tenantId}"`);
    return { machineId, release: () => undefined };
  }

  knownMachines(): string[] {
    return [...new Set(Object.values(this.machines))];
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
