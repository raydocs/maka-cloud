import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type RunHandle,
  type Runner,
  type RunnerEvent,
  ResultManifestSchema,
  type RunSpec,
  type TaskId,
} from '@maka-cloud/orchestrator';
import type { Fleet } from './fleet.js';
import type { RemoteMachine } from './machine.js';
import { buildRunScript } from './scripts.js';
import { errorMessage } from './shell.js';
import type { ModelAccess, RunnerSessionRecord, SandboxLease } from './types.js';
import { preambleFor, type VendorAdapter } from './vendors.js';

const DEFAULT_MAX_NOTES = 300;
const CANCEL_WAIT_MS = 20_000;
const RAW_TAIL_LINES = 8;

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
  private cancelled = false;
  private ended = false;
  private failed = false;
  private notes = 0;
  private lastNote = '';
  private readonly secrets = new Set<string>();
  private machine: RemoteMachine | undefined;
  private record: RunnerSessionRecord | undefined;
  private stopWatch: (() => void) | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private finished: Promise<void> = Promise.resolve();

  constructor(
    private readonly fleet: Fleet,
    private readonly vendor: VendorAdapter,
    private readonly spec: RunSpec,
    /** Set for a resume: the prompt to continue the existing session with. */
    private readonly resumePrompt: string | undefined,
  ) {}

  begin(): RunHandle {
    this.finished = this.execute();
    return this;
  }

  async cancel(): Promise<void> {
    if (this.ended) return;
    this.cancelled = true;
    if (this.machine) {
      await this.machine
        .kill(this.spec.taskId, { signal: AbortSignal.timeout(CANCEL_WAIT_MS) })
        .catch(() => undefined);
    }
    this.stopWatch?.();
    await Promise.race([
      this.finished,
      new Promise<void>((resolve) => setTimeout(resolve, CANCEL_WAIT_MS).unref()),
    ]);
  }

  // -- the run ---------------------------------------------------------------------------------

  private async execute(): Promise<void> {
    const { fleet, vendor, spec } = this;
    let access: ModelAccess | undefined;
    let lease: SandboxLease | undefined;
    fleet.openRuns++;
    try {
      access = await fleet.modelAccess.issue({ taskId: spec.taskId, runner: vendor.name });
      this.secrets.add(access.apiKey);
      if (spec.mcp) this.secrets.add(spec.mcp.token);
      this.checkCancelled();

      const acquired = await this.prepareMachine();
      lease = acquired.lease;
      const machine = (this.machine = fleet.machine(acquired.record.machineId));
      let record = (this.record = acquired.record);
      this.startActivityLease(machine);

      await fleet.ensureCli(machine, vendor);
      this.checkCancelled();

      const dir = machine.taskDir(spec.taskId);
      const resumed = this.resumePrompt !== undefined;
      if (resumed) {
        await machine.prepare(spec.taskId);
      } else {
        await machine.prepare(spec.taskId, await readFile(spec.briefPath, 'utf8'));
      }

      let outcome = await this.turn(
        access,
        resumed ? (this.resumePrompt ?? '') : this.initialPrompt(dir),
        resumed ? record.sessionId : undefined,
      );
      record = this.record ?? record;
      if (!outcome.ok) return this.fail(outcome.reason);

      let result = await this.collectResult(machine);
      if (!result.ok && record.sessionId) {
        this.progress(
          `the result file was rejected (${result.reason}); asking the agent to rewrite it`,
        );
        outcome = await this.turn(
          access,
          `The result file at ${dir}/result.json was rejected: ${result.reason}. Write it again as ${manifestShape()}. Then stop.`,
          record.sessionId,
        );
        if (!outcome.ok) return this.fail(outcome.reason);
        result = await this.collectResult(machine);
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
      await this.cleanup(access, lease);
      fleet.openRuns--;
      this.events.close();
    }
  }

  /** Picks the machine: acquired for a new task, the recorded one (or a restore) for a resume. */
  private async prepareMachine(): Promise<{ record: RunnerSessionRecord; lease?: SandboxLease }> {
    const { fleet, vendor, spec } = this;
    const tenantId = fleet.tenantOf(spec.taskId);
    if (this.resumePrompt === undefined) {
      const lease = await fleet.sandboxes.acquire({ tenantId, taskId: spec.taskId });
      const record: RunnerSessionRecord = {
        taskId: spec.taskId,
        runner: vendor.name,
        tenantId,
        machineId: lease.machineId,
        turns: 0,
        snapshotIds: [],
        updatedAt: fleet.now(),
      };
      await fleet.sessions.put(record);
      return { record, lease };
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
    const lease = await fleet.sandboxes.restoreFromSnapshot({
      tenantId: existing.tenantId,
      taskId: spec.taskId,
      snapshotId,
    });
    const record = { ...existing, machineId: lease.machineId, updatedAt: fleet.now() };
    await fleet.sessions.put(record);
    return { record, lease };
  }

  private async machineUsable(machineId: string): Promise<boolean> {
    try {
      const machine = await this.fleet.client.getMachine(machineId);
      return (
        machine.state !== 'deleted' && machine.state !== 'deleting' && machine.state !== 'error'
      );
    } catch (error) {
      if ((error as { status?: number }).status === 404) return false;
      throw error;
    }
  }

  private initialPrompt(dir: string): string {
    return [
      `Read the brief at ${dir}/brief.md and carry it out. Work in ${dir}/workspace.`,
      `When you are finished, write ${dir}/result.json as ${manifestShape()}.`,
      'Write that file as the very last step, then stop. Report only what you actually did and checked.',
    ].join(' ');
  }

  // -- one CLI invocation ------------------------------------------------------------------------

  private async turn(
    access: ModelAccess,
    prompt: string,
    resumeSessionId: string | undefined,
  ): Promise<TurnOutcome> {
    const { fleet, vendor, spec } = this;
    const machine = this.machine as RemoteMachine;
    let record = this.record as RunnerSessionRecord;
    record = { ...record, turns: record.turns + 1, updatedAt: fleet.now() };
    this.record = record;
    await fleet.sessions.put(record);

    const dir = machine.taskDir(spec.taskId);
    const run = `t${record.turns}`;
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
    await machine.launch({
      dirName: spec.taskId,
      run,
      script: buildRunScript({ preamble: preambleFor(vendor), command }),
      envs: vendor.env(access, spec.mcp?.token),
      runToken,
      workdir: `${dir}/workspace`,
    });
    this.checkCancelled();

    const parser = vendor.parser();
    const rawTail: string[] = [];
    let guardReason: string | undefined;
    let verdict: { ok: boolean; text?: string } | undefined;
    let buffer = '';
    let consumed = 0;
    const startedAt = fleet.now();

    const handleLine = (line: string): void => {
      if (line.startsWith('MAKA_GUARD: ')) {
        guardReason = line.slice('MAKA_GUARD: '.length).trim();
        return;
      }
      const events = parser.feed(line);
      if (events.length === 0 && line.trim() !== '' && !line.trimStart().startsWith('{')) {
        rawTail.push(line.trim());
        if (rawTail.length > RAW_TAIL_LINES) rawTail.shift();
      }
      for (const event of events) {
        if (event.kind === 'session') void this.rememberSession(event.id).catch(() => undefined);
        else if (event.kind === 'progress') this.progress(event.note);
        else
          verdict =
            event.text === undefined ? { ok: event.ok } : { ok: event.ok, text: event.text };
      }
    };

    const watch = fleet.poller.watch(machine, { dir: spec.taskId, run });
    this.stopWatch = () => watch.stop();
    try {
      for (;;) {
        const update = await watch.next();
        this.checkCancelled();
        buffer += update.data.toString('utf8');
        consumed += update.data.length;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);

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
          if (buffer.trim() !== '') handleLine(buffer);
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
    }

    await this.snapshot(machine);
    return { ok: true };
  }

  private async rememberSession(id: string): Promise<void> {
    const record = this.record;
    if (!record || record.sessionId === id) return;
    this.record = { ...record, sessionId: id, updatedAt: this.fleet.now() };
    await this.fleet.sessions.put(this.record);
  }

  /** A snapshot that cannot be taken is reported, not fatal. */
  private async snapshot(machine: RemoteMachine): Promise<void> {
    if (this.fleet.options.snapshots === false || !this.record) return;
    try {
      const { record, snapshotId } = await this.fleet.snapshotTurn(this.record, machine);
      this.record = { ...record, sessionId: this.record.sessionId ?? record.sessionId };
      this.progress(`snapshot ${snapshotId} saved`);
    } catch (error) {
      this.progress(`snapshot skipped: ${errorMessage(error)}`);
    }
  }

  // -- result hand-back --------------------------------------------------------------------------

  private async collectResult(
    machine: RemoteMachine,
  ): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
    const read = await machine.readResult(this.spec.taskId);
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
    const ttl = this.fleet.options.leaseTtlSeconds ?? 300;
    const leaseId = this.fleet.leaseId(this.spec.taskId);
    const renew = (): void => {
      void this.fleet.client
        .putActivityLease(machine.machineId, leaseId, ttl)
        .catch(() => undefined);
    };
    renew();
    this.renewTimer = setInterval(renew, (ttl * 1000) / 3);
    this.renewTimer.unref();
  }

  private async cleanup(
    access: ModelAccess | undefined,
    lease: SandboxLease | undefined,
  ): Promise<void> {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.stopWatch?.();
    if ((this.cancelled || this.failed) && this.machine) {
      // A start that raced with a cancel may have launched after the cancel's own kill, and a run
      // that failed on our side (unreachable sandbox, copy-back error) may have left its CLI going.
      await this.machine.kill(this.spec.taskId).catch(() => undefined);
    }
    if (this.machine) {
      await this.fleet.client
        .deleteActivityLease(this.machine.machineId, this.fleet.leaseId(this.spec.taskId))
        .catch(() => undefined);
    }
    await Promise.resolve(access?.revoke?.()).catch(() => undefined);
    await Promise.resolve(lease?.release()).catch(() => undefined);
  }

  private checkCancelled(): void {
    if (this.cancelled) throw new CancelledError();
  }

  private fail(reason: string): void {
    this.ended = true;
    this.failed = true;
    this.events.push({ type: 'failed', reason: this.redact(reason) });
  }

  private progress(note: string): void {
    const text = this.redact(note);
    if (text === this.lastNote) return;
    if (this.notes >= (this.fleet.options.maxProgressNotes ?? DEFAULT_MAX_NOTES)) return;
    this.lastNote = text;
    this.notes++;
    this.events.push({ type: 'progress', note: text });
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets)
      if (secret.length >= 6) out = out.split(secret).join('[redacted]');
    return out;
  }
}
