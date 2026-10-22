import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  implementerFor,
  type ModeId,
  type ModesConfig,
  budgetProblem,
  chooseMode,
  parseModeBrief,
  reviewerFor,
  splitBudget,
} from '@maka-cloud/modes';
import {
  type ResultManifest,
  ResultManifestSchema,
  type RunHandle,
  type Runner,
  type RunnerEvent,
  type RunSpec,
  scrubSecretText,
  type TaskId,
} from '@maka-cloud/orchestrator';
import { agentBrief, type CheckProblem, type FailureBrief, repairPrompt } from './briefs.js';
import type { ChangedFile, ChangeSet, CodingDeliveries } from './deliveries.js';
import { DEFAULT_LOOP_LIMITS, type LoopLimits, LoopDetector, parseSample } from './loop.js';
import {
  MAX_REVIEW_BYTES,
  parseReviewFile,
  plain,
  type FixRecord,
  type ReviewRecord,
  fixBrief,
  MAX_FIX_FINDINGS,
  reviewBrief,
  reviewLine,
  reviewMarkdown,
  type ReviewSummary,
  summarizeReview,
} from './review.js';
import type { CodingSandbox, SandboxWorkspace } from './sandbox.js';
import {
  BASE_RESTORE_SCRIPT,
  BASE_REVERT_SCRIPT,
  BLOB_CHUNK_SCRIPT,
  CHANGES_SCRIPT,
  CHECK_SCRIPT,
  CHECK_STOP_SCRIPT,
  checkAttemptMark,
  checkTagPrefix,
  CLONE_SCRIPT,
  PATCH_CHUNK_SCRIPT,
  READ_SMALL_SCRIPT,
  SAMPLE_SCRIPT,
  PUBLISH_FILE_SCRIPT,
  WRITE_FILE_SCRIPT,
} from './scripts.js';
import {
  type CodingTask,
  isRepoPath,
  otherVendor,
  parseCodingBrief,
  REPRO_FILE,
  type Repro,
  ReproSchema,
  REVIEW_FILE,
  type Vendor,
} from './task.js';

/** A vendor runner the coding runner drives: T6's `SandboxCliRunner` fits. */
export interface AgentRunner {
  start(spec: RunSpec): Promise<RunHandle>;
  resume(taskId: TaskId, input: { prompt: string; spec: RunSpec }): Promise<RunHandle>;
}

export interface CodingLimits {
  /**
   * How long one check (the test command, the reproduction test) may run. Default 9 min, at most
   * 9.5 min: a check is one sandbox exec, which ends after 10 minutes.
   */
  checkTimeoutMs: number;
  /** Bytes of a check's output kept for the agent and the verification record. Default 8 KiB. */
  outputTailBytes: number;
  /** Changed files a delivery may hold. Default 300. */
  maxFiles: number;
  /** Bytes of one changed file. Default 2 MiB. */
  maxFileBytes: number;
  /** Bytes of all changed files together. Default 8 MiB. */
  maxTotalBytes: number;
  /** Bytes of `change.patch` kept; a longer patch is cut and says so. Default 1 MiB. */
  maxPatchBytes: number;
  /** Failed runs or checks of one vendor before the task goes to the other. Default 2. */
  failuresPerVendor: number;
}

export const DEFAULT_CODING_LIMITS: CodingLimits = {
  checkTimeoutMs: 9 * 60_000,
  outputTailBytes: 8 * 1024,
  maxFiles: 300,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPatchBytes: 1024 * 1024,
  failuresPerVendor: 2,
};

export interface CodingRunnerOptions {
  agents: Record<Vendor, AgentRunner>;
  sandbox: CodingSandbox;
  deliveries: CodingDeliveries;
  /** Where the sandbox fetches a repository from. Default `https://github.com/<repo>.git`. */
  repoUrl?: (repo: string) => string;
  /** The vendor that tries first when the brief does not name one. Default `claude-agent-sdk`. */
  firstVendor?: Vendor;
  /**
   * The modes: which model and effort each agent run uses, how a task's budget is split between
   * the work and its review, and who reviews. Without it no review is done, and the manifest says so.
   */
  modes?: ModesConfig;
  limits?: Partial<CodingLimits>;
  loop?: Partial<LoopLimits>;
  /** How often the workspace is sampled for edit loops while an agent runs. Default 15 s. */
  sampleIntervalMs?: number;
  /** How long a released agent run's stream may take to end while its last spend is read. Default 10 s. */
  lastSpendMs?: number;
  /** A cleanup step that failed. Cleanup goes on; this is how it is seen. */
  onCleanupError?(failure: { taskId: TaskId; step: string; error: unknown }): void;
}

/** What is held right now, for tests: everything is back to zero when no task runs. */
export interface CodingRunnerStats {
  runs: number;
  workspaces: number;
  agentRuns: number;
  samplers: number;
  checks: number;
  timers: number;
}

/** The least a review is worth starting with: below this the change is delivered unreviewed. */
const MIN_REVIEW_USD = 0.05;
const MAX_NOTE_CHARS = 500;
const DEFAULT_LAST_SPEND_MS = 10_000;
const MAX_REASON_CHARS = 2_000;
const BLOB_CHUNK_BYTES = 192 * 1024;
const MAX_REPRO_BYTES = 16 * 1024;
/** The longest check: its exec (the check, its kill grace and the outer stop) ends within 10 minutes. */
const MAX_CHECK_MS = 570_000;
/** Seconds an exec of CHECK_SCRIPT may take beyond the check's own limit. */
const CHECK_EXEC_SLACK_SECONDS = 30;

class CancelledError extends Error {}

/** Push-based event stream with a single reader. */
class EventQueue implements AsyncIterable<RunnerEvent> {
  private readonly items: RunnerEvent[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(event: RunnerEvent): void {
    if (this.closed) return;
    this.items.push(event);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunnerEvent> {
    for (;;) {
      const item = this.items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * The `coding` runner: one coding task, start to verified change, driven by code. It clones the
 * repository into the task's sandbox, has one vendor's agent implement the change, checks the
 * work itself (the repository's tests, and a reproduction test that must fail on the base
 * commit), lets the agent repair once, and after two failures or an edit loop hands the task to
 * the other vendor once with a failure brief. The result manifest is written by this runner,
 * never by the agent; a verified change is recorded as a delivery for the pull request tool.
 */
export class CodingRunner implements Runner {
  readonly name = 'coding';
  readonly stats: CodingRunnerStats = {
    runs: 0,
    workspaces: 0,
    agentRuns: 0,
    samplers: 0,
    checks: 0,
    timers: 0,
  };
  readonly limits: CodingLimits;
  readonly loopLimits: LoopLimits;

  constructor(readonly options: CodingRunnerOptions) {
    this.limits = { ...DEFAULT_CODING_LIMITS, ...options.limits };
    if (!(this.limits.checkTimeoutMs > 0 && this.limits.checkTimeoutMs <= MAX_CHECK_MS)) {
      throw new Error(
        `checkTimeoutMs must be above 0 and at most ${MAX_CHECK_MS} (a check is one sandbox exec, which ends after 10 minutes)`,
      );
    }
    this.loopLimits = { ...DEFAULT_LOOP_LIMITS, ...options.loop };
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    return new CodingRun(this, spec).begin();
  }

  /** Stops the agent runs and checks a task left in its sandbox. Idempotent. */
  async stopOrphaned(
    taskId: TaskId,
    options: { signal?: AbortSignal; epoch?: number } = {},
  ): Promise<void> {
    await this.options.sandbox.stopTask(taskId, options.signal, options.epoch);
  }
}

interface CheckResult {
  name: string;
  command: string;
  /** -1 when the check ended without an exit code of its own. */
  exitCode: number;
  /** The check ran past its time limit and was stopped. */
  timedOut?: boolean;
  /** The end of the output. */
  output: string;
  outputBytes: number;
}

/**
 * Why a check that did not pass is not a test failure (it timed out, died, was killed by a
 * signal, or could not run its command), or undefined when it is one: a non-zero exit below 125
 * of its own.
 */
function notATestFailure(check: CheckResult): string | undefined {
  if (check.timedOut) return 'timed out';
  if (check.exitCode < 0) return `did not finish (${check.output})`;
  if (check.exitCode >= 128) return `was killed by signal ${check.exitCode - 128}`;
  if (check.exitCode >= 125) return `could not run (exit ${check.exitCode})`;
  return undefined;
}

function describeEnd(check: CheckResult): string {
  if (check.timedOut) return 'timed out';
  if (check.exitCode < 0) return check.output;
  return `exit ${check.exitCode}`;
}

interface TurnRecord {
  run: number;
  kind: 'start' | 'resume';
  outcome: 'verified' | 'check_failed' | 'agent_failed' | 'loop';
  detail?: string;
  checks: Omit<CheckResult, 'output'>[];
}

interface AttemptRecord {
  vendor: Vendor;
  turns: TurnRecord[];
  end?: string;
}

interface Verification {
  repo: string;
  baseRef: string;
  baseSha: string;
  testCommand: string;
  result: 'verified' | 'failed';
  /** Set when the change passed its checks but is not delivered: it is kept for the owner to look at. */
  kept?: { reason: string };
  repro?: Repro;
  review?: ReviewSummary;
  attempts: AttemptRecord[];
  changedFiles?: { path: string; status: string }[];
}

type CheckOutcome = { ok: true; repro: Repro } | ({ ok: false } & CheckProblem);

type TurnOutcome =
  | { ok: true; manifest: ResultManifest }
  | { ok: false; reason: string }
  | { loop: string };

/** What an agent run is for: the work is the task's own, the review has a budget of its own. */
interface TurnOptions {
  phase: 'work' | 'review';
  /** The model and effort of the role; absent: the runner's default. */
  model?: string;
  effort?: string;
}

interface Collected {
  changeSet: ChangeSet;
  patch: string;
}

export function clipText(text: string, max: number): string {
  // Scrubbed whole and only then cut: a key cut in two is no longer a key the scrubber knows.
  const shown = scrubSecretText(text);
  return shown.length <= max ? shown : `${shown.slice(0, max - 1)}…`;
}

/** How many serious (P1) findings a finished review still carries. */
function p1Of(review: ReviewRecord): number {
  return review.status === 'reviewed'
    ? review.findings.filter((finding) => finding.severity === 'P1').length
    : 0;
}

/**
 * Why a change that passed its checks is kept for the owner to look at instead of delivered: no
 * independent review could be made, or the review still has a serious (P1) problem after the one
 * fix. Undefined: nothing stands in the way of delivering it.
 */
/**
 * Why a fixed change has no second review. The first review's P1 findings were the reason for the
 * fix, so the record says they were found and that their fix was never checked by a reviewer.
 */
function notReviewedAgain(first: ReviewRecord, why: string): string {
  const found = first.status === 'reviewed' ? p1Of(first) : 0;
  const earlier =
    found > 0
      ? `the first review found ${found} serious problem(s); the fix was not checked: `
      : '';
  return `${earlier}the fixed change could not be reviewed again (${why})`;
}

function keptReason(review: ReviewRecord): string | undefined {
  if (review.status !== 'reviewed') {
    return `the change passed the repository's checks but could not be independently reviewed (${plain(review.reason, 200)})`;
  }
  const left = p1Of(review);
  if (left === 0) return undefined;
  const fix = review.fix;
  const unused =
    fix?.result === 'not_applied'
      ? ` (the fix was not used: ${fix.reason ?? 'no reason given'})`
      : '';
  return `the independent review still found ${left} serious problem(s) after the one fix it allows${unused}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function budgetReached(budget: number, spent: number): string {
  return `budget of $${budget.toFixed(2)} reached ($${spent.toFixed(2)} spent)`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

class CodingRun implements RunHandle {
  readonly events = new EventQueue();
  private readonly abort = new AbortController();
  private cancelled = false;
  private ended = false;
  private terminal: RunnerEvent | undefined;
  private cleanupPromise: Promise<void> | undefined;
  /** The write that keeps the verified change before its review starts, while it runs. */
  private keeping: Promise<void> | undefined;
  private workspace: SandboxWorkspace | undefined;
  private agentHandle: RunHandle | undefined;
  private readonly agentReleases = new WeakMap<RunHandle, Promise<void>>();
  private baseCheckActive = false;
  private runs = 0;
  private checkCount = 0;
  /** Dollars the agent runs that already ended have spent. */
  private spentBefore = 0;
  private lastReportedUsd: number | undefined;
  /** Set once the task has spent its budget: the reason it stops. */
  private budgetStop: string | undefined;
  /** What the review, the fix and the second review may spend in all (the task's total, not theirs alone). */
  private reviewCap: number | undefined;
  /** The mode the brief names; the work and the review follow its roles and its budget split. */
  private mode: ModeId = 'standard';
  /**
   * What the agent runs may spend in all: the task's budget, less the share kept for the review
   * while the work runs, and the review's own limit (below the budget) while it does.
   */
  private limitUsd: number | undefined;
  /**
   * Set when a cleanup step that stops something the task started failed: an agent run or a check
   * may still be running. `cancel` refuses with it, so the stop stays owed.
   */
  private stopFailure: Error | undefined;
  /** Reads of agent streams that outlived the wait for their last spend; each adds to the total when it ends. */
  private readonly lateSpends = new Set<Promise<void>>();
  private readonly hostDir: string;
  /** Set when the process is closing and let go of this run (see `detach`). */
  private detached = false;

  constructor(
    private readonly runner: CodingRunner,
    private readonly spec: RunSpec,
  ) {
    this.hostDir = dirname(spec.resultPath);
  }

  begin(): RunHandle {
    void this.execute();
    return this;
  }

  async cancel(): Promise<void> {
    if (!this.ended) {
      this.cancelled = true;
      this.abort.abort();
    }
    // A change being kept is written from memory, not from the workspace: the stop waits for it
    // so that the cancel, once it returns, leaves the change on disk.
    await this.keeping?.catch(() => undefined);
    await this.cleanup();
    // A cancel that returns says everything the task started is stopped: when it could not be, it says so.
    if (this.stopFailure) throw this.stopFailure;
  }

  /**
   * Lets go of the task for a process that is closing: its agent run is let go of, its waits end,
   * and nothing is stopped, restored or reported (the sandbox keeps what it has). The task stays
   * unfinished in the log and the next process takes it over as it does after a crash.
   */
  detach(): void {
    if (this.ended || this.detached) return;
    this.detached = true;
    this.agentHandle?.detach?.();
    this.cancelled = true;
    this.abort.abort();
    this.cleanupPromise = Promise.resolve();
    this.events.close();
  }

  private get signal(): AbortSignal {
    return this.abort.signal;
  }

  private get options(): CodingRunnerOptions {
    return this.runner.options;
  }

  private get limits(): CodingLimits {
    return this.runner.limits;
  }

  // -- the task ----------------------------------------------------------------------------------

  private async execute(): Promise<void> {
    const { stats } = this.runner;
    stats.runs++;
    try {
      const written = await this.guard(readFile(this.spec.briefPath, 'utf8'));
      // The mode is the one line the conductor's code put into the brief; the agents are not told
      // about it, and nothing else in the brief can set it.
      const modeBrief = parseModeBrief(written);
      if (!modeBrief.ok) return this.setTerminal({ type: 'failed', reason: modeBrief.reason });
      const brief = modeBrief.rest;
      const parsed = parseCodingBrief(brief);
      if (!parsed.ok) return this.setTerminal({ type: 'failed', reason: parsed.reason });
      const task = parsed.task;
      // A brief with no mode line is a task whose budget alone decides (never above standard).
      const { modes } = this.options;
      this.mode =
        modeBrief.mode ??
        (modes
          ? chooseMode(modes, {
              ...(this.spec.budgetUsd === undefined ? {} : { budgetUsd: this.spec.budgetUsd }),
            }).mode
          : 'standard');
      // A task whose budget is below what its mode needs is refused before anything is acquired.
      const allowance = this.allowance();
      const tooSmall =
        modes && allowance !== undefined ? budgetProblem(modes, this.mode, allowance) : undefined;
      if (tooSmall) return this.setTerminal({ type: 'failed', reason: tooSmall });
      this.limitUsd = this.underTurnLimit(this.workLimit());

      this.adoptWorkspace(
        await this.guard(this.options.sandbox.open(this.spec.taskId, this.signal, this.spec.epoch)),
      );
      this.progress(`fetching ${task.repo} at ${task.baseRef}`);
      const baseSha = await this.clone(task, task.baseRef);

      const first = task.runner ?? this.options.firstVendor ?? 'claude-agent-sdk';
      const vendors: Vendor[] = [first, otherVendor(first)];
      const verification: Verification = {
        repo: task.repo,
        baseRef: task.baseRef,
        baseSha,
        testCommand: task.testCommand,
        result: 'failed',
        attempts: [],
      };
      let failureBrief: FailureBrief | undefined;
      for (const [index, vendor] of vendors.entries()) {
        if (index > 0 && failureBrief) {
          this.progress(`handing the task to ${vendor}: ${failureBrief.reason}`);
          await this.handOver(task, baseSha, failureBrief);
        }
        const attempt: AttemptRecord = { vendor, turns: [] };
        verification.attempts.push(attempt);
        const outcome = await this.attempt(task, baseSha, brief, vendor, attempt, failureBrief);
        if (outcome.ok) {
          verification.result = 'verified';
          // The verified change is on the host from here on: a stop, a crash or an error during the
          // review cannot lose it. The delivery below replaces this record.
          await this.keepUntilReviewed(task, verification, outcome);
          const reviewed = await this.reviewAndFix(
            task,
            baseSha,
            brief,
            vendor,
            outcome,
            verification,
          );
          // A change nobody could review, or one with a serious problem left after the one fix, is
          // not delivered: it is kept for the owner to look at, with the reason. The task is not
          // failed, because its work is not lost: the change, its branch and its review are kept.
          const kept = keptReason(reviewed.review);
          await this.deliver(task, verification, reviewed.outcome, reviewed.review, kept);
          return this.setTerminal({ type: 'finished' });
        }
        attempt.end = outcome.reason;
        failureBrief = {
          repo: task.repo,
          baseSha,
          goal: task.goal,
          testCommand: task.testCommand,
          vendor,
          reason: outcome.reason,
          runs: outcome.runs,
          attemptPatch: 'attempt-1.patch',
        };
      }
      await this.giveUp(task, verification, failureBrief);
      this.setTerminal({ type: 'finished' });
    } catch (error) {
      if (!this.cancelled && !(error instanceof CancelledError)) {
        this.setTerminal({
          type: 'failed',
          reason: clipText(errorMessage(error), MAX_REASON_CHARS),
        });
      }
    } finally {
      this.ended = true;
      await this.cleanup();
      // An agent run whose stream was still open when the wait for its last spend ran out is read
      // on: the task is not over, and its cost not final, until that is recorded.
      while (this.lateSpends.size > 0) await Promise.all([...this.lateSpends]);
      // The terminal event goes out only after everything the task held is released, so
      // nothing that follows it (a new task, a restart) meets this one's leftovers. It also means
      // nothing is left to stop: when a stop failed it is not sent, the stream just closes, and
      // the task ends with the stop owed (and retried by id).
      if (this.terminal && !this.cancelled) {
        if (this.stopFailure) {
          this.events.push({
            type: 'progress',
            note: clipText(
              `the task could not be confirmed stopped (${this.stopFailure.message}); its end is not reported and the stop stays owed`,
              MAX_NOTE_CHARS,
            ),
          });
        } else this.events.push(this.terminal);
      }
      this.events.close();
      stats.runs--;
    }
  }

  private setTerminal(event: RunnerEvent): void {
    this.terminal ??= event;
  }

  /**
   * One vendor's attempt: a start, then repairs, until the work is verified or the vendor used
   * up its failures or looped.
   */
  private async attempt(
    task: CodingTask,
    baseSha: string,
    conductorBrief: string,
    vendor: Vendor,
    record: AttemptRecord,
    failure: FailureBrief | undefined,
  ): Promise<
    | { ok: true; repro: Repro; manifest: ResultManifest; collected: Collected }
    | { ok: false; reason: string; runs: FailureBrief['runs'] }
  > {
    const detector = new LoopDetector(this.runner.loopLimits);
    const runs: FailureBrief['runs'] = [];
    let failures = 0;
    let prompt: string | undefined;
    for (;;) {
      const kind = prompt === undefined ? 'start' : 'resume';
      const turn = await this.agentTurn(
        vendor,
        detector,
        prompt,
        () =>
          agentBrief({
            task,
            baseSha,
            dir: this.ws.dir,
            conductorBrief,
            ...(failure ? { failure: { vendor: failure.vendor, reason: failure.reason } } : {}),
          }),
        { phase: 'work', ...this.settingsOf(implementerFor, vendor) },
      );
      const run = this.runs;
      if ('loop' in turn) {
        record.turns.push({ run, kind, outcome: 'loop', detail: turn.loop, checks: [] });
        runs.push({ run, outcome: `stopped: edit loop (${turn.loop})` });
        return { ok: false, reason: `edit loop: ${turn.loop}`, runs };
      }
      let problem: CheckProblem;
      if (!turn.ok) {
        record.turns.push({ run, kind, outcome: 'agent_failed', detail: turn.reason, checks: [] });
        runs.push({ run, outcome: `the agent's run failed: ${turn.reason}` });
        problem = { problem: `your last run failed: ${turn.reason}` };
      } else {
        const checks: CheckResult[] = [];
        let checked = await this.check(task, baseSha, checks);
        let collected: Collected | undefined;
        if (checked.ok) {
          const result = await this.collect(task, baseSha);
          if ('reason' in result) checked = { ok: false, problem: result.reason };
          else collected = result;
        }
        const turnRecord: TurnRecord = {
          run,
          kind,
          outcome: checked.ok ? 'verified' : 'check_failed',
          checks: checks.map(({ output: _output, ...rest }) => rest),
        };
        if (!checked.ok) turnRecord.detail = checked.problem;
        record.turns.push(turnRecord);
        if (checked.ok && collected) {
          return { ok: true, repro: checked.repro, manifest: turn.manifest, collected };
        }
        if (checked.ok) throw new Error('unreachable: verified without a change set');
        runs.push({
          run,
          outcome: `check failed: ${checked.problem}`,
          ...(checked.output ? { output: checked.output } : {}),
        });
        problem = checked;
      }
      failures++;
      if (failures >= this.limits.failuresPerVendor) {
        return { ok: false, reason: `${failures} failed runs`, runs };
      }
      this.progress(`asking ${vendor} to fix: ${clipText(problem.problem, 200)}`);
      prompt = repairPrompt(problem, task.testCommand);
    }
  }

  // -- one agent run -------------------------------------------------------------------------------

  private async agentTurn(
    vendor: Vendor,
    detector: LoopDetector,
    prompt: string | undefined,
    brief: () => string,
    options: TurnOptions,
  ): Promise<TurnOutcome> {
    const { stats } = this.runner;
    const limit = this.limitUsd;
    if (this.budgetStop) {
      if (options.phase === 'work') throw new Error(this.budgetStop);
      return { ok: false, reason: this.budgetStop };
    }
    const n = ++this.runs;
    const spec: RunSpec = {
      taskId: this.spec.taskId,
      runner: vendor,
      briefPath: join(this.hostDir, `agent-${n}-brief.md`),
      resultPath: join(this.hostDir, `agent-${n}-result.json`),
      // The files this runner writes itself: the task's result and the delivery. An agent's
      // exported artifact must not replace them, or it could forge what the owner is shown.
      reserved: [
        basename(this.spec.resultPath),
        basename(this.spec.briefPath),
        'changes.json',
        'change.patch',
        'review.md',
        'verification.json',
        'failure_brief.json',
      ],
      // Each agent run may spend what is left of its phase's limit.
      // The run's own limit is what is left of its phase (work, then review and fix). The whole
      // budget stays `budgetUsd`, so the gateway pool is the whole and not the first phase's share.
      ...(limit === undefined || this.spec.budgetUsd === undefined
        ? {}
        : {
            budgetUsd: this.spec.budgetUsd,
            turnBudgetUsd: roundUsd(limit - this.spentBefore),
          }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(this.spec.budgetRootId === undefined ? {} : { budgetRootId: this.spec.budgetRootId }),
      ...(this.spec.mcp ? { mcp: this.spec.mcp } : {}),
      ...(this.spec.epoch === undefined ? {} : { epoch: this.spec.epoch }),
    };
    // Every run reads its brief, a resume included.
    await this.guard(writeHostFile(spec.briefPath, brief()));
    const agent = this.options.agents[vendor];
    this.progress(`${vendor} ${prompt === undefined ? 'starts' : 'continues'} (run ${n})`);
    const starting =
      prompt === undefined ? agent.start(spec) : agent.resume(this.spec.taskId, { prompt, spec });
    // Adopted the moment it exists, so a cancel that came first still stops it.
    starting.then(
      (started) => this.adoptAgent(started),
      () => undefined,
    );
    const handle = await this.guard(starting);
    let loop: string | undefined;
    const sampler = this.startSampler(detector, (reason) => {
      loop = reason;
      void handle.cancel().catch(() => undefined);
    });
    let terminal: RunnerEvent | undefined;
    let runCost = 0;
    const iterator = handle.events[Symbol.asyncIterator]();
    // The pull a cancel gave up on: it may still return a report.
    let pending: Promise<IteratorResult<RunnerEvent>> | undefined;
    try {
      for (;;) {
        pending = iterator.next();
        const next = await this.guard(pending);
        pending = undefined;
        if (next.done) break;
        const event = next.value;
        if (event.type === 'progress') this.progress(event.note);
        else if (event.type === 'usage') {
          runCost = event.costUsd;
          if (this.meter(this.spentBefore + runCost)) {
            void handle.cancel().catch(() => undefined);
          }
        } else terminal ??= event;
      }
    } finally {
      try {
        await sampler.stop();
        // Wait for the agent run's own cleanup before anything else touches the task directory.
        await this.releaseAgent(handle);
        // A cancel leaves the loop above before the stream ends, but the run reports what its last
        // requests cost while it stops: that is spent, and is reported before this task ends.
        runCost = await this.lastSpend(iterator, pending, runCost);
      } finally {
        this.spentBefore += runCost;
        this.meter(this.spentBefore);
      }
    }
    this.checkCancelled();
    // A spent budget ends the task: it is not a vendor failure, so nothing is handed over. A review
    // that spent its own limit only ends the review.
    if (this.budgetStop) {
      if (options.phase === 'work') throw new Error(this.budgetStop);
      return { ok: false, reason: this.budgetStop };
    }
    if (loop !== undefined) return { loop };
    if (!(await this.ws.agentOnSameMachine())) {
      throw new Error('the agent ran on a different machine than the task workspace');
    }
    if (terminal?.type !== 'finished') {
      return {
        ok: false,
        reason: terminal?.type === 'failed' ? terminal.reason : 'the run ended without a result',
      };
    }
    try {
      const manifest = ResultManifestSchema.parse(
        JSON.parse(await readFile(spec.resultPath, 'utf8')),
      );
      return { ok: true, manifest };
    } catch (error) {
      return { ok: false, reason: `its result could not be read (${errorMessage(error)})` };
    }
  }

  /**
   * Reads what is left of a stopped agent run's stream and returns its last reported spend. The
   * stream closes when the run is released. One that does not within `lastSpendMs` is reported
   * and the task goes on without waiting, but its cost is not final: the read continues, adds
   * whatever it still reports to the task's total, and the task's own stream stays open until it
   * has ended (`lateSpends`), so nothing settles at the cost known when the wait ran out.
   */
  private async lastSpend(
    iterator: AsyncIterator<RunnerEvent>,
    pending: Promise<IteratorResult<RunnerEvent>> | undefined,
    spent: number,
  ): Promise<number> {
    let cost = spent;
    const read = (async () => {
      try {
        let next = pending ?? iterator.next();
        for (;;) {
          const result = await next;
          if (result.done) return;
          if (result.value.type === 'usage') cost = result.value.costUsd;
          next = iterator.next();
        }
      } catch {
        // The stream broke: what it reported before is all there is.
      }
    })();
    const limitMs = this.options.lastSpendMs ?? DEFAULT_LAST_SPEND_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), limitMs);
    });
    try {
      if (await Promise.race([read.then(() => false), late])) {
        this.options.onCleanupError?.({
          taskId: this.spec.taskId,
          step: 'read the last spend of the agent run',
          error: new Error(`its stream did not end within ${limitMs} ms of its release`),
        });
        const known = cost;
        const late = read.then(() => {
          if (cost > known) this.spentBefore += cost - known;
          this.meter(this.spentBefore, true);
        });
        this.lateSpends.add(late);
        void late.finally(() => this.lateSpends.delete(late));
        return known;
      }
    } finally {
      clearTimeout(timer);
    }
    return cost;
  }

  /** Samples the workspace while an agent runs and calls `onLoop` once if the edits loop. */
  private startSampler(
    detector: LoopDetector,
    onLoop: (reason: string) => void,
  ): { stop(): Promise<void> } {
    const { stats } = this.runner;
    const interval = this.options.sampleIntervalMs ?? 15_000;
    let stopped = false;
    let told = false;
    let timer: NodeJS.Timeout | undefined;
    let inFlight: Promise<void> | undefined;
    stats.samplers++;
    const schedule = (): void => {
      if (stopped) return;
      stats.timers++;
      timer = setTimeout(() => {
        stats.timers--;
        timer = undefined;
        inFlight = tick().finally(() => {
          inFlight = undefined;
        });
      }, interval);
    };
    const tick = async (): Promise<void> => {
      try {
        const result = await this.ws.exec(SAMPLE_SCRIPT, {
          envs: { MAKA_DIR: this.ws.dir, MAKA_MAX_FILES: String(this.limits.maxFiles) },
          timeoutSeconds: 30,
          signal: this.signal,
        });
        if (stopped) return;
        // The script refuses a tree it cannot look at safely (a repository inside the checkout): the
        // loop check is blind until that is gone, and the owner sees why.
        const refusal = /^ERR (.*)$/mu.exec(result.stdout);
        if (refusal !== null && !told) {
          told = true;
          this.progress(`the loop check cannot look at the files: ${refusal[1]}`);
        }
        const reason = detector.observe(parseSample(result.stdout));
        if (reason !== undefined) {
          stopped = true;
          this.progress(`stopping the agent: ${reason}`);
          onLoop(reason);
          return;
        }
      } catch {
        // A missed sample only delays detection.
      }
      schedule();
    };
    schedule();
    return {
      stop: async () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
          stats.timers--;
        }
        stopped = true;
        await inFlight;
        stats.samplers--;
      },
    };
  }

  // -- the review ----------------------------------------------------------------------------------

  /**
   * One run of this task is one turn of the orchestrator, and that turn has its own limit. The
   * implementer, the review, the fix and every retry of this run spend from that one allowance, so
   * no phase's limit may be above it.
   */
  private underTurnLimit(limit: number | undefined): number | undefined {
    const turn = this.spec.turnBudgetUsd;
    if (turn === undefined || limit === undefined) return limit;
    return Math.min(limit, turn);
  }

  /**
   * What this run may spend in all: the task's budget, or this turn's allowance when that is
   * smaller. The work/review split is made of this, so the review keeps its share of the turn.
   */
  private allowance(): number | undefined {
    return this.underTurnLimit(this.spec.budgetUsd);
  }

  /** What the work may spend in all: the allowance less the share the review keeps. */
  private workLimit(): number | undefined {
    const budget = this.allowance();
    if (budget === undefined) return undefined;
    const { modes } = this.options;
    return modes ? splitBudget(modes, this.mode, budget).workUsd : budget;
  }

  /** The model and effort `role` gives `vendor` in this task's mode. */
  private settingsOf(
    role: typeof implementerFor | typeof reviewerFor,
    vendor: Vendor,
  ): { model?: string; effort?: string } {
    const { modes } = this.options;
    if (!modes) return {};
    const agent = role(modes, this.mode, vendor);
    return { ...(agent.model ? { model: agent.model } : {}), effort: agent.effort };
  }

  /**
   * An agent of the other vendor reviews the change that passed the runner's checks. Whatever
   * happens to the review (it cannot start, runs out of its budget, fails, writes nothing usable),
   * the verified change is still delivered, and the record says the change was not reviewed and
   * why. Only a cancel ends the task here.
   */
  private async review(
    task: CodingTask,
    baseSha: string,
    conductorBrief: string,
    implementer: Vendor,
    outcome: { repro: Repro; collected: Collected },
  ): Promise<ReviewRecord> {
    const { modes } = this.options;
    if (!modes) {
      return {
        mode: this.mode,
        modesVersion: 0,
        status: 'not_configured',
        reason: 'no reviewer is configured',
      };
    }
    const base = { mode: this.mode, modesVersion: modes.version } as const;
    const reviewer = reviewerFor(modes, this.mode, implementer);
    const unavailable = (reason: string): ReviewRecord => ({
      ...base,
      status: 'unavailable',
      reviewer: reviewer.vendor,
      reason: plain(reason, 300),
    });
    const budget = this.allowance();
    if (budget !== undefined) {
      // One limit for the review, the fix and the second review together: it is set when the first
      // review starts and never grows, and it is below the task's budget.
      const reviewLimit = (this.reviewCap ??= Math.min(
        budget,
        this.spentBefore + splitBudget(modes, this.mode, budget).reviewUsd,
      ));
      if (reviewLimit - this.spentBefore < MIN_REVIEW_USD) {
        return unavailable(
          `the budget leaves $${Math.max(0, reviewLimit - this.spentBefore).toFixed(2)} for a review, too little to start one`,
        );
      }
      this.limitUsd = this.underTurnLimit(reviewLimit);
    }
    try {
      this.progress('a second agent reviews the change');
      await this.removeAgentFile(REVIEW_FILE);
      await this.publishForAgent('change.patch');
      const turn = await this.agentTurn(
        reviewer.vendor,
        new LoopDetector(this.runner.loopLimits),
        undefined,
        () =>
          reviewBrief({
            repo: task.repo,
            baseSha,
            dir: this.ws.dir,
            goal: task.goal,
            testCommand: task.testCommand,
            repro: outcome.repro,
            conductorBrief,
          }),
        { phase: 'review', ...this.settingsOf(reviewerFor, implementer) },
      );
      if ('loop' in turn) return unavailable(`the reviewer was stopped: ${turn.loop}`);
      if (!turn.ok) {
        return unavailable(
          this.budgetStop
            ? `the review ran out of its budget (${this.budgetStop})`
            : `the reviewer's run failed: ${turn.reason}`,
        );
      }
      // The first agent's account shares handoff/ with the reviewer's: what the reviewer was given
      // to read must still be the runner's copy of the change, or it reviewed something else.
      const same = await this.exec(
        'set -u\ncd "$MAKA_DIR"\ncmp -s -- change.patch handoff/change.patch\n',
        {},
      );
      if (same.exitCode !== 0) {
        return unavailable(
          'the copy of the change given to the reviewer was replaced, so its review was not used',
        );
      }
      const text = await this.readTaskFile(REVIEW_FILE, MAX_REVIEW_BYTES);
      if (!text.ok) return unavailable(text.reason);
      const parsed = parseReviewFile(text.text);
      if (!parsed.ok) return unavailable(parsed.reason);
      // The reviewer reads; it does not change. If the repository is not what was verified, the
      // review is not of the change that will be delivered.
      const again = await this.collect(task, baseSha);
      if ('reason' in again)
        return unavailable(`the change could not be read again (${again.reason})`);
      if (changeKey(again) !== changeKey(outcome.collected)) {
        return unavailable('the reviewer changed the repository, so its review was not used');
      }
      return {
        ...base,
        status: 'reviewed',
        reviewer: reviewer.vendor,
        findings: parsed.findings,
        ...(parsed.summary ? { summary: parsed.summary } : {}),
      };
    } catch (error) {
      if (this.cancelled || error instanceof CancelledError) throw error;
      return unavailable(errorMessage(error));
    } finally {
      // The review's own limit ends the review, not the task: the work finished before it began.
      this.budgetStop = undefined;
    }
  }

  /**
   * The review, and, when it found P1 problems, the one fix. The implementer's vendor gets the P1
   * findings once, in a fresh run (the task's session record is the reviewer's by now); the runner
   * checks the result as it checked the first change, and the other vendor reviews it again. If the
   * fix does not run or fails the checks, the first verified change is the one delivered, with its P1
   * findings; if only the second review fails, the fixed change is kept unreviewed. There
   * is no loop: this method runs `fix` at most once, and nothing calls it again.
   */
  private async reviewAndFix(
    task: CodingTask,
    baseSha: string,
    conductorBrief: string,
    implementer: Vendor,
    outcome: { repro: Repro; manifest: ResultManifest; collected: Collected },
    verification: Verification,
  ): Promise<{
    outcome: { repro: Repro; manifest: ResultManifest; collected: Collected };
    review: ReviewRecord;
  }> {
    const first = await this.review(task, baseSha, conductorBrief, implementer, outcome);
    if (first.status !== 'reviewed') return { outcome, review: first };
    const p1 = first.findings.filter((finding) => finding.severity === 'P1');
    if (p1.length === 0) return { outcome, review: first };
    const sent = Math.min(p1.length, MAX_FIX_FINDINGS);
    const notApplied = (reason: string): ReviewRecord => ({
      ...first,
      fix: { sent, result: 'not_applied', reason: plain(reason, 300) },
    });
    const budget = this.spec.budgetUsd;
    if (budget !== undefined && this.reviewCap !== undefined) {
      // The review's limit, below the turn's allowance when that is the smaller.
      const left = (this.limitUsd ?? this.reviewCap) - this.spentBefore;
      if (left < 2 * MIN_REVIEW_USD) {
        return {
          outcome,
          review: notApplied(
            `the review's budget has $${Math.max(0, left).toFixed(2)} left, too little for a fix and a second review`,
          ),
        };
      }
    }
    // Set once the fixed change has passed the checks and is kept on the host: from then on a
    // second review that fails ends with it, not with the first change (which the fix replaced).
    let kept: { outcome: typeof outcome; applied: FixRecord } | undefined;
    try {
      this.progress(`${implementer} fixes the ${sent} problem(s) the review found`);
      const turn = await this.agentTurn(
        implementer,
        new LoopDetector(this.runner.loopLimits),
        undefined,
        () =>
          fixBrief({
            repo: task.repo,
            baseSha,
            dir: this.ws.dir,
            goal: task.goal,
            testCommand: task.testCommand,
            findings: p1,
            conductorBrief,
          }),
        { phase: 'review', ...this.settingsOf(implementerFor, implementer) },
      );
      if ('loop' in turn) return { outcome, review: notApplied(`the fix stopped: ${turn.loop}`) };
      if (!turn.ok) {
        return {
          outcome,
          review: notApplied(
            this.budgetStop
              ? `the fix ran out of the review's budget (${this.budgetStop})`
              : `the fix run failed: ${turn.reason}`,
          ),
        };
      }
      const checks: CheckResult[] = [];
      const checked = await this.check(task, baseSha, checks);
      if (!checked.ok) {
        return {
          outcome,
          review: notApplied(`the fixed change failed the checks: ${checked.problem}`),
        };
      }
      const collected = await this.collect(task, baseSha);
      if ('reason' in collected) {
        return {
          outcome,
          review: notApplied(`the fixed change could not be read (${collected.reason})`),
        };
      }
      const fixed = { repro: checked.repro, manifest: turn.manifest, collected };
      // The fix's own spend may have used the cap: the second review then cannot start, and says so.
      this.budgetStop = undefined;
      // The fixed change has passed the checks: it, not the first one, is what a stop during the
      // second review must leave kept.
      const applied: FixRecord = { sent, result: 'applied' };
      await this.keepUntilReviewed(task, verification, fixed, { ...first, fix: applied });
      kept = { outcome: fixed, applied };
      const second = await this.review(task, baseSha, conductorBrief, implementer, fixed);
      if (second.status !== 'reviewed') {
        return {
          outcome: fixed,
          review: {
            ...second,
            reason: plain(notReviewedAgain(first, second.reason), 300),
            fix: applied,
          },
        };
      }
      return { outcome: fixed, review: { ...second, fix: applied } };
    } catch (error) {
      if (this.cancelled || error instanceof CancelledError) throw error;
      if (kept) {
        // The fixed change passed the checks and is the one on the host: it is kept unreviewed.
        return {
          outcome: kept.outcome,
          review: {
            ...first,
            status: 'unavailable',
            reviewer: first.reviewer,
            reason: plain(
              `the fixed change could not be reviewed again (${errorMessage(error)})`,
              300,
            ),
            fix: kept.applied,
          },
        };
      }
      return { outcome, review: notApplied(errorMessage(error)) };
    } finally {
      this.budgetStop = undefined;
    }
  }

  /** A small file in the task directory, read as the sandbox user: no symlink, no more than `max` bytes. */
  private async readTaskFile(
    name: string,
    max: number,
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
    const out = (
      await this.exec(READ_SMALL_SCRIPT, { MAKA_FILE: name, MAKA_MAX: String(max) })
    ).stdout.trim();
    if (!out.startsWith('OK ')) {
      const why: Record<string, string> = {
        MISSING: `${name} was not written`,
        SYMLINK: `${name} is a symlink`,
        NOTFILE: `${name} is not a regular file`,
        TOOBIG: `${name} is larger than ${max} bytes`,
      };
      return { ok: false, reason: why[out] ?? `${name} could not be read` };
    }
    return { ok: true, text: Buffer.from(out.slice(3), 'base64').toString('utf8') };
  }

  // -- checks --------------------------------------------------------------------------------------

  /**
   * The runner's own check of the work: the reproduction test passes with the change, the
   * repository's tests pass, and the reproduction test fails with every other change reverted.
   */
  private async check(
    task: CodingTask,
    baseSha: string,
    checks: CheckResult[],
  ): Promise<CheckOutcome> {
    const repro = await this.readRepro();
    if ('problem' in repro) return { ok: false, ...repro };

    this.progress('running the reproduction test');
    const onChange = await this.runCheck('repro', repro.command);
    checks.push(onChange);
    if (onChange.exitCode !== 0) {
      return {
        ok: false,
        problem: `the reproduction test \`${repro.command}\` fails with your change (${describeEnd(onChange)})`,
        output: onChange.output,
      };
    }

    this.progress(`running ${task.testCommand}`);
    const tests = await this.runCheck('tests', task.testCommand);
    checks.push(tests);
    if (tests.exitCode !== 0) {
      return {
        ok: false,
        problem: `\`${task.testCommand}\` fails (${describeEnd(tests)})`,
        output: tests.output,
      };
    }

    this.progress('running the reproduction test without the change');
    const onBase = await this.onBase(baseSha, repro, () =>
      this.runCheck('repro-base', repro.command),
    );
    if ('problem' in onBase) return { ok: false, ...onBase };
    checks.push(onBase);
    if (onBase.exitCode === 0) {
      return {
        ok: false,
        problem: `the reproduction test \`${repro.command}\` also passes with your changes outside its files reverted, so it does not reproduce the problem`,
        output: onBase.output,
      };
    }
    // Only a failure of the test itself shows the problem: not a timeout, a crash or a command
    // that could not run.
    const why = notATestFailure(onBase);
    if (why !== undefined) {
      return {
        ok: false,
        problem: `the reproduction test \`${repro.command}\` ${why} with your changes outside its files reverted, so it does not show the problem; it must fail by itself there, with an exit code from 1 to 124, within the time limit`,
        output: onBase.output,
      };
    }
    return { ok: true, repro };
  }

  private async readRepro(): Promise<Repro | CheckProblem> {
    const out = (
      await this.exec(READ_SMALL_SCRIPT, {
        MAKA_FILE: REPRO_FILE,
        MAKA_MAX: String(MAX_REPRO_BYTES),
      })
    ).stdout.trim();
    if (!out.startsWith('OK ')) {
      const why: Record<string, string> = {
        MISSING: 'repro.json was not written',
        SYMLINK: 'repro.json is a symlink',
        NOTFILE: 'repro.json is not a regular file',
        TOOBIG: `repro.json is larger than ${MAX_REPRO_BYTES} bytes`,
      };
      return { problem: why[out] ?? 'repro.json could not be read' };
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(out.slice(3), 'base64').toString('utf8'));
    } catch {
      return { problem: 'repro.json is not valid JSON' };
    }
    const parsed = ReproSchema.safeParse(value);
    if (!parsed.success) {
      return {
        problem: `repro.json must be {"command": "...", "files": ["..."]} (${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
          .join('; ')})`,
      };
    }
    const bad = parsed.data.files.filter((file) => !isRepoPath(file));
    if (bad.length > 0) {
      return { problem: `repro.json lists paths outside the repository: ${bad.join(', ')}` };
    }
    return parsed.data;
  }

  /** Runs `work` with every change outside the reproduction test reverted, then puts it back. */
  private async onBase<T>(
    baseSha: string,
    repro: Repro,
    work: () => Promise<T>,
  ): Promise<T | CheckProblem> {
    this.baseCheckActive = true;
    try {
      const out = (
        await this.exec(BASE_REVERT_SCRIPT, {
          MAKA_BASE: baseSha,
          MAKA_KEEP: repro.files.join('\n'),
        })
      ).stdout;
      if (!/^REVERTED \d+$/mu.test(out)) {
        return {
          problem: `the change could not be reverted for the base check (${clipText(out.trim(), 200)})`,
        };
      }
      return await work();
    } finally {
      // On a cancel the cleanup restores the change, after the check is stopped.
      if (!this.signal.aborted) {
        await this.restoreBase(this.signal);
      }
    }
  }

  private async restoreBase(signal: AbortSignal | undefined): Promise<void> {
    const out = await this.ws.exec(BASE_RESTORE_SCRIPT, {
      envs: { MAKA_DIR: this.ws.dir },
      ...(signal ? { signal } : {}),
    });
    if (!out.stdout.includes('RESTORED')) {
      throw new Error(
        `the change could not be put back after the base check: ${out.stdout.trim()}`,
      );
    }
    this.baseCheckActive = false;
  }

  /**
   * Runs a check in the sandbox as one exec, in its own PID namespace, and takes its exit status
   * from the exec's result, which the sandbox API reports: nothing the check writes is read as its
   * result. When the exec returns normally the namespace is gone, and with it everything the check
   * started; the stop that follows also ends a check whose exec did not return normally.
   */
  private async runCheck(name: string, command: string): Promise<CheckResult> {
    const { stats } = this.runner;
    const tag = `${checkTagPrefix(this.spec.taskId)}${checkAttemptMark(this.spec.epoch)}${++this.checkCount}-${randomBytes(8).toString('hex')}`;
    const timeoutSeconds = Math.max(1, Math.ceil(this.limits.checkTimeoutMs / 1000));
    stats.checks++;
    try {
      const startedAt = Date.now();
      let out: Awaited<ReturnType<SandboxWorkspace['exec']>>;
      try {
        out = await this.execCheck(
          CHECK_SCRIPT,
          {
            MAKA_CHECK_TAG: tag,
            MAKA_CMD: command,
            MAKA_TIMEOUT: String(timeoutSeconds),
            MAKA_TAIL: String(this.limits.outputTailBytes),
          },
          timeoutSeconds + CHECK_EXEC_SLACK_SECONDS,
        );
      } finally {
        // On a cancel the cleanup stops every check of the task.
        if (!this.signal.aborted) await this.stopCheck(tag);
      }
      const elapsedMs = Date.now() - startedAt;
      const notIsolated = /^maka-check: (.*)$/mu.exec(out.stderr);
      if (notIsolated) throw new Error(`the check ${name} could not run: ${notIsolated[1]}`);
      const bytes = /^BYTES (\d+)$/mu.exec(out.stderr);
      const result = { name, command, outputBytes: Number(bytes?.[1] ?? 0), output: out.stdout };
      if (out.timedOut) {
        return { ...result, exitCode: -1, timedOut: true };
      }
      const timedOut =
        (out.exitCode === 124 || out.exitCode === 137) && elapsedMs >= timeoutSeconds * 1000;
      return { ...result, exitCode: out.exitCode, ...(timedOut ? { timedOut: true } : {}) };
    } finally {
      stats.checks--;
    }
  }

  /** Stops one check's namespace, whatever its exec did. */
  private async stopCheck(tag: string): Promise<void> {
    const out = (
      await this.execCheckStop(CHECK_STOP_SCRIPT, { MAKA_CHECK_TAG: tag })
    ).stdout.trim();
    if (out !== 'NONE' && out !== 'STOPPED') {
      throw new Error(`a check's processes could not be stopped (${clipText(out, 200)})`);
    }
  }

  // -- the change ----------------------------------------------------------------------------------

  /** Reads the change out of the sandbox as git would commit it, checking every blob's hash. */
  private async collect(
    task: CodingTask,
    baseSha: string,
  ): Promise<Collected | { reason: string }> {
    const out = await this.exec(CHANGES_SCRIPT, { MAKA_BASE: baseSha });
    if (out.truncated) return { reason: 'the change is too large to read' };
    const lines = out.stdout.split('\n');
    const err = lines.find((line) => line.startsWith('ERR '));
    if (err) return { reason: `git could not list the change (${err.slice(4)})` };
    const raw = lines.find((line) => line.startsWith('RAW '));
    const patchLine = lines.find((line) => line.startsWith('PATCH '));
    if (raw === undefined || patchLine === undefined)
      return { reason: 'git could not list the change' };
    const sizes = new Map<string, number>();
    for (const line of lines) {
      const match = /^SIZE ([0-9a-f]{40}) (\d+)$/u.exec(line);
      if (match) sizes.set(match[1] as string, Number(match[2]));
    }

    const fields = Buffer.from(raw.slice(4), 'base64').toString('utf8').split('\0');
    const entries: { path: string; status: string; mode: string; sha: string }[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/u.exec(
        fields[i] as string,
      );
      if (!meta) return { reason: 'git listed the change in an unexpected form' };
      entries.push({
        path: fields[i + 1] as string,
        status: meta[5] as string,
        mode: meta[2] as string,
        sha: meta[4] as string,
      });
    }
    if (entries.length === 0) return { reason: 'there is no change against the base commit' };
    if (entries.length > this.limits.maxFiles) {
      return {
        reason: `the change touches ${entries.length} files, more than ${this.limits.maxFiles}`,
      };
    }

    const files: ChangedFile[] = [];
    let total = 0;
    for (const entry of entries) {
      if (!isRepoPath(entry.path))
        return { reason: `the change has an unsafe path: ${entry.path}` };
      if (entry.status === 'D') {
        files.push({ path: entry.path, status: 'deleted' });
        continue;
      }
      if (entry.mode === '120000')
        return { reason: `${entry.path} is a symlink; symlinks are not delivered` };
      if (entry.mode === '160000')
        return { reason: `${entry.path} is a nested repository; submodules are not delivered` };
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        return { reason: `${entry.path} has an unsupported file mode ${entry.mode}` };
      }
      if (entry.status !== 'A' && entry.status !== 'M' && entry.status !== 'T') {
        return { reason: `${entry.path} has an unexpected change type ${entry.status}` };
      }
      const size = sizes.get(entry.sha);
      if (size === undefined) return { reason: `${entry.path} could not be read` };
      if (size > this.limits.maxFileBytes) {
        return { reason: `${entry.path} is ${size} bytes, more than ${this.limits.maxFileBytes}` };
      }
      total += size;
      if (total > this.limits.maxTotalBytes) {
        return {
          reason: `the changed files are larger than ${this.limits.maxTotalBytes} bytes together`,
        };
      }
      const content = await this.readChunks(BLOB_CHUNK_SCRIPT, size, { MAKA_SHA: entry.sha });
      if (content.length !== size || gitBlobSha(content) !== entry.sha) {
        return { reason: `${entry.path} changed while it was read; try again` };
      }
      files.push({
        path: entry.path,
        status: entry.status === 'A' ? 'added' : 'modified',
        mode: entry.mode,
        blobSha: entry.sha,
        contentBase64: content.toString('base64'),
      });
    }

    const patchBytes = Number(patchLine.slice(6));
    const keep = Math.min(patchBytes, this.limits.maxPatchBytes);
    let patch = (await this.readChunks(PATCH_CHUNK_SCRIPT, keep, {})).toString('utf8');
    if (patchBytes > keep) patch += `\n[change.patch cut at ${keep} of ${patchBytes} bytes]\n`;
    return { changeSet: { repo: task.repo, baseSha, files }, patch };
  }

  private async readChunks(
    script: string,
    size: number,
    envs: Record<string, string>,
  ): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < size; offset += BLOB_CHUNK_BYTES) {
      const out = await this.exec(script, {
        ...envs,
        MAKA_OFF: String(offset),
        MAKA_LEN: String(Math.min(BLOB_CHUNK_BYTES, size - offset)),
      });
      if (out.exitCode !== 0) throw new Error(`reading the change failed (exit ${out.exitCode})`);
      parts.push(Buffer.from(out.stdout.trim(), 'base64'));
    }
    return Buffer.concat(parts);
  }

  /**
   * Keeps the change that passed the checks, as one the owner is to look at, before anything
   * else happens to it. Its reason is the one that stands if the task ends in the review: a stop, a
   * crash or an error. The write needs no workspace and no agent, and a stop that arrives during it
   * does not cut it short (`cancel` waits for it).
   */
  private keepUntilReviewed(
    task: CodingTask,
    verification: Verification,
    outcome: { repro: Repro; manifest: ResultManifest; collected: Collected },
    earlier?: ReviewRecord,
  ): Promise<void> {
    const reason = earlier
      ? "the fix passed the repository's checks, but the task ended before the independent review of the fixed change finished"
      : "the change passed the repository's checks, but the task ended before its independent review finished";
    // After a fix, the review so far (what it found and that the fix was applied) is kept with it.
    const pending: ReviewRecord = earlier ?? {
      mode: this.mode,
      modesVersion: this.options.modes?.version ?? 0,
      status: 'unavailable',
      reason,
    };
    this.keeping = this.deliver(task, verification, outcome, pending, reason, false);
    return this.keeping;
  }

  /**
   * Writes the verified change and its record next to the result, and records the delivery.
   * `cancellable: false` finishes the writes even when the task is stopped meanwhile.
   */
  private async deliver(
    task: CodingTask,
    verification: Verification,
    outcome: { repro: Repro; manifest: ResultManifest; collected: Collected },
    review: ReviewRecord,
    kept?: string,
    cancellable = true,
  ): Promise<void> {
    const guard = <T>(promise: Promise<T>): Promise<T> =>
      cancellable ? this.guard(promise) : promise;
    // The delivery record points at files that are never written twice: their names carry their
    // hashes. A restart between the writes below then finds the earlier delivery as it was left, not
    // a record whose change was replaced under it (`change_modified`, for good). The record is
    // swapped in one atomic write; the files under their plain names are what the task page lists.
    const changes = JSON.stringify(outcome.collected.changeSet);
    const changesSha256 = createHash('sha256').update(changes).digest('hex');
    const changesPath = join(this.hostDir, `changes.${changesSha256.slice(0, 16)}.json`);
    const reviewText = reviewMarkdown(review);
    verification.review = summarizeReview(review, reviewText);
    if (kept !== undefined) verification.kept = { reason: plain(kept, 300) };
    else delete verification.kept;
    // What was checked and what is delivered are the same change: after a fix that is the fixed one,
    // not the first attempt the review looked at.
    verification.repro = outcome.repro;
    verification.changedFiles = outcome.collected.changeSet.files.map((file) => ({
      path: file.path,
      status: file.status,
    }));
    const verificationText = JSON.stringify(verification, null, 2);
    const verificationPath = join(
      this.hostDir,
      `verification.${createHash('sha256').update(verificationText).digest('hex').slice(0, 16)}.json`,
    );
    await guard(writeHostFile(changesPath, changes));
    await guard(writeHostFile(verificationPath, verificationText));
    await guard(
      this.options.deliveries.record({
        taskId: this.spec.taskId,
        repo: task.repo,
        baseRef: task.baseRef,
        baseSha: verification.baseSha,
        changesPath,
        changesSha256,
        verificationPath,
      }),
    );
    // review.md before verification.json: that holds its hash, and the supervisor holds the two together.
    await guard(writeHostFile(join(this.hostDir, 'changes.json'), changes));
    await guard(writeHostFile(join(this.hostDir, 'change.patch'), outcome.collected.patch));
    await guard(writeHostFile(join(this.hostDir, 'review.md'), reviewText));
    await guard(writeHostFile(join(this.hostDir, 'verification.json'), verificationText));
    const agent = outcome.manifest;
    const files = outcome.collected.changeSet.files;
    const vendors = verification.attempts.map((attempt) => attempt.vendor);
    const manifest: ResultManifest = {
      summary:
        kept === undefined
          ? `Verified change to ${task.repo}: ${agent.summary}`
          : `Kept for you to look at, not delivered: ${plain(kept, 300)}.`,
      done: [
        verifiedLine(task, outcome.repro, verification.baseSha),
        reviewLine(review),
        ...(kept === undefined ? [] : [`kept: ${plain(kept, 300)}`]),
        `${files.length} file(s) changed: ${clipText(files.map((file) => file.path).join(', '), 500)}`,
        ...(vendors.length > 1
          ? [
              `${vendors[0]} failed (${verification.attempts[0]?.end ?? 'unknown'}); ${vendors[1]} made the change`,
            ]
          : []),
        ...agent.done.map((line) => `agent: ${line}`),
      ],
      notDone: agent.notDone,
      confidence: kept === undefined ? agent.confidence : 'low',
      knownIssues:
        kept === undefined ? agent.knownIssues : [plain(kept, 300), ...agent.knownIssues],
      artifacts: ['change.patch', 'changes.json', 'verification.json', 'review.md'],
    };
    await guard(writeHostFile(this.spec.resultPath, JSON.stringify(manifest)));
  }

  /** Both vendors failed: an honest manifest of what was tried. */
  private async giveUp(
    task: CodingTask,
    verification: Verification,
    failure: FailureBrief | undefined,
  ): Promise<void> {
    await this.guard(
      writeHostFile(join(this.hostDir, 'verification.json'), JSON.stringify(verification, null, 2)),
    );
    const reasons = verification.attempts.map(
      (attempt) => `${attempt.vendor}: ${attempt.end ?? 'unknown'}`,
    );
    const lastRun = failure?.runs.at(-1);
    const manifest: ResultManifest = {
      summary: `No verified change to ${task.repo}: both runners failed the checks.`,
      done: verification.attempts.map(
        (attempt) =>
          `${attempt.vendor} tried ${attempt.turns.length} run(s): ${attempt.end ?? 'unknown'}`,
      ),
      notDone: [task.goal],
      confidence: 'low',
      knownIssues: [
        ...reasons,
        ...(lastRun ? [`last run: ${clipText(lastRun.outcome, 500)}`] : []),
      ],
      artifacts: ['failure_brief.json', 'verification.json'],
    };
    if (failure) {
      await this.guard(
        writeHostFile(join(this.hostDir, 'failure_brief.json'), JSON.stringify(failure, null, 2)),
      );
    }
    await this.guard(writeHostFile(this.spec.resultPath, JSON.stringify(manifest)));
  }

  /** Saves the failed attempt and its failure brief, and puts the workspace back at the base commit. */
  private async handOver(task: CodingTask, baseSha: string, failure: FailureBrief): Promise<void> {
    const changes = await this.exec(CHANGES_SCRIPT, { MAKA_BASE: baseSha });
    if (/^PATCH \d+$/mu.test(changes.stdout)) {
      await this.exec(`set -eu\ncd "$MAKA_DIR"\nmv -f change.patch attempt-1.patch\n`, {});
    } else {
      await this.writeSandboxFile('attempt-1.patch', '');
    }
    const json = JSON.stringify(failure, null, 2);
    await this.guard(writeHostFile(join(this.hostDir, 'failure_brief.json'), json));
    await this.writeSandboxFile('failure_brief.json', json);
    await this.publishForAgent('failure_brief.json');
    await this.publishForAgent('attempt-1.patch');
    await this.removeAgentFile(REPRO_FILE);
    const sha = await this.clone(task, baseSha);
    if (sha !== baseSha) throw new Error(`the base commit changed from ${baseSha} to ${sha}`);
  }

  private async clone(task: CodingTask, ref: string): Promise<string> {
    const url = this.options.repoUrl?.(task.repo) ?? `https://github.com/${task.repo}.git`;
    const out = (await this.exec(CLONE_SCRIPT, { MAKA_REPO_URL: url, MAKA_REF: ref }, 600)).stdout;
    const base = /^BASE ([0-9a-f]{40})$/mu.exec(out);
    if (!base) {
      const detail = out.replace(/^CLONE_FAILED\s*/u, '').trim();
      throw new Error(
        `could not fetch ${task.repo} at ${ref}${detail ? `: ${clipText(detail, 500)}` : ''} (only public repositories are supported)`,
      );
    }
    return base[1] as string;
  }

  /** Removes a file the agent wrote in handoff/; one that cannot be removed fails the step. */
  private async removeAgentFile(name: string): Promise<void> {
    const out = await this.exec(`set -eu\ncd "$MAKA_DIR"\nrm -f -- ${name}\n`, {});
    if (out.exitCode !== 0) throw new Error(`could not remove ${name} before the next agent run`);
  }

  /** A file of the task directory, copied where the agent's account can read it. */
  private async publishForAgent(name: string): Promise<void> {
    const out = await this.ws.exec(PUBLISH_FILE_SCRIPT, {
      envs: { MAKA_DIR: this.ws.dir, MAKA_FILE: name },
      signal: this.signal,
    });
    if (out.exitCode !== 0) throw new Error(`could not make ${name} readable for the agent`);
  }

  private async writeSandboxFile(name: string, content: string): Promise<void> {
    const out = await this.ws.exec(WRITE_FILE_SCRIPT, {
      envs: { MAKA_DIR: this.ws.dir, MAKA_FILE: name },
      stdin: content,
      signal: this.signal,
    });
    if (out.exitCode !== 0) throw new Error(`could not write ${name} in the sandbox`);
  }

  // -- plumbing ------------------------------------------------------------------------------------

  private get ws(): SandboxWorkspace {
    if (!this.workspace) throw new CancelledError();
    return this.workspace;
  }

  private exec(script: string, envs: Record<string, string>, timeoutSeconds = 60) {
    return this.guard(
      this.ws.exec(script, {
        envs: { MAKA_DIR: this.ws.dir, ...envs },
        timeoutSeconds,
        signal: this.signal,
      }),
    );
  }

  /** As `exec`, but for a check: it runs as the agent's account (see `SandboxWorkspace.execCheck`). */
  private execCheck(script: string, envs: Record<string, string>, timeoutSeconds = 60) {
    return this.guard(
      this.ws.execCheck(script, {
        envs: { MAKA_DIR: this.ws.dir, ...envs },
        timeoutSeconds,
        signal: this.signal,
      }),
    );
  }

  private execCheckStop(script: string, envs: Record<string, string>, timeoutSeconds = 60) {
    return this.guard(
      this.ws.execCheckStop(script, {
        envs: { MAKA_DIR: this.ws.dir, ...envs },
        timeoutSeconds,
        signal: this.signal,
      }),
    );
  }

  private adoptAgent(handle: RunHandle): void {
    this.agentHandle = handle;
    this.runner.stats.agentRuns++;
    if (this.cleanupPromise) void this.releaseAgent(handle);
  }

  /** Stops an agent run and waits for its own cleanup. Once per handle. */
  private releaseAgent(handle: RunHandle): Promise<void> {
    let released = this.agentReleases.get(handle);
    if (!released) {
      released = this.step('stop agent run', () => handle.cancel(), true).finally(() => {
        if (this.agentHandle === handle) this.agentHandle = undefined;
        this.runner.stats.agentRuns--;
      });
      this.agentReleases.set(handle, released);
    }
    return released;
  }

  private adoptWorkspace(workspace: SandboxWorkspace): void {
    this.workspace = workspace;
    this.runner.stats.workspaces++;
    if (this.cleanupPromise) void this.step('release sandbox', () => this.releaseWorkspace());
  }

  private async releaseWorkspace(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    this.workspace = undefined;
    try {
      await workspace.release();
    } finally {
      this.runner.stats.workspaces--;
    }
  }

  /** Waits for `promise`, but not past a cancel. */
  private guard<T>(promise: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      promise.catch(() => undefined);
      return Promise.reject(new CancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new CancelledError());
      this.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          this.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          this.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private checkCancelled(): void {
    if (this.signal.aborted) throw new CancelledError();
  }

  /**
   * Reports what the task has spent so far, as the total of its agent runs. Returns true once
   * that reaches the task's budget. `final` reports after the task ended: its last spend.
   */
  private meter(total: number, final = false): boolean {
    const spent = roundUsd(total);
    if (spent !== this.lastReportedUsd && (!this.ended || final)) {
      this.lastReportedUsd = spent;
      this.events.push({ type: 'usage', costUsd: spent });
    }
    const limit = this.limitUsd;
    if (limit === undefined || spent < limit || this.budgetStop) return false;
    this.budgetStop = budgetReached(limit, spent);
    this.progress(this.budgetStop);
    return true;
  }

  private progress(note: string): void {
    if (this.ended) return;
    this.events.push({ type: 'progress', note: clipText(note, MAX_NOTE_CHARS) });
  }

  /** A failing step is reported and the cleanup goes on; one that `stops` something also fails `cancel`. */
  private async step(name: string, work: () => Promise<void>, stops = false): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (stops) {
        this.stopFailure ??= new Error(clipText(`${name} failed: ${errorMessage(error)}`, 300));
      }
      this.options.onCleanupError?.({ taskId: this.spec.taskId, step: name, error });
    }
  }

  /**
   * Releases everything the task holds, once, on every exit: the agent run, a running check,
   * a base check's reverted files, and the sandbox lease.
   */
  private cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      const handle = this.agentHandle;
      if (handle) await this.releaseAgent(handle);
      const workspace = this.workspace;
      // Everything the task's agent runs and checks started is stopped, however the task ended.
      if (workspace) await this.step('stop checks', () => workspace.stopAll(), true);
      if (workspace && this.baseCheckActive) {
        await this.step('restore the change', () => this.restoreBase(undefined));
      }
      await this.step('release sandbox', () => this.releaseWorkspace());
    })();
    return this.cleanupPromise;
  }
}

/** What identifies a collected change: the hash of its change set. */
function changeKey(collected: Collected): string {
  return createHash('sha256').update(JSON.stringify(collected.changeSet)).digest('hex');
}

function verifiedLine(task: CodingTask, repro: Repro, baseSha: string): string {
  return `verified: \`${task.testCommand}\` passed; the reproduction test \`${repro.command}\` failed on base ${baseSha.slice(0, 12)} and passes with the change`;
}

async function writeHostFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
