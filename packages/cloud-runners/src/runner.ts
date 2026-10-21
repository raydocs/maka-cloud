import { randomBytes } from 'node:crypto';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  type Recovery,
  type RunHandle,
  type Runner,
  type RunnerEvent,
  ResultManifestSchema,
  type RunSpec,
  scrubSecretShapes,
  secretForms,
  type TaskId,
} from '@maka-cloud/orchestrator';
import { attestExports, exportArtifacts } from './export.js';
import type { Fleet } from './fleet.js';
import { type RemoteMachine, runNameOf } from './machine.js';
import { type InputRequest, parseBriefHeader } from './inputs.js';
import { LineSplitter } from './lines.js';
import { type AgentChannel, asAgent } from './agent-user.js';
import { ExecProcess, FEED_FUNCTION, fedCommand } from './process-channel.js';
import { type AgentSdk, startAgentQuery } from './sdk-turn.js';
import {
  restoreTranscript,
  type TranscriptLine,
  type TranscriptMirror,
  transcriptSessionStore,
} from './transcripts.js';
import { buildRunScript } from './scripts.js';
import { errorMessage, shq } from './shell.js';
import {
  MAX_STEER_RECEIPTS,
  newReceipt,
  receiptIsFor,
  receiptsShownIn,
  type SteerReceipt,
} from './steer-receipts.js';
import type { ModelAccess, RunnerSessionRecord, SandboxLease } from './types.js';
import {
  DEFAULT_PRICES,
  preambleFor,
  runSettingsProblem,
  type TokenPrices,
  tokenCostUsd,
  type VendorAdapter,
} from './vendors.js';

const DEFAULT_MAX_NOTES = 300;
const CLEANUP_STEP_MS = 20_000;
const RAW_TAIL_LINES = 8;
/** Longest output line the runner holds on to; the rest of a longer one is dropped. */
const MAX_LINE_CHARS = 1_048_576;
/** Longest piece of CLI output quoted in a failure reason. */
const MAX_QUOTED_CHARS = 300;
/** Longest failure reason, and progress note, sent to the orchestrator. */
const MAX_REASON_CHARS = 2_000;
const MAX_NOTE_CHARS = 500;
/** Pages one run may report as opened; the server keeps 20 a task anyway. */
const MAX_OPENED_PER_RUN = 40;
/** Progress notes that start with this are what the agent says it is doing (its in-progress todo item). */
const STEP_PREFIX = 'step: ';

class CancelledError extends Error {}

/** Push-based event stream with a single reader. */
class EventQueue implements AsyncIterable<RunnerEvent> {
  private readonly items: RunnerEvent[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  /** Queues `event`, unless the stream has closed; says whether it was queued. */
  push(event: RunnerEvent): boolean {
    if (this.closed) return false;
    this.items.push(event);
    this.wake?.();
    return true;
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

/** What a run starts: host shell before it, then the program, which always runs as the agent account. */
interface RunProgram {
  preamble: string;
  program: string;
  args: readonly string[];
  fed?: boolean;
}

/** The program and arguments of an argv. */
function splitProgram(argv: string[]): { program: string; args: string[] } {
  const [program, ...args] = argv;
  if (program === undefined) throw new Error('a run needs a program');
  return { program, args };
}

function manifestShape(): string {
  return [
    'a JSON object with exactly these fields:',
    '"summary" (string, not empty), "done" (array of strings), "notDone" (array of strings),',
    '"confidence" ("low", "medium" or "high"), "knownIssues" (array of strings),',
    'and optionally "artifacts" (array of strings)',
  ].join(' ');
}

export interface ResumeInput {
  /** What the agent is told in the resumed session. */
  prompt: string;
  spec: RunSpec;
}

function noAgentChannelReason(vendor: VendorAdapter): string {
  return `the ${vendor.binary} CLI needs an agent channel (a separate account for the agent) and none is configured`;
}

/** Runs one vendor's CLI inside a sandbox for each task, as the orchestrator's `Runner`. */
export class SandboxCliRunner implements Runner {
  constructor(
    private readonly fleet: Fleet,
    private readonly vendor: VendorAdapter,
  ) {}

  get name(): string {
    return this.vendor.name;
  }

  /** The Claude runs the SDK drives take messages for the agent, read after each of its steps. */
  get steerable(): boolean {
    return this.vendor.name === 'claude-agent-sdk' && this.fleet.options.agentSdk !== undefined;
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    return new Run(this.fleet, this.vendor, spec, undefined).begin();
  }

  /** Continues a task's vendor session (`--resume <id>`), on its machine or one restored from its snapshot. */
  async resume(taskId: TaskId, input: ResumeInput): Promise<RunHandle> {
    if (input.spec.taskId !== taskId) throw new Error('resume: spec.taskId does not match');
    return new Run(this.fleet, this.vendor, input.spec, input.prompt).begin();
  }

  /**
   * Called by the orchestrator after a restart, once `stopOrphaned` confirmed nothing of the earlier
   * attempt is left: continues the task's vendor session, telling the agent first what the step log
   * knows. A task with no recorded session fails with "nothing to resume", as `resume` does.
   */
  async recover(spec: RunSpec & { recovery: Recovery }): Promise<RunHandle> {
    return this.resume(spec.taskId, { prompt: spec.recovery.note, spec });
  }

  /** Called by the orchestrator on restart for a task that was running. Idempotent. */
  async stopOrphaned(
    taskId: TaskId,
    options: { signal?: AbortSignal; epoch?: number } = {},
  ): Promise<void> {
    await this.fleet.stopTask(taskId, options.signal, options.epoch);
  }
}

type TurnOutcome = { ok: true } | { ok: false; reason: string };

/** How a turn's process came to an end: `exit` is undefined for one that was killed. */
type Drive = { ended: true; exit: number | undefined } | { ended: false; outcome: TurnOutcome };

/** What the runner makes of one turn's output lines. */
interface TurnReader {
  push(bytes: Buffer): void;
  /** The output has ended: an unfinished last line is a line. */
  flush(): void;
  /** Why the turn failed, from how its process ended and what it said; undefined when it succeeded. */
  failure(exit: number | undefined): string | undefined;
}

/** How long the SDK's loop may be over before its process is given up on, in milliseconds. */
const STOP_WAIT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

class Run implements RunHandle {
  readonly events = new EventQueue();
  private readonly abort = new AbortController();
  private cancelled = false;
  private ended = false;
  /** How the run ended, reported once its model access has settled. */
  private terminal: RunnerEvent | undefined;
  private notes = 0;
  private openedPages = 0;
  private lastNote = '';
  /** Dollars spent by the CLI invocations of this run that have ended. */
  private spentBefore = 0;
  /** The current invocation: an estimate per model call, until the CLI reports its own total. */
  private callCosts = new Map<string, number>();
  private reportedTotal: number | undefined;
  /** The spend last queued as a `usage` event: only an event actually queued moves it. */
  private publishedUsd = -1;
  /** Set once the run has spent its budget: the reason it stops. */
  private budgetStop: string | undefined;
  /**
   * Set when a cleanup step that stops the run failed or ran out of time: its processes may be
   * running or its model access may still be live. `cancel` refuses with it, so the stop stays owed.
   */
  private stopFailure: Error | undefined;
  private readonly secrets = new Set<string>();
  /** Messages for the agent not yet read, and the keys of those it has (an offer repeated is ignored). */
  private readonly waitingSteers: Array<{ steerId: string; text: string }> = [];
  private readonly readSteers = new Set<string>();
  /** Messages given to the agent in a hook's answer (by key), not yet shown by the kept transcript. */
  private readonly handedSteers = new Map<string, SteerReceipt>();
  /** Hand-overs are one at a time: each writes its receipts down before the answer goes out. */
  private takeChain: Promise<unknown> = Promise.resolve();
  /** Set when a batch of the conversation could not be kept: the turn does not go on without it. */
  private mirrorFailure: string | undefined;
  /** Whether this run keeps the conversation's transcript off the sandbox (the proof a message was read). */
  private mirror: TranscriptMirror | undefined;
  /** On a run that continues an earlier one: the keys the kept transcript shows were given already. */
  private steerScan: Promise<void> | undefined;
  private steersToVet: Array<{ steerId: string; text: string }> = [];
  /** Paths the brief says the task must hand back. */
  private requiredArtifacts: string[] = [];
  private machine: RemoteMachine | undefined;
  /** The task goes on in a new sandbox from its stored conversation: its files are not there. */
  private freshBox = false;
  private record: RunnerSessionRecord | undefined;
  private access: ModelAccess | undefined;
  /** What the gateway settled for this run's access, when the access is metered. */
  private meteredUsd: number | undefined;
  private stopMetering: (() => void) | undefined;
  /**
   * The release of a metered access, shared by every caller until it has settled: the stream
   * stays open for its final spend, past a step's time limit too. An unmetered access has no spend
   * to wait for, so its release is only ever waited for within the time limit.
   */
  private releasing: Promise<void> | undefined;
  private lease: SandboxLease | undefined;
  private runName: string | undefined;
  /** Every CLI run this object started, which are the only ones its cleanup may stop. */
  private readonly runNames: string[] = [];
  private stopWatch: (() => void) | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private renewing: Promise<void> | undefined;
  private cleanupPromise: Promise<void> | undefined;

  constructor(
    private readonly fleet: Fleet,
    private readonly vendor: VendorAdapter,
    private readonly spec: RunSpec,
    /** Set for a resume: the prompt to continue the existing session with. */
    private readonly resumePrompt: string | undefined,
  ) {}

  begin(): RunHandle {
    void this.execute();
    return this;
  }

  /**
   * Stops the run and releases everything it holds. The release does not wait for whatever the run
   * is in the middle of (an install, a snapshot, a provider call): those waits are cut short, and a
   * resource that turns up afterwards is released on arrival. Every call shares one cleanup.
   */
  async cancel(): Promise<void> {
    if (!this.ended) {
      this.cancelled = true;
      this.abort.abort();
    }
    await this.cleanup();
    // A cancel that returns says the run is stopped: when it could not be, it says so.
    if (this.stopFailure) throw this.stopFailure;
  }

  private get signal(): AbortSignal {
    return this.abort.signal;
  }

  /**
   * A message for the agent, read after its next step. Offering a key again changes nothing, and a
   * run that is over takes none: the orchestrator marks what it never read.
   */
  steer(message: { steerId: string; text: string }): void {
    if (this.ended || this.cancelled || this.readSteers.has(message.steerId)) return;
    if (this.waitingSteers.some((waiting) => waiting.steerId === message.steerId)) return;
    if (this.steersToVet.some((waiting) => waiting.steerId === message.steerId)) return;
    // A run that continues an earlier one may be offered a message the earlier run gave the agent
    // before it died, whose report was lost: the kept transcript says which.
    if (this.spec.recovery !== undefined && this.fleet.options.transcripts) {
      this.steersToVet.push(message);
      this.steerScan ??= this.vetSteers();
      return;
    }
    this.waitingSteers.push(message);
  }

  /**
   * Sorts the messages offered to a run that continues an earlier one. The receipts the earlier
   * run wrote down say which messages it handed to the agent; the kept transcript (the server's
   * copy) shows which of those the agent really has: a line that carries the receipt's reference
   * and text. Those are reported as read and never given again; every other message waits for the
   * next step. A message the transcript merely names, or one whose receipt it does not show, is
   * given (it may then be read twice, which is better than a message the agent never saw being
   * lost), and so is every message when the transcript cannot be read.
   */
  private async vetSteers(): Promise<void> {
    const shown = new Set<string>();
    try {
      const record = await this.fleet.sessions.get(this.spec.taskId);
      const sessionId = this.record?.sessionId ?? record?.sessionId;
      const receipts = (record?.steerReceipts ?? []).filter((receipt) =>
        this.steersToVet.some(
          (message) =>
            message.steerId === receipt.steerId &&
            receiptIsFor(receipt, this.scrubForReader(message.text)),
        ),
      );
      const transcripts = this.fleet.options.transcripts;
      if (sessionId !== undefined && transcripts && receipts.length > 0) {
        let cursor: number | undefined;
        do {
          const page = await transcripts.read(this.spec.taskId, sessionId, cursor);
          for (const line of page.lines) {
            for (const receipt of receiptsShownIn(line, receipts)) shown.add(receipt.steerId);
          }
          cursor = page.next;
        } while (cursor !== undefined);
      }
    } catch (error) {
      this.progress(
        `the kept conversation could not be read for messages already given: ${errorMessage(error)}`,
      );
    }
    for (const message of this.steersToVet.splice(0)) {
      if (this.ended || this.cancelled) continue;
      if (shown.has(message.steerId)) {
        this.readSteers.add(message.steerId);
        this.events.push({ type: 'steered', steerId: message.steerId });
      } else if (!this.readSteers.has(message.steerId)) {
        this.waitingSteers.push(message);
      }
    }
    this.steerScan = undefined;
  }

  /**
   * The kept transcript holds these lines (the ones the store committed): a message whose receipt
   * they show is now read, as far as anyone can prove, and only now is it reported.
   */
  private mirrorKept(lines: readonly TranscriptLine[]): void {
    if (this.handedSteers.size === 0) return;
    for (const line of lines) {
      for (const receipt of receiptsShownIn(line.json, this.handedSteers.values())) {
        if (this.handedSteers.get(receipt.steerId) !== receipt) continue;
        this.handedSteers.delete(receipt.steerId);
        this.events.push({ type: 'steered', steerId: receipt.steerId });
      }
    }
  }

  /** Drops a message the agent has not been given. False when it has been (or never was here). */
  unsteer(steerId: string): boolean {
    const at = this.waitingSteers.findIndex((waiting) => waiting.steerId === steerId);
    if (at < 0) return false;
    this.waitingSteers.splice(at, 1);
    return true;
  }

  /**
   * Hands the hook the messages that fit, as the hook returns them to the agent. The first always
   * goes, whatever its size; the rest wait for the next step. With the conversation kept off the
   * sandbox, a receipt for each is written down first (a failure leaves the messages waiting) and
   * a message is reported read when the kept transcript shows it (`mirrorKept`); without, there is
   * nothing to show it by, and handing it over is the proof.
   */
  private takeSteers(
    maxChars: number,
  ): Promise<Array<{ steerId: string; text: string; ref?: string }>> {
    const next = this.takeChain.then(() => this.handOver(maxChars));
    this.takeChain = next.catch(() => undefined);
    return next;
  }

  private async handOver(
    maxChars: number,
  ): Promise<Array<{ steerId: string; text: string; ref?: string }>> {
    const { fleet, spec } = this;
    const picked: Array<{ steerId: string; text: string }> = [];
    let chars = 0;
    for (const next of this.waitingSteers) {
      if (picked.length > 0 && chars + next.text.length > maxChars) break;
      chars += next.text.length;
      picked.push(next);
    }
    if (picked.length === 0) return [];
    const receipts = this.mirror
      ? picked.map((message) =>
          newReceipt(message.steerId, this.scrubForReader(message.text), fleet.now()),
        )
      : [];
    if (receipts.length > 0) {
      const ids = new Set(receipts.map((receipt) => receipt.steerId));
      this.record = await fleet.updateRecord(spec.taskId, (current) => ({
        ...(current ?? (this.record as RunnerSessionRecord)),
        steerReceipts: [
          ...(current?.steerReceipts ?? []).filter((receipt) => !ids.has(receipt.steerId)),
          ...receipts,
        ].slice(-MAX_STEER_RECEIPTS),
        updatedAt: fleet.now(),
      }));
    }
    const taken: Array<{ steerId: string; text: string; ref?: string }> = [];
    for (const [index, message] of picked.entries()) {
      // A message withdrawn while the receipts were written is not given.
      const at = this.waitingSteers.indexOf(message);
      if (at < 0) continue;
      this.waitingSteers.splice(at, 1);
      this.readSteers.add(message.steerId);
      const receipt = receipts[index];
      if (receipt) this.handedSteers.set(message.steerId, receipt);
      else this.events.push({ type: 'steered', steerId: message.steerId });
      taken.push({ ...message, ...(receipt ? { ref: receipt.ref } : {}) });
    }
    return taken;
  }

  // -- the run ---------------------------------------------------------------------------------

  private async execute(): Promise<void> {
    const { fleet, vendor, spec } = this;
    fleet.openRuns++;
    try {
      this.checkCancelled();
      // Before anything is issued or started: a model or effort that is not plain fails the run here.
      const unusable = runSettingsProblem(spec);
      if (unusable !== undefined) return this.fail(unusable);
      await this.guard(this.issueAccess());

      const acquired = await this.guard(this.prepareMachine());
      const machine = (this.machine = fleet.machine(acquired.record.machineId));
      let record = (this.record = acquired.record);
      this.startActivityLease(machine);

      // No account, or a box that does not keep it out, means nothing of the CLI runs: not its
      // version check, not its install, not the tools it is handed.
      const refused = await this.requireAgentAccount(fleet, machine, vendor);
      if (refused !== undefined) return this.fail(refused);
      await this.guard(fleet.ensureCli(machine, vendor));
      await this.guard(fleet.ensureTools(machine));
      this.checkCancelled();

      const dir = machine.taskDir(spec.taskId);
      const resumed = this.resumePrompt !== undefined;
      let staged = '';
      const brief = await this.guard(readFile(spec.briefPath, 'utf8'));
      const header = parseBriefHeader(brief);
      if (!header.ok) return this.fail(header.reason);
      this.requiredArtifacts = header.artifacts;
      if (resumed) {
        // A new sandbox has no brief: the conversation refers to it.
        await machine.prepare(
          spec.taskId,
          this.freshBox ? brief : undefined,
          this.signal,
          fleet.options.agentChannel?.group,
        );
      } else {
        await machine.prepare(spec.taskId, brief, this.signal, fleet.options.agentChannel?.group);
        if (header.requests.length > 0) {
          const copied = await this.guard(this.stageInputs(machine, header.requests));
          if (!copied.ok) return this.fail(copied.reason);
          staged = copied.note;
        }
      }

      let outcome = await this.turn(
        resumed
          ? this.resumedPrompt(dir, this.resumePrompt ?? '')
          : this.initialPrompt(dir, staged),
        resumed ? record.sessionId : undefined,
      );
      record = this.record ?? record;
      if (!outcome.ok) return this.fail(outcome.reason);

      let result = await this.acceptResult(machine);
      if (!result.ok && record.sessionId) {
        this.progress(
          result.artifacts
            ? `the result's artifacts were not accepted (${result.reason}); asking the agent to fix it`
            : `the result file was rejected (${result.reason}); asking the agent to rewrite it`,
        );
        outcome = await this.turn(
          result.artifacts
            ? `The result at ${dir}/handoff/result.json was read, but its artifacts were not accepted: ${result.reason}. Fix that (write the missing file under ${dir}/workspace, or list it in artifacts) and write ${dir}/handoff/result.json again as ${manifestShape()}. Then stop.`
            : `The result file at ${dir}/handoff/result.json was rejected: ${result.reason}. Write it again as ${manifestShape()}. Then stop.`,
          record.sessionId,
        );
        if (!outcome.ok) return this.fail(outcome.reason);
        result = await this.acceptResult(machine);
      }
      if (!result.ok) return this.fail(`invalid result: ${result.reason}`);

      await this.writeResult(result.bytes);
      this.checkCancelled();
      this.terminal = { type: 'finished' };
    } catch (error) {
      if (this.cancelled || error instanceof CancelledError) return;
      this.fail(errorMessage(error));
    } finally {
      // The last requests settle and their spend is reported before the end is.
      if (this.terminal !== undefined && this.access?.meter) {
        await this.step(
          'revoke model access',
          () => this.releaseAccess(),
          this.meteredUsd === undefined,
        );
        // A revoke past its time limit is reported, and still waited for: its cost comes first.
        await this.releasing;
      }
      this.ended = true;
      // Its end goes out from the cleanup, once the run is known to be stopped.
      await this.cleanup();
    }
  }

  /**
   * Reports how the run ended on its own, once the cleanup has run. An end tells the orchestrator
   * there is nothing left to stop, so it is not reported for a run whose stop failed: the stream
   * just closes, and the task ends with the stop owed (and retried by id).
   */
  private publishEnd(): void {
    if (this.terminal === undefined || this.cancelled) return;
    if (this.stopFailure) {
      this.events.push({
        type: 'progress',
        note: this.redact(
          `the run could not be confirmed stopped (${this.stopFailure.message}); its end is not reported and the stop stays owed`,
          MAX_NOTE_CHARS,
        ),
      });
      return;
    }
    this.events.push(this.terminal);
  }

  /**
   * Waits for `promise`, but not past a cancel: the run gets a `CancelledError` the moment it is
   * cancelled, and `promise` goes on without it (whatever it yields later is released by whoever
   * produced it, see `adoptAccess` and `adoptLease`).
   */
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

  private async issueAccess(): Promise<void> {
    const { fleet, spec, vendor } = this;
    const access = await fleet.modelAccess.issue({
      taskId: spec.taskId,
      runner: vendor.name,
      ...(spec.budgetUsd === undefined ? {} : { budgetUsd: spec.budgetUsd }),
      ...(spec.budgetRootId === undefined ? {} : { budgetRootId: spec.budgetRootId }),
      ...(spec.turnBudgetUsd === undefined ? {} : { turnBudgetUsd: spec.turnBudgetUsd }),
      ...(spec.epoch === undefined ? {} : { attempt: spec.epoch }),
    });
    this.adoptAccess(access);
    this.checkCancelled();
  }

  /** From here on the run owns this key; if the run is already being cleaned up, it goes at once. */
  private adoptAccess(access: ModelAccess): void {
    this.access = access;
    this.secrets.add(access.apiKey);
    if (this.spec.mcp) this.secrets.add(this.spec.mcp.token);
    if (this.cleanupPromise) {
      void this.step(
        'revoke model access',
        () => this.releaseAccess(),
        this.meteredUsd === undefined,
      );
      return;
    }
    const meter = access.meter;
    if (meter) {
      // Every request is metered when it settles, so the budget acts inside a CLI turn too.
      this.meteredUsd = meter.spentUsd();
      this.stopMetering = meter.subscribe((state) => {
        this.meteredUsd = state.spentUsd;
        if (state.exhausted && !this.budgetStop) {
          const limit = this.binding();
          this.budgetStop = limit
            ? `${limit.what} of ${usd(limit.usd)} reached (${usd(state.spentUsd)} spent)`
            : 'the model budget is used up';
        }
        this.meter();
      });
    }
  }

  private adoptLease(lease: SandboxLease): void {
    this.lease = lease;
    if (this.cleanupPromise) void this.step('release sandbox', () => this.releaseLease());
  }

  /** Picks the machine: acquired for a new task, the recorded one (or a restore) for a resume. */
  private async prepareMachine(): Promise<{ record: RunnerSessionRecord }> {
    const { fleet, vendor, spec } = this;
    const tenantId = fleet.tenantOf(spec.taskId);
    if (this.resumePrompt === undefined) {
      this.adoptLease(await fleet.sandboxes.acquire({ tenantId, taskId: spec.taskId }));
      this.checkCancelled();
      const machineId = (this.lease as SandboxLease).machineId;
      // A task handed to the other vendor starts afresh in the same directory: its runs keep
      // counting from the earlier ones, so a run name (and its lock file) is never reused.
      const record = await fleet.updateRecord(spec.taskId, (current) => ({
        taskId: spec.taskId,
        runner: vendor.name,
        tenantId,
        machineId,
        turns: current?.machineId === machineId ? current.turns : 0,
        snapshotIds: [],
        updatedAt: fleet.now(),
      }));
      return { record };
    }

    const existing = await fleet.sessions.get(spec.taskId);
    if (!existing || existing.runner !== vendor.name) {
      throw new Error(
        `nothing to resume: no ${vendor.name} session is recorded for ${spec.taskId}`,
      );
    }
    if (!existing.sessionId)
      throw new Error('nothing to resume: the CLI never reported a session id');
    if (await this.machineUsable(existing.machineId)) return { record: existing };

    const snapshotId = existing.snapshotIds.at(-1);
    if (!snapshotId || !fleet.sandboxes.restoreFromSnapshot) {
      // No sandbox and no snapshot: with the conversation kept off the sandbox, the task goes on
      // in a new one, without its files.
      if (await this.conversationKept(existing)) {
        this.adoptLease(
          await fleet.sandboxes.acquire({ tenantId: existing.tenantId, taskId: spec.taskId }),
        );
        this.checkCancelled();
        const machineId = (this.lease as SandboxLease).machineId;
        const record = await fleet.updateRecord(spec.taskId, (current) => ({
          ...(current ?? existing),
          machineId,
          snapshotIds: [],
          updatedAt: fleet.now(),
        }));
        this.freshBox = true;
        this.progress(
          'the sandbox is gone and has no snapshot: the task goes on in a new one from its stored conversation, without its files',
        );
        return { record };
      }
      throw new Error(
        'cannot resume: the sandbox is gone and there is no snapshot to restore it from',
      );
    }
    this.adoptLease(
      await fleet.sandboxes.restoreFromSnapshot({
        tenantId: existing.tenantId,
        taskId: spec.taskId,
        snapshotId,
      }),
    );
    this.checkCancelled();
    const machineId = (this.lease as SandboxLease).machineId;
    const record = await fleet.updateRecord(spec.taskId, (current) => ({
      ...(current ?? existing),
      machineId,
      updatedAt: fleet.now(),
    }));
    return { record };
  }

  /** Whether the transcript store holds this record's conversation, so a new sandbox can take it over. */
  private async conversationKept(record: RunnerSessionRecord): Promise<boolean> {
    const { fleet, vendor } = this;
    if (vendor.name !== 'claude-agent-sdk' || !fleet.options.agentSdk) return false;
    const store = fleet.options.transcripts;
    if (!store || !record.sessionId) return false;
    return (await store.locate(this.spec.taskId, record.sessionId)) !== undefined;
  }

  /**
   * Gets the conversation ready for an SDK turn when transcripts are kept: a resumed session is put
   * on the sandbox first if it is not there (a new sandbox, or one restored from an older snapshot),
   * and the SDK is given the store that keeps every line the CLI writes from here on. A resumed
   * session the store never saw (it began before transcripts were kept) goes on as it is on the
   * sandbox, unmirrored.
   */
  private async prepareMirror(
    machine: RemoteMachine,
    resumeSessionId: string | undefined,
  ): Promise<{ store: SessionStore; configDir: string } | undefined> {
    const { fleet, spec } = this;
    const transcripts = fleet.options.transcripts;
    if (!transcripts) return undefined;
    if (resumeSessionId) {
      let restored: Awaited<ReturnType<typeof restoreTranscript>>;
      try {
        restored = await this.guard(
          restoreTranscript({
            machine,
            store: transcripts,
            taskId: spec.taskId,
            sessionId: resumeSessionId,
            signal: this.signal,
          }),
        );
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        throw new Error(`the conversation could not be put on the sandbox: ${errorMessage(error)}`);
      }
      if (restored.status === 'absent') {
        this.progress(
          'this conversation was not kept off the sandbox (it began before that was on); this turn is not saved',
        );
        return undefined;
      }
      if (restored.status === 'restored') {
        this.progress(`the conversation (${restored.lines} lines) was put back on the sandbox`);
      }
    }
    const kept = transcriptSessionStore({
      taskId: spec.taskId,
      store: transcripts,
      onProblem: (message) => this.progress(message),
      onKept: (lines) => this.mirrorKept(lines),
    });
    this.mirror = kept;
    return {
      store: kept,
      configDir: machine.configDir(spec.taskId),
    };
  }

  private async machineUsable(machineId: string): Promise<boolean> {
    try {
      const machine = await this.fleet.client.getMachine(machineId, { signal: this.signal });
      return (
        machine.state !== 'deleted' && machine.state !== 'deleting' && machine.state !== 'error'
      );
    } catch (error) {
      if ((error as { status?: number }).status === 404) return false;
      throw error;
    }
  }

  /**
   * Copies the files the brief asked for from other tasks of the same tenant and sandbox into this
   * task's workspace. Nothing is copied unless the deployment's policy allows each source, and
   * a refusal ends the task before the CLI starts: an agent that is missing its inputs would
   * otherwise report on files it never saw. The checks that depend on shared state run again in
   * the sandbox (`STAGE_INPUTS_SCRIPT`), next to the copy.
   */
  private async stageInputs(
    machine: RemoteMachine,
    requests: InputRequest[],
  ): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
    const { fleet, spec } = this;
    const policy = fleet.options.inputs;
    if (!policy) {
      return {
        ok: false,
        reason: 'the brief asks for files of other tasks, which this deployment does not provide',
      };
    }
    const target = fleet.tenantOf(spec.taskId);
    const notes: string[] = [];
    for (const { source, paths } of requests) {
      const refusal = await this.inputRefusal(machine, policy, source, target);
      if (refusal !== undefined) return { ok: false, reason: `inputs from ${source}: ${refusal}` };
      const copied = await machine.stageInputs({
        fromDir: source,
        toDir: spec.taskId,
        paths,
        limits: fleet.stageLimits,
        signal: this.signal,
      });
      if (!copied.ok) return { ok: false, reason: `inputs from ${source}: ${copied.reason}` };
      notes.push(
        `${paths.join(', ')} of task ${source} (${copied.files} files) in inputs/${source}/`,
      );
    }
    return {
      ok: true,
      note: `Files of other tasks were copied into ${machine.taskDir(spec.taskId)}/workspace/: ${notes.join('; ')}. Read them there.`,
    };
  }

  private async inputRefusal(
    machine: RemoteMachine,
    policy: NonNullable<Fleet['options']['inputs']>,
    source: TaskId,
    targetTenant: string,
  ): Promise<string | undefined> {
    const { fleet, spec } = this;
    if (source === spec.taskId) return 'a task cannot take its own files as inputs';
    if (fleet.tenantOf(source) !== targetTenant) return 'that task belongs to another tenant';
    const record = await fleet.sessions.get(source);
    if (!record) return 'no sandbox is recorded for that task';
    if (record.machineId !== machine.machineId) {
      return 'its files are on another sandbox, and copying between sandboxes is not supported';
    }
    return await policy.check({ target: spec.taskId, source });
  }

  private initialPrompt(dir: string, staged = ''): string {
    return [
      `Read the brief at ${dir}/handoff/brief.md and carry it out. Work in ${dir}/workspace.`,
      ...(staged ? [staged] : []),
      `When you are finished, write ${dir}/handoff/result.json as ${manifestShape()}.`,
      'Write that file as the very last step, then stop. Report only what you actually did and checked.',
    ].join(' ');
  }

  /** A turn starts without the last turn's result.json, so a resumed turn is told to write it. */
  private resumedPrompt(dir: string, prompt: string): string {
    return [
      prompt,
      ...(this.freshBox
        ? [
            `The sandbox you were working in is gone and this is a new one. Your conversation is restored, but the files in ${dir}/workspace are not: only the brief (${dir}/handoff/brief.md) is here. Rebuild what you need from what you did before, and check what already reached the outside world (a push, a pull request, a message) before you do it again.`,
          ]
        : []),
      `When you are finished, write ${dir}/handoff/result.json as ${manifestShape()}.`,
      'Write that file as the very last step, then stop. Report only what you actually did and checked.',
    ].join('\n\n');
  }

  // -- one CLI invocation ------------------------------------------------------------------------

  private async turn(prompt: string, resumeSessionId: string | undefined): Promise<TurnOutcome> {
    const { fleet, vendor, spec } = this;
    const access = this.access as ModelAccess;
    const machine = this.machine as RemoteMachine;
    // `turns` and `sessionId` are this run's; the snapshot lists belong to the fleet.
    const turns = (this.record as RunnerSessionRecord).turns + 1;
    this.record = await this.guard(
      fleet.updateRecord(spec.taskId, (current) => ({
        ...(current ?? (this.record as RunnerSessionRecord)),
        turns,
        updatedAt: fleet.now(),
      })),
    );
    this.checkCancelled();

    const dir = machine.taskDir(spec.taskId);
    const run = runNameOf(spec.epoch, turns);
    this.runName = run;
    this.runNames.push(run);
    const runToken = randomBytes(16).toString('hex');
    this.secrets.add(runToken);
    const mcpUrl = spec.mcp
      ? (fleet.options.mcpUrlForSandbox?.(spec.mcp.url) ?? spec.mcp.url)
      : undefined;
    const model = spec.model ?? fleet.options.models?.[vendor.name];
    const envs = {
      ...vendor.env(access, spec.mcp?.token),
      ...(access.searchUrl
        ? { MAKA_SEARCH_URL: access.searchUrl, MAKA_SEARCH_TOKEN: access.apiKey }
        : {}),
    };
    const launchRun = (task: RunProgram, extraEnvs: Record<string, string> = {}) =>
      machine.launch({
        dirName: spec.taskId,
        run,
        ...task,
        envs: { ...extraEnvs, ...envs },
        runToken,
        workdir: `${dir}/workspace`,
        signal: this.signal,
      });

    const sdk = vendor.name === 'claude-agent-sdk' ? fleet.options.agentSdk : undefined;
    // Whatever the CLI is, it runs the agent's code: as an account of its own, never the sandbox
    // user, who holds the channel the SDK trusts, the task's files and the egress rules. A box
    // without that account, or one that does not keep it out, runs nothing.
    const channel = fleet.options.agentChannel;
    if (channel === undefined) {
      return { ok: false, reason: noAgentChannelReason(vendor) };
    }
    try {
      await this.guard(fleet.ensureAgentIsolation(machine, this.signal));
      await this.guard(machine.prepareAgent(spec.taskId, channel.group, this.signal));
    } catch (error) {
      if (this.cancelled || error instanceof CancelledError) throw new CancelledError();
      return { ok: false, reason: this.scrubForReader(errorMessage(error)) };
    }
    const reader = this.openReader();
    let drive: Drive;
    try {
      const mirror = sdk ? await this.prepareMirror(machine, resumeSessionId) : undefined;
      drive = sdk
        ? await this.driveAgentSdk(sdk, reader, channel, {
            prompt,
            run,
            dir,
            launchRun,
            ...(mirror ? { mirror } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(mcpUrl ? { mcpUrl } : {}),
            ...(model ? { model } : {}),
            ...(spec.effort ? { effort: spec.effort } : {}),
          })
        : await this.drivePolled(reader, run, () =>
            launchRun({
              preamble: preambleFor(vendor),
              ...splitProgram(
                vendor.argv({
                  prompt,
                  ...(resumeSessionId ? { resumeSessionId } : {}),
                  ...(mcpUrl ? { mcpUrl } : {}),
                  ...(model ? { model } : {}),
                  ...(spec.effort ? { effort: spec.effort } : {}),
                  ...(access.baseUrl ? { baseUrl: access.baseUrl } : {}),
                }),
              ),
            }),
          );
    } finally {
      this.stopWatch = undefined;
      this.spentBefore += this.invocationCost();
      this.callCosts = new Map();
      this.reportedTotal = undefined;
    }
    if (!drive.ended) return drive.outcome;
    reader.flush();
    const failure = reader.failure(drive.exit);
    if (failure !== undefined) return { ok: false, reason: failure };

    // The turn is over: nothing it started may outlive it, and its raw output goes before the
    // snapshot. A leftover process could otherwise write the next turn's result.
    await this.stopProcesses(false).catch((error) =>
      this.progress(`leftover processes could not be stopped: ${errorMessage(error)}`),
    );
    this.checkCancelled();
    await this.snapshot(machine);
    return { ok: true };
  }

  /**
   * What a turn's output means: one line at a time, as the CLI prints it. The same reader serves
   * both ways of running the CLI, since the SDK's messages are the CLI's own output lines.
   */
  private openReader(): TurnReader {
    const { vendor } = this;
    const parser = vendor.parser((text) => this.scrubForReader(text));
    this.callCosts = new Map();
    this.reportedTotal = undefined;
    const rawTail: string[] = [];
    let guardReason: string | undefined;
    let verdict: { ok: boolean; text?: string } | undefined;

    const handleLine = (line: string): void => {
      if (line.startsWith('MAKA_GUARD: ')) {
        guardReason = clipQuote(this.scrubForReader(line.slice('MAKA_GUARD: '.length)));
        return;
      }
      const events = parser.feed(line);
      if (events.length === 0 && line.trim() !== '' && !line.trimStart().startsWith('{')) {
        rawTail.push(clipQuote(this.scrubForReader(line)));
        if (rawTail.length > RAW_TAIL_LINES) rawTail.shift();
      }
      for (const event of events) {
        if (event.kind === 'session') void this.rememberSession(event.id).catch(() => undefined);
        else if (event.kind === 'progress') this.progress(event.note);
        else if (event.kind === 'step') this.progress(`${STEP_PREFIX}${event.text}`);
        else if (event.kind === 'opened') this.opened(this.spec.taskId, event.url);
        // A metered access is the source of the run's spend; the CLI's own numbers are not.
        else if ((event.kind === 'usage' || event.kind === 'cost') && this.meteredUsd !== undefined)
          continue;
        else if (event.kind === 'usage') {
          this.callCosts.set(event.id, tokenCostUsd(event.tokens, this.prices()));
          this.meter();
        } else if (event.kind === 'cost') {
          this.reportedTotal = event.totalUsd;
          this.meter();
        } else
          verdict =
            event.text === undefined ? { ok: event.ok } : { ok: event.ok, text: event.text };
      }
    };
    const lines = new LineSplitter(MAX_LINE_CHARS, handleLine, () =>
      this.progress('an output line over 1 MiB was dropped'),
    );
    const decoder = new StringDecoder('utf8');
    return {
      push: (bytes) => lines.push(decoder.write(bytes)),
      flush: () => {
        lines.push(decoder.end());
        lines.end();
      },
      failure: (exit) => {
        const { binary } = vendor;
        const detail = guardReason ?? verdict?.text ?? rawTail.at(-1);
        if (exit === undefined) {
          return `the ${binary} process was killed${detail ? `: ${detail}` : ''}`;
        }
        if (exit !== 0) {
          return `${binary} exited with code ${exit}${detail ? `: ${detail}` : ''}`;
        }
        if (verdict && !verdict.ok) {
          return `${binary} reported an error${detail ? `: ${detail}` : ''}`;
        }
        return undefined;
      },
    };
  }

  /** Runs the CLI on its own and follows its output file until it exits. */
  private async drivePolled(
    reader: TurnReader,
    run: string,
    start: () => Promise<'started' | 'already' | 'cancelled'>,
  ): Promise<Drive> {
    const { fleet, vendor, spec } = this;
    const machine = this.machine as RemoteMachine;
    const startedAt = fleet.now();
    const launched = await start();
    this.checkCancelled();
    if (launched === 'cancelled') {
      return { ended: false, outcome: { ok: false, reason: 'the start was cancelled' } };
    }
    let consumed = 0;
    const watch = fleet.poller.watch(machine, { dir: spec.taskId, run });
    this.stopWatch = () => watch.stop();
    try {
      for (;;) {
        const update = await watch.next();
        this.checkCancelled();
        reader.push(update.data);
        consumed += update.data.length;
        // Over budget: stop here; the cleanup that follows stops the CLI.
        if (this.budgetStop)
          return { ended: false, outcome: { ok: false, reason: this.budgetStop } };

        const state = update.state;
        if (state === 'starting' || state === 'none') {
          if (fleet.now() - startedAt > (fleet.options.startTimeoutMs ?? 60_000)) {
            return {
              ended: false,
              outcome: {
                ok: false,
                reason: `the ${vendor.binary} process did not start in the sandbox`,
              },
            };
          }
          continue;
        }
        if (state !== 'running' && consumed >= update.size) {
          return { ended: true, exit: typeof state === 'object' ? state.exit : undefined };
        }
      }
    } finally {
      watch.stop();
    }
  }

  /**
   * Runs the CLI under the Agent SDK. The SDK builds the CLI's arguments and speaks its protocol; the
   * CLI itself runs on the sandbox as a detached run whose stdin is a file we append to (see
   * `process-channel.ts`), so a restart of this process leaves it running and its output on disk.
   */
  private async driveAgentSdk(
    sdk: AgentSdk,
    reader: TurnReader,
    channel: AgentChannel,
    input: {
      prompt: string;
      run: string;
      dir: string;
      resumeSessionId?: string;
      mcpUrl?: string;
      model?: string;
      effort?: string;
      mirror?: { store: SessionStore; configDir: string };
      launchRun(
        task: RunProgram,
        extraEnvs?: Record<string, string>,
      ): Promise<'started' | 'already' | 'cancelled'>;
    },
  ): Promise<Drive> {
    const { fleet, vendor, spec } = this;
    const machine = this.machine as RemoteMachine;
    let proc: ExecProcess | undefined;
    let stopped: TurnOutcome | undefined;
    const stopNow = (outcome: TurnOutcome): void => {
      stopped ??= outcome;
      proc?.kill('SIGKILL');
    };
    const query = startAgentQuery({
      sdk,
      prompt: input.prompt,
      workdir: `${input.dir}/workspace`,
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(spec.steps ? { steps: spec.steps } : {}),
      steer: { take: (maxChars) => this.takeSteers(maxChars) },
      ...(input.mirror ? { mirror: input.mirror } : {}),
      // What the hooks give the model is what the kept conversation holds word for word, and the
      // receipt of a steering message is over the same text.
      redact: (text) => this.scrubForReader(text),
      onProblem: (message) => this.progress(message),
      spawn: ({ args, env, signal }) => {
        const watch = fleet.poller.watch(machine, {
          dir: spec.taskId,
          run: input.run,
          backoff: fleet.options.agentSdkPollMs ?? { minMs: 150, maxMs: 1_000 },
        });
        const created = new ExecProcess({
          machine,
          dirName: spec.taskId,
          run: input.run,
          watch,
          launch: () =>
            input.launchRun(
              {
                preamble: preambleFor(vendor),
                program: vendor.binary,
                args,
                fed: true,
              },
              env,
            ),
          onOutput: (bytes) => reader.push(bytes),
          // Over budget, with or without a message to show for it: stop here.
          onTick: () => {
            if (this.budgetStop) stopNow({ ok: false, reason: this.budgetStop });
          },
          stop: () => this.stopProcesses(false),
          startTimeoutMs: fleet.options.startTimeoutMs ?? 60_000,
          now: fleet.now,
        });
        signal.addEventListener('abort', () => created.kill('SIGKILL'), { once: true });
        proc = created;
        return created;
      },
    });
    this.stopWatch = () => {
      proc?.dispose();
      query.close();
    };

    let sdkError: unknown;
    try {
      for await (const message of query) {
        this.checkCancelled();
        if (message.type === 'system' && message.subtype === 'mirror_error') {
          const text = `a transcript batch was not kept: ${this.scrub(message.error)}`;
          this.mirrorFailure ??= text;
          this.progress(text);
        }
        if (this.budgetStop) stopNow({ ok: false, reason: this.budgetStop });
        if (this.mirrorFailure) stopNow(this.mirrorStop(this.mirrorFailure));
        if (stopped) break;
      }
    } catch (error) {
      if (this.cancelled || error instanceof CancelledError) throw new CancelledError();
      sdkError = error;
    }
    this.checkCancelled();
    // What the CLI wrote last is kept (or has failed to be) before the run ends, so a message
    // given to the agent in its last step is reported while the run can still report it.
    await this.mirror?.drain().catch(() => undefined);
    // A batch the SDK gave up on is not kept; one it offered again and the store then kept is.
    this.mirrorFailure ??= this.mirror?.unkept();
    // A conversation that is not all kept cannot be resumed from the server's copy, and what the
    // agent did after the gap would be missing from it: the turn ends here, as a failure.
    if (this.mirrorFailure) stopNow(this.mirrorStop(this.mirrorFailure));

    const process = proc as ExecProcess | undefined;
    if (process === undefined) {
      return {
        ended: false,
        outcome: {
          ok: false,
          reason: `the agent SDK did not start the agent: ${this.scrubForReader(errorMessage(sdkError))}`,
        },
      };
    }
    // The SDK ends its loop when the CLI's output has ended. When it gave up first (a protocol
    // error, a stop for the budget) the CLI is stopped here, and nothing is read from it any more.
    if (stopped || sdkError !== undefined) {
      query.close();
      process.kill('SIGKILL');
      await process.stopped();
    }
    const over = await withTimeout(process.exited, STOP_WAIT_MS);
    if (over === 'timeout') process.dispose();
    this.checkCancelled();
    if (stopped) return { ended: false, outcome: stopped };
    if (process.failure) {
      return {
        ended: false,
        outcome: { ok: false, reason: this.scrubForReader(errorMessage(process.failure)) },
      };
    }
    const exit = process.exitCode ?? undefined;
    if (sdkError !== undefined && exit === 0) {
      return {
        ended: false,
        outcome: {
          ok: false,
          reason: `the agent SDK reported an error: ${this.scrubForReader(errorMessage(sdkError))}`,
        },
      };
    }
    return { ended: true, exit };
  }

  private mirrorStop(problem: string): TurnOutcome {
    return {
      ok: false,
      reason: `the conversation could not be kept off the sandbox, so the task was stopped (${problem})`,
    };
  }

  // -- spend ------------------------------------------------------------------------------------

  private prices(): TokenPrices {
    return this.fleet.options.prices?.[this.vendor.name] ?? DEFAULT_PRICES[this.vendor.name];
  }

  private invocationCost(): number {
    if (this.meteredUsd !== undefined) return 0;
    if (this.reportedTotal !== undefined) return this.reportedTotal;
    let sum = 0;
    for (const usd of this.callCosts.values()) sum += usd;
    return sum;
  }

  /**
   * Reports what the run has spent so far, and stops it once that reaches its budget. `final` is
   * the spend once the access has settled: reported even after the run ended or was cancelled.
   * What is observed and what is published are kept apart, so a spend seen after the end and not
   * reported then is still reported by the final call.
   */
  private meter(final = false): void {
    const spent =
      Math.round(((this.meteredUsd ?? 0) + this.spentBefore + this.invocationCost()) * 1e6) / 1e6;
    if (
      (!this.ended || final) &&
      spent !== this.publishedUsd &&
      this.events.push({ type: 'usage', costUsd: spent })
    ) {
      this.publishedUsd = spent;
    }
    const limit = this.binding();
    if (limit !== undefined && spent >= limit.usd && !this.budgetStop) {
      this.budgetStop = `${limit.what} of ${usd(limit.usd)} reached (${usd(spent)} spent)`;
    }
  }

  /**
   * The limit this run is held to: its turn's, when that is the smaller of the two (a run is one
   * turn), else what its tree has left.
   */
  private binding(): { usd: number; what: string } | undefined {
    const { budgetUsd, turnBudgetUsd } = this.spec;
    if (turnBudgetUsd !== undefined && (budgetUsd === undefined || turnBudgetUsd <= budgetUsd)) {
      return { usd: turnBudgetUsd, what: "this turn's model budget" };
    }
    return budgetUsd === undefined ? undefined : { usd: budgetUsd, what: 'budget' };
  }

  private async rememberSession(id: string): Promise<void> {
    const record = this.record;
    if (!record || record.sessionId === id) return;
    const local = { ...record, sessionId: id, updatedAt: this.fleet.now() };
    this.record = local;
    await this.fleet.updateRecord(record.taskId, (current) => ({
      ...(current ?? local),
      sessionId: id,
      updatedAt: local.updatedAt,
    }));
  }

  /** A snapshot that cannot be taken is reported, not fatal. A cancel is not a failure to report. */
  private async snapshot(machine: RemoteMachine): Promise<void> {
    if (this.fleet.options.snapshots === false || !this.record) return;
    try {
      const { record, snapshotId } = await this.fleet.snapshotTurn(
        this.record,
        machine,
        this.signal,
      );
      this.record = { ...record, sessionId: this.record.sessionId ?? record.sessionId };
      this.progress(`snapshot ${snapshotId} saved`);
    } catch (error) {
      this.checkCancelled();
      this.progress(`snapshot skipped: ${errorMessage(error)}`);
    }
  }

  // -- result hand-back --------------------------------------------------------------------------

  /**
   * The task's result as the orchestrator will get it: the manifest read from the sandbox and
   * checked, then its artifacts exported to the handoff directory. A required artifact that is
   * missing is a rejection like a bad manifest, so the agent gets the one repair turn.
   */
  private async acceptResult(
    machine: RemoteMachine,
  ): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string; artifacts?: true }> {
    const result = await this.collectResult(machine);
    if (!result.ok) return result;
    const { spec } = this;
    const manifest = JSON.parse(result.bytes.toString('utf8')) as { artifacts?: string[] };
    const handoffDir = dirname(spec.resultPath);
    const outcome = await exportArtifacts({
      machine,
      taskId: spec.taskId,
      handoffDir,
      reserved: [basename(spec.resultPath), basename(spec.briefPath)],
      listed: manifest.artifacts ?? [],
      required: this.requiredArtifacts,
      limits: this.fleet.exportLimits,
      signal: this.signal,
      note: (text) => this.progress(text),
    });
    this.checkCancelled();
    if (!outcome.ok) return { ok: false, reason: outcome.reason, artifacts: true };
    return { ok: true, bytes: attestExports(result.bytes, outcome.exported) };
  }

  private async collectResult(
    machine: RemoteMachine,
  ): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
    const read = await machine.readResult(this.spec.taskId, this.signal);
    if (!read.ok) return read;
    let json: unknown;
    try {
      json = JSON.parse(read.bytes.toString('utf8'));
    } catch {
      return { ok: false, reason: 'result.json is not valid JSON' };
    }
    const parsed = ResultManifestSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        reason: `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'rejected'}`,
      };
    }
    return { ok: true, bytes: read.bytes };
  }

  /** Temp file in the same directory, then rename, so a reader never sees half a manifest. */
  private async writeResult(bytes: Buffer): Promise<void> {
    const { resultPath } = this.spec;
    await mkdir(dirname(resultPath), { recursive: true });
    const temp = `${resultPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temp, resultPath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // -- helpers -----------------------------------------------------------------------------------

  private startActivityLease(machine: RemoteMachine): void {
    // A cancel that got here first has already deleted the lease; a timer now would renew it.
    if (this.cleanupPromise) return;
    const ttl = this.fleet.options.leaseTtlSeconds ?? 300;
    const leaseId = this.fleet.leaseId(this.spec.taskId);
    const renew = (): void => {
      this.renewing = this.fleet.client
        .putActivityLease(machine.machineId, leaseId, ttl)
        .then(() => undefined)
        .catch(() => undefined);
    };
    renew();
    this.fleet.leaseRenewals++;
    this.renewTimer = setInterval(renew, (ttl * 1000) / 3);
    this.renewTimer.unref();
  }

  /**
   * Releases everything the run holds. Runs once, whoever asks first (the end of the run, or a
   * cancel); later callers wait for the same promise. Each step is bounded and independent: one
   * that fails or hangs is reported and the others still happen, and the stream always closes.
   */
  private cleanup(): Promise<void> {
    this.cleanupPromise ??= this.runCleanup();
    return this.cleanupPromise;
  }

  private async runCleanup(): Promise<void> {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
      this.fleet.leaseRenewals--;
    }
    this.stopWatch?.();
    try {
      await Promise.all([
        this.step('revoke model access', () => this.releaseAccess(), this.meteredUsd === undefined),
        this.stopAndRelease(),
      ]);
    } finally {
      // The final cost is queued before the stream closes, even after a step's time limit.
      await this.releasing;
      this.fleet.openRuns--;
      this.publishEnd();
      this.events.close();
    }
  }

  /** The sandbox side: stop the processes first, then the activity lease, then give the sandbox back. */
  private async stopAndRelease(): Promise<void> {
    const machine = this.machine;
    if (machine) {
      await this.step('stop processes', () => this.stopProcesses(true), true);
      await this.step('delete activity lease', async () => {
        await this.renewing;
        await this.fleet.client.deleteActivityLease(
          machine.machineId,
          this.fleet.leaseId(this.spec.taskId),
          { signal: AbortSignal.timeout(this.cleanupTimeoutMs()) },
        );
      });
    }
    await this.step('release sandbox', () => this.releaseLease());
  }

  /**
   * Stops the processes of this object's own runs, and nobody else's: the orchestrator is told a
   * run is over before its cleanup has finished, and a resume of the task may already be running.
   * With `startMayBeInFlight` it also marks the current run as cancelled, so a start whose answer
   * has not come back yet cannot slip in after this.
   */
  private async stopProcesses(startMayBeInFlight: boolean): Promise<void> {
    const machine = this.machine;
    if (!machine || this.runNames.length === 0) return;
    await machine.kill(this.spec.taskId, {
      runs: this.runNames,
      signal: AbortSignal.timeout(this.cleanupTimeoutMs()),
      graceTenths: Math.max(1, Math.ceil((this.fleet.options.stopGraceMs ?? 3_000) / 100)),
      ...(startMayBeInFlight && this.runName ? { cancelRuns: [this.runName] } : {}),
    });
  }

  /**
   * Revokes the access. A metered revoke resolves once every request has settled, so the spend
   * read after it is final; it is reported before the meter is let go. For a metered access every
   * caller gets the same release, so none returns (and lets the stream close) before the final
   * spend is queued.
   */
  private releaseAccess(): Promise<void> {
    const access = this.access;
    if (access === undefined) return this.releasing ?? Promise.resolve();
    this.access = undefined;
    const previous = this.releasing ?? Promise.resolve();
    const release = (async () => {
      await previous;
      try {
        try {
          await access.revoke?.();
        } catch (error) {
          // Judged here for a metered access, whose revoke is waited for however long it takes.
          this.stopFailure ??= new Error(
            this.redact(`revoke model access failed: ${errorMessage(error)}`, 300),
          );
          throw error;
        }
        if (access.meter && this.meteredUsd !== undefined) {
          this.meteredUsd = access.meter.spentUsd();
          this.meter(true);
        }
      } finally {
        this.stopMetering?.();
        this.stopMetering = undefined;
      }
    })();
    // The waiters only need it to have ended; a failed revoke is reported by its step.
    if (access.meter) this.releasing = release.catch(() => undefined);
    return release;
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease;
    this.lease = undefined;
    await lease?.release();
  }

  private cleanupTimeoutMs(): number {
    return this.fleet.options.cleanupTimeoutMs ?? CLEANUP_STEP_MS;
  }

  /**
   * Runs one cleanup step with a time limit. A failure is reported, never thrown. A step that
   * stops the run (`stops`) also marks it as not stopped, which `cancel` refuses with.
   */
  private async step(name: string, work: () => Promise<void>, stops = false): Promise<void> {
    const limit = this.cleanupTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${limit} ms`)), limit);
          timer.unref();
        }),
      ]);
    } catch (error) {
      if (stops) {
        this.stopFailure ??= new Error(this.redact(`${name} failed: ${errorMessage(error)}`, 300));
      }
      try {
        this.fleet.options.onCleanupError?.({ taskId: this.spec.taskId, step: name, error });
      } catch {
        // A reporting hook that throws must not stop the cleanup.
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private checkCancelled(): void {
    if (this.cancelled) throw new CancelledError();
  }

  /** Why this run may not start the CLI, or undefined when its account is set and the box keeps it out. */
  private async requireAgentAccount(
    fleet: Fleet,
    machine: RemoteMachine,
    vendor: VendorAdapter,
  ): Promise<string | undefined> {
    if (fleet.options.agentChannel === undefined) return noAgentChannelReason(vendor);
    try {
      await this.guard(fleet.ensureAgentIsolation(machine, this.signal));
    } catch (error) {
      if (this.cancelled || error instanceof CancelledError) throw new CancelledError();
      return this.scrubForReader(errorMessage(error));
    }
    return undefined;
  }

  private fail(reason: string): void {
    this.terminal ??= { type: 'failed', reason: this.redact(reason, MAX_REASON_CHARS) };
  }

  private opened(taskId: TaskId, url: string): void {
    if (this.openedPages >= MAX_OPENED_PER_RUN) return;
    this.openedPages += 1;
    try {
      this.fleet.options.onOpenedPage?.(taskId, url);
    } catch {
      // A page that cannot be recorded is a card that is not shown; the run goes on.
    }
  }

  private progress(note: string): void {
    const text = this.redact(note, MAX_NOTE_CHARS);
    if (text === this.lastNote) return;
    if (this.notes >= (this.fleet.options.maxProgressNotes ?? DEFAULT_MAX_NOTES)) return;
    this.lastNote = text;
    this.notes++;
    this.events.push({ type: 'progress', note: text });
  }

  /**
   * Secrets out first, then the length cap, so a cut can never leave half a secret behind. Output
   * of the CLI is scrubbed before anything shortens or reformats it, not after.
   */
  private redact(text: string, max: number): string {
    const out = this.scrubForReader(text);
    return out.length <= max ? out : `${out.slice(0, max - 1)}…`;
  }

  /**
   * Text a person will read (a failure, a note, a quote of the CLI): the run's own secrets, then
   * anything shaped like a key or a credential header, which also catches a key this run was
   * never given. The kept transcript does not go through it (see `transcripts.ts`).
   */
  private scrubForReader(text: string): string {
    return scrubSecretShapes(this.scrub(text));
  }

  /** Replaces every secret of the run in `text`. Nothing is cut: call this before clipping. */
  private scrub(text: string): string {
    let out = text;
    // The secret as it is, and as it shows up when something is built from it (URL-encoded, escaped
    // for JSON, the base64 of a Basic credential).
    for (const secret of this.secrets) {
      if (secret.length < 6) continue;
      for (const form of secretForms(secret)) out = out.split(form).join('[redacted]');
    }
    return out;
  }
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function clipQuote(text: string): string {
  const flat = text.trim();
  return flat.length <= MAX_QUOTED_CHARS ? flat : `${flat.slice(0, MAX_QUOTED_CHARS - 1)}…`;
}
