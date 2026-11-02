/**
 * SandboxPort matches the SandboxApi seam of open PR #452
 * (`Pick<InstaboxClient, ensureRunning | exec | getMachine | snapshots | leases>`).
 * When that PR merges, InstaboxClient satisfies this structurally. boat.dev is parked.
 */

export interface SandboxExecRequest {
  cmd: string;
  cwd?: string;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxMachine {
  id: string;
  state: string;
}

export interface SandboxPort {
  ensureRunning(machineId: string): Promise<void>;
  exec(machineId: string, request: SandboxExecRequest): Promise<SandboxExecResult>;
  getMachine(machineId: string): Promise<SandboxMachine>;
  createSnapshot?(machineId: string, name: string): Promise<{ id: string }>;
  deleteSnapshot?(snapshotId: string): Promise<void>;
  waitForSnapshot?(snapshotId: string): Promise<void>;
  putActivityLease?(machineId: string, holder: string): Promise<void>;
  deleteActivityLease?(machineId: string, holder: string): Promise<void>;
}

export class FakeSandbox implements SandboxPort {
  readonly commands: Array<{ machineId: string; cmd: string }> = [];
  readonly machines = new Map<string, SandboxMachine>();

  async ensureRunning(machineId: string): Promise<void> {
    const current = this.machines.get(machineId) ?? { id: machineId, state: 'stopped' };
    current.state = 'running';
    this.machines.set(machineId, current);
  }

  async exec(machineId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    await this.ensureRunning(machineId);
    this.commands.push({ machineId, cmd: request.cmd });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async getMachine(machineId: string): Promise<SandboxMachine> {
    return this.machines.get(machineId) ?? { id: machineId, state: 'unknown' };
  }
}
