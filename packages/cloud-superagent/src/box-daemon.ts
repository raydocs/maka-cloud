import { readFileSync } from 'node:fs';
import type { SandboxExecRequest, SandboxExecResult } from './sandbox.js';

export interface DaemonBox {
  exec(tenantId: string, workerId: string, request: SandboxExecRequest): Promise<SandboxExecResult>;
}

export interface BoxSession {
  readonly workerId: string;
  readonly workDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly abort: AbortController;
}

/**
 * One long-lived host process per tenant box. Each worker is a lightweight
 * in-process session (cwd / env / AbortController), not its own maka process.
 */
export class BoxDaemon {
  readonly tenantId: string;
  private readonly box?: DaemonBox;
  private readonly rows = new Map<string, MutableSession>();

  constructor(options: { tenantId: string; box?: DaemonBox }) {
    this.tenantId = options.tenantId;
    this.box = options.box;
  }

  get size(): number {
    return this.rows.size;
  }

  attach(
    workerId: string,
    extras: { workDir?: string; env?: Record<string, string> } = {},
  ): BoxSession {
    const existing = this.rows.get(workerId);
    if (existing && !existing.abort.signal.aborted) return existing;
    const workDir = extras.workDir ?? `work/${workerId}`;
    const session: MutableSession = {
      workerId,
      workDir,
      env: {
        HOME: workDir,
        npm_config_cache: 'work/.npm',
        GIT_TERMINAL_PROMPT: '0',
        ...extras.env,
      },
      abort: new AbortController(),
    };
    this.rows.set(workerId, session);
    return session;
  }

  detach(workerId: string): void {
    const session = this.rows.get(workerId);
    if (!session) return;
    if (!session.abort.signal.aborted) session.abort.abort();
    this.rows.delete(workerId);
  }

  cancel(workerId: string): void {
    this.rows.get(workerId)?.abort.abort();
  }

  session(workerId: string): BoxSession | undefined {
    return this.rows.get(workerId);
  }

  list(): BoxSession[] {
    return [...this.rows.values()];
  }

  async exec(workerId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    const session = this.rows.get(workerId);
    if (!session) throw new Error(`No daemon session for ${workerId}`);
    if (session.abort.signal.aborted) {
      return { stdout: '', stderr: 'session cancelled', exitCode: 1 };
    }
    if (!this.box) {
      return { stdout: '', stderr: 'daemon has no box', exitCode: 1 };
    }
    const result = await this.box.exec(this.tenantId, workerId, {
      ...request,
      env: { ...session.env, ...request.env },
    });
    if (session.abort.signal.aborted) {
      return { stdout: '', stderr: 'session cancelled', exitCode: 1 };
    }
    return result;
  }
}

interface MutableSession {
  workerId: string;
  workDir: string;
  env: Record<string, string>;
  abort: AbortController;
}

export function readVmRss(pid: number): number | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
