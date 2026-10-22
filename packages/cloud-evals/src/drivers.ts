import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Runner } from '@maka-cloud/orchestrator';
import type {
  CodingDeliveries,
  CodingSandbox,
  SandboxWorkspace,
} from '@maka-cloud/playbooks/coding';
import { aloneBrief, playbookBrief } from './briefs.js';
import { drive } from './drive.js';
import { type ProofSignals, proofOf } from './proof.js';
import { defaultTestCommand } from './suites.js';
import {
  cloneAt,
  collectPatch,
  DEFAULT_PATCH_LIMITS,
  outcomeOf,
  type PatchLimits,
} from './sandbox-ops.js';
import { DriverError, type DriverInput, type DriverResult, type SubjectDriver } from './types.js';

function repoUrlOf(repo: string, override?: (repo: string) => string): string {
  return override?.(repo) ?? `https://github.com/${repo}.git`;
}

function requireRepo(input: DriverInput): { repo: string; baseCommit: string } {
  const { repo, baseCommit } = input.task;
  if (!repo || !baseCommit)
    throw new DriverError(`task ${input.task.id} has no repository to work in`);
  return { repo, baseCommit };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface VendorAloneOptions {
  /** The T6 runner for one vendor (`claude-agent-sdk` or `codex`). */
  runner: Runner;
  sandbox: CodingSandbox;
  repoUrl?: (repo: string) => string;
  limits?: Partial<PatchLimits>;
}

/**
 * A vendor CLI alone: the harness fetches the base commit, hands the CLI the issue, and after the
 * run takes the change out of the workspace. No checks, no retry, no hand-over.
 */
export class VendorAloneDriver implements SubjectDriver {
  constructor(private readonly options: VendorAloneOptions) {}

  async run(input: DriverInput): Promise<DriverResult> {
    const { repo, baseCommit } = requireRepo(input);
    const limits = { ...DEFAULT_PATCH_LIMITS, ...this.options.limits };
    let cost: number | null = null;
    let ws: SandboxWorkspace | undefined;
    try {
      ws = await this.options.sandbox.open(input.taskId, input.signal);
      const baseSha = await cloneAt(
        ws,
        repoUrlOf(repo, this.options.repoUrl),
        baseCommit,
        input.signal,
      );
      await mkdir(input.hostDir, { recursive: true });
      const briefPath = join(input.hostDir, 'brief.md');
      await writeFile(briefPath, aloneBrief({ task: input.task, baseSha, dir: ws.dir }));
      const handle = await this.options.runner.start({
        taskId: input.taskId,
        runner: this.options.runner.name,
        briefPath,
        resultPath: join(input.hostDir, 'result.json'),
        budgetUsd: input.budgetUsd,
      });
      const ended = await drive(handle, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onCost: (usd) => {
          cost = usd;
        },
      });
      cost = ended.costUsd ?? cost;
      // Nothing is read, and nothing hidden is handed over, until the task's processes are gone.
      await this.stop(ws, cost);
      if (ended.end !== 'finished') {
        return { outcome: null, costUsd: cost, end: ended.end, failureReason: ended.failureReason };
      }
      const collected = await collectPatch(ws, baseSha, limits, input.signal);
      if ('reason' in collected) {
        return { outcome: null, costUsd: cost, end: 'finished', failureReason: collected.reason };
      }
      return { outcome: collected, costUsd: cost, end: 'finished', failureReason: null };
    } catch (error) {
      if (ws) await ws.stopAll().catch(() => undefined);
      if (error instanceof DriverError) throw new DriverError(error.message, error.costUsd ?? cost);
      throw new DriverError(errorMessage(error), cost);
    } finally {
      await ws?.release().catch(() => undefined);
    }
  }

  private async stop(ws: SandboxWorkspace, cost: number | null): Promise<void> {
    try {
      await ws.stopAll();
    } catch (error) {
      throw new DriverError(`could not confirm the run stopped: ${errorMessage(error)}`, cost);
    }
  }
}

export interface PlaybookOptions {
  /** The T8 `coding` runner. */
  runner: Runner;
  deliveries: CodingDeliveries;
  /** Used only to stop what the run left in the sandbox. */
  sandbox: CodingSandbox;
}

/** The proof is for the scorecard only: a missing or unreadable record is no proof, not a failure. */
async function readProof(path: string): Promise<ProofSignals | null> {
  try {
    return proofOf(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

const CUT = /\[change\.patch cut at \d+ of \d+ bytes\]\n$/u;

/**
 * The coding playbook as a subject: its runner owns the clone, the loop and the checks, and what
 * it delivers (a verified change) is the outcome. Nothing is delivered when it gives up.
 */
export class PlaybookDriver implements SubjectDriver {
  constructor(private readonly options: PlaybookOptions) {}

  async run(input: DriverInput): Promise<DriverResult> {
    const { repo } = requireRepo(input);
    let cost: number | null = null;
    try {
      await mkdir(input.hostDir, { recursive: true });
      const briefPath = join(input.hostDir, 'brief.md');
      await writeFile(
        briefPath,
        playbookBrief({
          task: input.task,
          testCommand: input.task.testCommand ?? defaultTestCommand(repo),
        }),
      );
      const handle = await this.options.runner.start({
        taskId: input.taskId,
        runner: this.options.runner.name,
        briefPath,
        resultPath: join(input.hostDir, 'result.json'),
        budgetUsd: input.budgetUsd,
      });
      const ended = await drive(handle, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onCost: (usd) => {
          cost = usd;
        },
      });
      cost = ended.costUsd ?? cost;
      try {
        await this.options.sandbox.stopTask(input.taskId);
      } catch (error) {
        throw new DriverError(`could not confirm the run stopped: ${errorMessage(error)}`, cost);
      }
      if (ended.end !== 'finished') {
        return { outcome: null, costUsd: cost, end: ended.end, failureReason: ended.failureReason };
      }
      const delivery = await this.options.deliveries.get(input.taskId);
      if (!delivery) {
        return {
          outcome: null,
          costUsd: cost,
          end: 'finished',
          failureReason: 'the playbook finished without a verified change',
        };
      }
      const patch = await readFile(join(input.hostDir, 'change.patch'), 'utf8');
      if (CUT.test(patch)) {
        return {
          outcome: null,
          costUsd: cost,
          end: 'finished',
          failureReason: 'the delivered patch was cut for size',
        };
      }
      const changes = JSON.parse(await readFile(delivery.changesPath, 'utf8')) as {
        files: { path: string }[];
      };
      const sha = createHash('sha256')
        .update(await readFile(delivery.changesPath))
        .digest('hex');
      if (sha !== delivery.changesSha256) {
        throw new DriverError('the delivered change no longer matches its record', cost);
      }
      return {
        outcome: outcomeOf(
          patch,
          changes.files.map((file) => file.path),
        ),
        costUsd: cost,
        end: 'finished',
        failureReason: null,
        proof: await readProof(delivery.verificationPath),
      };
    } catch (error) {
      await this.options.sandbox.stopTask(input.taskId).catch(() => undefined);
      if (error instanceof DriverError) throw new DriverError(error.message, error.costUsd ?? cost);
      throw new DriverError(errorMessage(error), cost);
    }
  }
}
