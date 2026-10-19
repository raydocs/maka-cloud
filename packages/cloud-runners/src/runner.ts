import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  type RunHandle,
  type Runner,
  type RunnerEvent,
  ResultManifestSchema,
  type RunSpec,
  type TaskId,
} from '@maka-cloud/orchestrator';
import { attestExports, exportArtifacts } from './export.js';
import type { Fleet } from './fleet.js';
import type { RemoteMachine } from './machine.js';
import { type InputRequest, parseBriefHeader } from './inputs.js';
import { LineSplitter } from './lines.js';
import { buildRunScript } from './scripts.js';
import { errorMessage } from './shell.js';
import type { ModelAccess, RunnerSessionRecord, SandboxLease } from './types.js';
import {
  DEFAULT_PRICES,
  preambleFor,
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

/** Runs one vendor's CLI inside a sandbox for each task, as the orchestrator's `Runner`. */
export class SandboxCliRunner implements Runner {
  constructor(
    private readonly fleet: Fleet,
    private readonly vendor: VendorAdapter,
  ) {}

  get name(): string {
    return this.vendor.name;
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    return new Run(this.fleet, this.vendor, spec, undefined).begin();
  }

  /** Continues a task's vendor session (`--resume <id>`), on its machine or one restored from its snapshot. */
  async resume(taskId: TaskId, input: ResumeInput): Promise<RunHandle> {
    if (input.spec.taskId !== taskId) throw new Error('resume: spec.taskId does not match');
    return new Run(this.fleet, this.vendor, input.spec, input.prompt).begin();
  }

  /** Called by the orchestrator on restart for a task that was running. Idempotent. */
  async stopOrphaned(taskId: TaskId, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.fleet.stopTask(taskId, options.signal);
  }
}

type TurnOutcome = { ok: true } | { ok: false; reason: string };

class Run implements RunHandle {
  readonly events = new EventQueue();
  private readonly abort = new AbortController();
  private cancelled = false;
  private ended = false;
  private notes = 0;
  private lastNote = '';
  /** Dollars spent by the CLI invocations of this run that have ended. */
  private spentBefore = 0;
  /** The current invocation: an estimate per model call, until the CLI reports its own total. */
  private callCosts = new Map<string, number>();
  private reportedTotal: number | undefined;
  private lastReportedUsd = -1;
  /** Set once the run has spent its budget: the reason it stops. */
  private budgetStop: string | undefined;
  private readonly secrets = new Set<string>();
  /** Paths the brief says the task must hand back. */
  private requiredArtifacts: string[] = [];
  private machine: RemoteMachine | undefined;
  private record: RunnerSessionRecord | undefined;
  private access: ModelAccess | undefined;
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
  }

  private get signal(): AbortSignal {
    return this.abort.signal;
  }

  // -- the run ---------------------------------------------------------------------------------

  private async execute(): Promise<void> {
    const { fleet, vendor, spec } = this;
    fleet.openRuns++;
    try {
      this.checkCancelled();
      await this.guard(this.issueAccess());

      const acquired = await this.guard(this.prepareMachine());
      const machine = (this.machine = fleet.machine(acquired.record.machineId));
      let record = (this.record = acquired.record);
      this.startActivityLease(machine);

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
        await machine.prepare(spec.taskId, undefined, this.signal);
      } else {
        await machine.prepare(spec.taskId, brief, this.signal);
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
            ? `The result at ${dir}/result.json was read, but its artifacts were not accepted: ${result.reason}. Fix that (write the missing file under ${dir}/workspace, or list it in artifacts) and write ${dir}/result.json again as ${manifestShape()}. Then stop.`
            : `The result file at ${dir}/result.json was rejected: ${result.reason}. Write it again as ${manifestShape()}. Then stop.`,
          record.sessionId,
        );
        if (!outcome.ok) return this.fail(outcome.reason);
        result = await this.acceptResult(machine);
      }
      if (!result.ok) return this.fail(`invalid result: ${result.reason}`);

      await this.writeResult(result.bytes);
      this.checkCancelled();
      this.ended = true;
      this.events.push({ type: 'finished' });
    } catch (error) {
      if (this.cancelled || error instanceof CancelledError) return;
      this.fail(errorMessage(error));
    } finally {
      this.ended = true;
      await this.cleanup();
    }
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
    const access = await fleet.modelAccess.issue({ taskId: spec.taskId, runner: vendor.name });
    this.adoptAccess(access);
    this.checkCancelled();
  }

  /** From here on the run owns this key; if the run is already being cleaned up, it goes at once. */
  private adoptAccess(access: ModelAccess): void {
    this.access = access;
    this.secrets.add(access.apiKey);
    if (this.spec.mcp) this.secrets.add(this.spec.mcp.token);
    if (this.cleanupPromise) void this.step('revoke model access', () => this.releaseAccess());
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
      `Read the brief at ${dir}/brief.md and carry it out. Work in ${dir}/workspace.`,
      ...(staged ? [staged] : []),
      `When you are finished, write ${dir}/result.json as ${manifestShape()}.`,
      'Write that file as the very last step, then stop. Report only what you actually did and checked.',
    ].join(' ');
  }

  /** A turn starts without the last turn's result.json, so a resumed turn is told to write it. */
  private resumedPrompt(dir: string, prompt: string): string {
    return [
      prompt,
      `When you are finished, write ${dir}/result.json as ${manifestShape()}.`,
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
    const run = `t${turns}`;
    this.runName = run;
    this.runNames.push(run);
    const runToken = randomBytes(16).toString('hex');
    this.secrets.add(runToken);
    const mcpUrl = spec.mcp
      ? (fleet.options.mcpUrlForSandbox?.(spec.mcp.url) ?? spec.mcp.url)
      : undefined;
    const model = fleet.options.models?.[vendor.name];
    const command = vendor.command({
      prompt,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(mcpUrl ? { mcpUrl } : {}),
      ...(model ? { model } : {}),
      ...(access.baseUrl ? { baseUrl: access.baseUrl } : {}),
    });
    const launched = await machine.launch({
      dirName: spec.taskId,
      run,
      script: buildRunScript({ preamble: preambleFor(vendor), command }),
      envs: vendor.env(access, spec.mcp?.token),
      runToken,
      workdir: `${dir}/workspace`,
      signal: this.signal,
    });
    this.checkCancelled();
    if (launched === 'cancelled') return { ok: false, reason: 'the start was cancelled' };

    const parser = vendor.parser((text) => this.scrub(text));
    this.callCosts = new Map();
    this.reportedTotal = undefined;
    const rawTail: string[] = [];
    let guardReason: string | undefined;
    let verdict: { ok: boolean; text?: string } | undefined;
    let consumed = 0;
    const startedAt = fleet.now();

    const handleLine = (line: string): void => {
      if (line.startsWith('MAKA_GUARD: ')) {
        guardReason = clipQuote(this.scrub(line.slice('MAKA_GUARD: '.length)));
        return;
      }
      const events = parser.feed(line);
      if (events.length === 0 && line.trim() !== '' && !line.trimStart().startsWith('{')) {
        rawTail.push(clipQuote(this.scrub(line)));
        if (rawTail.length > RAW_TAIL_LINES) rawTail.shift();
      }
      for (const event of events) {
        if (event.kind === 'session') void this.rememberSession(event.id).catch(() => undefined);
        else if (event.kind === 'progress') this.progress(event.note);
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

    const watch = fleet.poller.watch(machine, { dir: spec.taskId, run });
    this.stopWatch = () => watch.stop();
    try {
      for (;;) {
        const update = await watch.next();
        this.checkCancelled();
        lines.push(decoder.write(update.data));
        consumed += update.data.length;
        // Over budget: stop here; the cleanup that follows stops the CLI.
        if (this.budgetStop) return { ok: false, reason: this.budgetStop };

        const state = update.state;
        if (state === 'starting' || state === 'none') {
          if (fleet.now() - startedAt > (fleet.options.startTimeoutMs ?? 60_000)) {
            return {
              ok: false,
              reason: `the ${vendor.binary} process did not start in the sandbox`,
            };
          }
          continue;
        }
        if (state !== 'running' && consumed >= update.size) {
          lines.push(decoder.end());
          lines.end();
          const exit = typeof state === 'object' ? state.exit : undefined;
          const detail = guardReason ?? verdict?.text ?? rawTail.at(-1);
          if (exit === undefined) {
            return {
              ok: false,
              reason: `the ${vendor.binary} process was killed${detail ? `: ${detail}` : ''}`,
            };
          }
          if (exit !== 0) {
            return {
              ok: false,
              reason: `${vendor.binary} exited with code ${exit}${detail ? `: ${detail}` : ''}`,
            };
          }
          if (verdict && !verdict.ok) {
            return {
              ok: false,
              reason: `${vendor.binary} reported an error${detail ? `: ${detail}` : ''}`,
            };
          }
          break;
        }
      }
    } finally {
      watch.stop();
      this.stopWatch = undefined;
      this.spentBefore += this.invocationCost();
      this.callCosts = new Map();
      this.reportedTotal = undefined;
    }

    // The turn is over: nothing it started may outlive it, and its raw output goes before the
    // snapshot. A leftover process could otherwise write the next turn's result.
    await this.stopProcesses(false).catch((error) =>
      this.progress(`leftover processes could not be stopped: ${errorMessage(error)}`),
    );
    this.checkCancelled();
    await this.snapshot(machine);
    return { ok: true };
  }

  // -- spend ------------------------------------------------------------------------------------

  private prices(): TokenPrices {
    return this.fleet.options.prices?.[this.vendor.name] ?? DEFAULT_PRICES[this.vendor.name];
  }

  private invocationCost(): number {
    if (this.reportedTotal !== undefined) return this.reportedTotal;
    let sum = 0;
    for (const usd of this.callCosts.values()) sum += usd;
    return sum;
  }

  /** Reports what the run has spent so far, and stops it once that reaches its budget. */
  private meter(): void {
    const spent = Math.round((this.spentBefore + this.invocationCost()) * 1e6) / 1e6;
    if (spent === this.lastReportedUsd) return;
    this.lastReportedUsd = spent;
    if (!this.ended) this.events.push({ type: 'usage', costUsd: spent });
    const budget = this.spec.budgetUsd;
    if (budget !== undefined && spent >= budget && !this.budgetStop) {
      this.budgetStop = `budget of ${usd(budget)} reached (${usd(spent)} spent)`;
    }
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
        this.step('revoke model access', () => this.releaseAccess()),
        this.stopAndRelease(),
      ]);
    } finally {
      this.fleet.openRuns--;
      this.events.close();
    }
  }

  /** The sandbox side: stop the processes first, then the activity lease, then give the sandbox back. */
  private async stopAndRelease(): Promise<void> {
    const machine = this.machine;
    if (machine) {
      await this.step('stop processes', () => this.stopProcesses(true));
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

  private async releaseAccess(): Promise<void> {
    const access = this.access;
    this.access = undefined;
    await access?.revoke?.();
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease;
    this.lease = undefined;
    await lease?.release();
  }

  private cleanupTimeoutMs(): number {
    return this.fleet.options.cleanupTimeoutMs ?? CLEANUP_STEP_MS;
  }

  /** Runs one cleanup step with a time limit. A failure is reported, never thrown. */
  private async step(name: string, work: () => Promise<void>): Promise<void> {
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

  private fail(reason: string): void {
    this.ended = true;
    this.events.push({ type: 'failed', reason: this.redact(reason, MAX_REASON_CHARS) });
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
    const out = this.scrub(text);
    return out.length <= max ? out : `${out.slice(0, max - 1)}…`;
  }

  /** Replaces every secret of the run in `text`. Nothing is cut: call this before clipping. */
  private scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets)
      if (secret.length >= 6) out = out.split(secret).join('[redacted]');
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
