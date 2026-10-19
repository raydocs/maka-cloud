import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Grade, Grader, HiddenTests, Outcome, PublicTask } from './types.js';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell. A seam so that tests never start Docker or Python. */
export interface CommandRunner {
  run(
    argv: readonly string[],
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<CommandResult>;
}

export const nodeCommandRunner: CommandRunner = {
  run(argv, options) {
    return new Promise((resolve, reject) => {
      const [program, ...args] = argv;
      if (!program) {
        reject(new Error('empty command'));
        return;
      }
      const child = spawn(program, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.signal ? { signal: options.signal } : {}),
      });
      let stdout = '';
      let stderr = '';
      const cap = (current: string, chunk: Buffer) =>
        (current + chunk.toString('utf8')).slice(-8_192);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = cap(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = cap(stderr, chunk);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  },
};

export interface SweBenchGraderOptions {
  /** The Python that has `swebench` installed, from `MAKA_EVALS_PYTHON`. */
  python: string;
  /** The prepared dataset file, which the harness reads its own copy of the tests from. */
  datasetPath: string;
  /** Host directory for predictions and reports. */
  workDir: string;
  runner?: CommandRunner;
  timeoutMs?: number;
}

const MODEL_NAME = 'maka-cloud-evals';

/**
 * Grades with the official SWE-bench evaluation harness, in Docker on the grading host: the
 * patch is applied to the instance's own image together with the tests the harness holds, and
 * the instance counts as resolved only when its FAIL_TO_PASS and PASS_TO_PASS tests all pass.
 * Live only; no test starts it.
 */
export class SweBenchGrader implements Grader {
  constructor(private readonly options: SweBenchGraderOptions) {}

  async grade(input: {
    task: PublicTask;
    hidden: HiddenTests;
    outcome: Outcome;
    signal?: AbortSignal;
  }): Promise<Grade> {
    const { task, outcome } = input;
    const runId = `ce-${createHash('sha256').update(`${task.id}\u0000${outcome.sha256}`).digest('hex').slice(0, 12)}`;
    const dir = await mkdtemp(join(this.options.workDir, 'grade-'));
    try {
      const predictions = join(dir, 'predictions.jsonl');
      await writeFile(
        predictions,
        `${JSON.stringify({
          instance_id: task.id,
          model_name_or_path: MODEL_NAME,
          model_patch: outcome.patch,
        })}\n`,
      );
      const result = await (this.options.runner ?? nodeCommandRunner).run(
        [
          this.options.python,
          '-m',
          'swebench.harness.run_evaluation',
          '--dataset_name',
          this.options.datasetPath,
          '--predictions_path',
          predictions,
          '--instance_ids',
          task.id,
          '--max_workers',
          '1',
          '--run_id',
          runId,
        ],
        {
          cwd: dir,
          timeoutMs: this.options.timeoutMs ?? 30 * 60_000,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `the SWE-bench harness exited ${result.exitCode}: ${result.stderr.slice(-300)}`,
        );
      }
      return parseSweBenchReport(
        await readFile(join(dir, `${MODEL_NAME}.${runId}.json`), 'utf8'),
        task.id,
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Reads the harness's report for one instance: resolved, unresolved or (thrown) an error. */
export function parseSweBenchReport(raw: string, instanceId: string): Grade {
  const report = JSON.parse(raw) as Record<string, unknown>;
  const ids = (key: string): string[] => {
    const value = report[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  };
  if (ids('error_ids').includes(instanceId))
    throw new Error(`the SWE-bench harness could not evaluate ${instanceId}`);
  if (ids('resolved_ids').includes(instanceId))
    return { resolved: true, detail: 'all FAIL_TO_PASS and PASS_TO_PASS tests pass' };
  if (ids('empty_patch_ids').includes(instanceId))
    return { resolved: false, detail: 'empty patch' };
  if (ids('unresolved_ids').includes(instanceId))
    return { resolved: false, detail: 'some FAIL_TO_PASS or PASS_TO_PASS tests fail' };
  throw new Error(`the SWE-bench report does not mention ${instanceId}`);
}
