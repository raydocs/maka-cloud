import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  WRAP_UP_TEXT,
  assignmentBudget,
  budgetReport,
  checkBudget,
  type AssignmentBudget,
} from './executor-budget.js';
import type { CoderPort, CoderResult } from './loop.js';
import type { SandboxPort } from './sandbox.js';
import type { Mandate, NormalizedEvent, Usage, WorkerRecord } from './types.js';

const run = promisify(execFile);

/**
 * The executor seam (docs/superagent/executor-decision.md). Super-agent
 * schedules and authorizes; an Executor (Claude Code, Codex, the maka engine,
 * or the fake one CI uses) does the coding inside one working directory.
 */
export const EXECUTOR_KINDS = ['fake', 'claude-code', 'codex', 'maka'] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/** Usage deltas. Executors emit them as they go; the caller adds them up. */
export interface ExecutorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usdMicros: number;
  /** Model turns (assistant messages). */
  turns: number;
  wallMs: number;
}

/**
 * How the executor reached its model (executor-decision.md, Auth): the
 * box's built-in signed-in CLI, or the Magpie gateway fallback.
 */
export type ExecutorRoute = 'builtin' | 'magpie';

export interface NeedsPersonQuestion {
  question: string;
  options?: string[];
  reason: string;
}

/**
 * Normalised events. `needs-person`, `ready`, `blocked` and `failed` end a
 * turn; `progress` and `usage` may come any number of times before that.
 */
export type ExecutorEvent =
  | { type: 'progress'; text: string }
  | { type: 'usage'; usage: Partial<ExecutorUsage>; route?: ExecutorRoute }
  | { type: 'needs-person'; ask: NeedsPersonQuestion }
  | { type: 'ready'; summary: string; changed?: string[]; pr?: { number: number; url: string } }
  | { type: 'blocked'; reason: string }
  | { type: 'failed'; error: string; retryable?: boolean };

export type ExecutorTerminal = Extract<
  ExecutorEvent,
  { type: 'needs-person' | 'ready' | 'blocked' | 'failed' }
>;

export function isTerminal(event: ExecutorEvent): event is ExecutorTerminal {
  return (
    event.type === 'needs-person' ||
    event.type === 'ready' ||
    event.type === 'blocked' ||
    event.type === 'failed'
  );
}

/** What the host keeps about a session so it can `send` or `resume` later. */
export interface ExecutorSession {
  sessionId: string;
  kind: ExecutorKind;
  workerId: string;
  workdir: string;
  model?: string;
  /** Stable prefix: Mandate and team rules. Same bytes on every turn. */
  systemPrompt: string;
  startedAt: number;
  /** Model turns this session used so far (the `turns` budget). */
  turns?: number;
  /** Instabox machine the session runs in; absent for a host process. */
  boxId?: string;
}

export interface ExecutorStart {
  workerId: string;
  ticket: string;
  mandate: Mandate;
  workdir: string;
  model?: string;
  systemPrompt: string;
  boxId?: string;
}

export type ExecutorInputKind = 'follow-up' | 'ci' | 'review' | 'wrap-up';

export interface ExecutorInput {
  kind: ExecutorInputKind;
  text: string;
}

export interface ExecutorTurn {
  session: ExecutorSession;
  events: AsyncIterable<ExecutorEvent>;
  /** True when `send` went into a turn that was already running. */
  queued?: boolean;
}

export interface Executor {
  readonly kind: ExecutorKind;
  start(input: ExecutorStart): Promise<ExecutorTurn>;
  /** Follow-ups, CI results and review comments, into the same session. */
  send(session: ExecutorSession, input: ExecutorInput): Promise<ExecutorTurn>;
  /** After a host restart. `note` says to check the directory, git and GitHub first. */
  resume(session: ExecutorSession, note: string): Promise<ExecutorTurn>;
  stop(session: ExecutorSession): Promise<void>;
}

export const STATUS_MARKER = 'MAKA_STATUS';

/**
 * The session's system prompt. It never changes inside a session, so the
 * provider prompt cache keeps hitting; new context goes into user turns.
 */
export function executorSystemPrompt(mandate: Mandate | undefined, rules = ''): string {
  const scope = mandate?.scope.paths?.length
    ? `${mandate.scope.repos.join(', ')} (paths: ${mandate.scope.paths.join(', ')})`
    : mandate?.scope.repos.join(', ') || '(none)';
  const lines = [
    'You are the coding executor for one Maka Cloud Assignment.',
    mandate
      ? `Mandate (policy ${mandate.policyVersion}): scope ${scope}; intensity ${mandate.intensity}; authority ${mandate.authority}.`
      : 'Mandate: none recorded; make no outside changes.',
    'Rules:',
    '- Work only in the current directory, on the branch that is checked out.',
    '- Do not push, open pull requests or merge. The host does that after its own checks.',
    "- Run the project's tests before you finish. Do not weaken or skip tests.",
    '- Never print, write or commit secrets.',
    '- When a person must decide something, stop and ask through the status line.',
    `Finish every reply with one line: ${STATUS_MARKER} followed by JSON, one of`,
    '{"status":"ready","summary":"..."}',
    '{"status":"needs-person","question":"...","options":["..."],"reason":"..."}',
    '{"status":"blocked","reason":"..."}',
  ];
  if (rules.trim()) lines.push('Team rules:', rules.trim());
  return lines.join('\n');
}

/** Reads the last `MAKA_STATUS {...}` line of a final message. */
export function parseStatusLine(text: string): ExecutorTerminal | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trim().replace(/^`+|`+$/g, '');
    if (!line.startsWith(STATUS_MARKER)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(STATUS_MARKER.length).replace(/^[:\s]+/, ''));
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const row = parsed as Record<string, unknown>;
    const str = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
    if (row.status === 'ready') return { type: 'ready', summary: str('summary') || 'ready' };
    if (row.status === 'blocked') return { type: 'blocked', reason: str('reason') || 'blocked' };
    if (row.status === 'needs-person') {
      const options = Array.isArray(row.options)
        ? row.options.filter((item): item is string => typeof item === 'string')
        : undefined;
      return {
        type: 'needs-person',
        ask: {
          question: str('question') || 'The executor needs a decision.',
          ...(options?.length ? { options } : {}),
          reason: str('reason'),
        },
      };
    }
    return undefined;
  }
  return undefined;
}

/** The final text without its status line, for summaries. */
export function stripStatusLine(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().replace(/^`+/, '').startsWith(STATUS_MARKER))
    .join('\n')
    .trim();
}

export function emptyExecutorUsage(): ExecutorUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usdMicros: 0,
    turns: 0,
    wallMs: 0,
  };
}

export function addExecutorUsage(total: ExecutorUsage, delta: Partial<ExecutorUsage>): void {
  total.inputTokens += delta.inputTokens ?? 0;
  total.outputTokens += delta.outputTokens ?? 0;
  total.cacheReadTokens += delta.cacheReadTokens ?? 0;
  total.cacheWriteTokens += delta.cacheWriteTokens ?? 0;
  total.usdMicros += delta.usdMicros ?? 0;
  total.turns += delta.turns ?? 0;
  total.wallMs += delta.wallMs ?? 0;
}

/** Ledger usage. Cache reads and writes count as tokens: they are billed. */
export function ledgerUsage(usage: ExecutorUsage): Partial<Usage> {
  return {
    tokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    usdMicros: usage.usdMicros,
    wallMs: usage.wallMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

/** Async iterable over a fixed list. */
export async function* eventsOf(events: readonly ExecutorEvent[]): AsyncIterable<ExecutorEvent> {
  for (const event of events) yield event;
}

export type FakeExecutorStep = ExecutorEvent[] | ((call: FakeExecutorCall) => ExecutorEvent[]);

export interface FakeExecutorCall {
  op: 'start' | 'send' | 'resume' | 'stop';
  sessionId: string;
  text: string;
  inputKind?: ExecutorInputKind;
  /** `send` while the turn was running. */
  queued?: boolean;
}

/**
 * Offline executor for CI. It writes known files into the working directory
 * and replays scripted events. Each start/send/resume consumes the next step;
 * once the script runs out it writes the files and reports ready.
 */
export class FakeExecutor implements Executor {
  readonly kind = 'fake' as const;
  readonly calls: FakeExecutorCall[] = [];
  private readonly steps: FakeExecutorStep[];
  private readonly live = new Set<string>();
  private readonly stopped = new Set<string>();
  private n = 0;

  constructor(
    private readonly options: {
      files?: Record<string, string>;
      steps?: FakeExecutorStep[];
      usage?: Partial<ExecutorUsage>;
    } = {},
  ) {
    this.steps = [...(options.steps ?? [])];
  }

  get files(): Record<string, string> {
    return { ...(this.options.files ?? {}) };
  }

  async start(input: ExecutorStart): Promise<ExecutorTurn> {
    this.n += 1;
    const session: ExecutorSession = {
      sessionId: `fake-${this.n}-${randomUUID().slice(0, 8)}`,
      kind: 'fake',
      workerId: input.workerId,
      workdir: input.workdir,
      ...(input.model ? { model: input.model } : {}),
      systemPrompt: input.systemPrompt,
      startedAt: Date.now(),
      ...(input.boxId ? { boxId: input.boxId } : {}),
    };
    return this.turn(session, { op: 'start', sessionId: session.sessionId, text: input.ticket });
  }

  async send(session: ExecutorSession, input: ExecutorInput): Promise<ExecutorTurn> {
    if (this.live.has(session.sessionId)) {
      this.calls.push({
        op: 'send',
        sessionId: session.sessionId,
        text: input.text,
        inputKind: input.kind,
        queued: true,
      });
      return { session, events: eventsOf([]), queued: true };
    }
    return this.turn(session, {
      op: 'send',
      sessionId: session.sessionId,
      text: input.text,
      inputKind: input.kind,
    });
  }

  async resume(session: ExecutorSession, note: string): Promise<ExecutorTurn> {
    return this.turn(session, { op: 'resume', sessionId: session.sessionId, text: note });
  }

  async stop(session: ExecutorSession): Promise<void> {
    this.calls.push({ op: 'stop', sessionId: session.sessionId, text: '' });
    if (this.live.has(session.sessionId)) this.stopped.add(session.sessionId);
  }

  private async turn(session: ExecutorSession, call: FakeExecutorCall): Promise<ExecutorTurn> {
    this.calls.push(call);
    const step = this.steps.shift();
    const events = step
      ? typeof step === 'function'
        ? step(call)
        : step
      : await this.writeAndReady(session.workdir);
    return { session, events: this.track(session.sessionId, events) };
  }

  /** Live while the caller reads the turn; `stop` ends it without a result. */
  private async *track(sessionId: string, events: ExecutorEvent[]): AsyncIterable<ExecutorEvent> {
    this.live.add(sessionId);
    this.stopped.delete(sessionId);
    try {
      for (const event of events) {
        if (this.stopped.has(sessionId)) return;
        yield event;
      }
    } finally {
      this.live.delete(sessionId);
      this.stopped.delete(sessionId);
    }
  }

  private async writeAndReady(workdir: string): Promise<ExecutorEvent[]> {
    const files = this.options.files ?? {};
    const changed: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const path = join(workdir, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      changed.push(rel);
    }
    return [
      { type: 'progress', text: `writing ${changed.join(', ') || 'nothing'}` },
      {
        type: 'usage',
        usage: this.options.usage ?? {
          inputTokens: 30,
          outputTokens: 10,
          usdMicros: 200,
          turns: 1,
        },
      },
      { type: 'ready', summary: `fake coder wrote ${changed.join(', ')}`, changed },
    ];
  }
}

/** Keeps the worker → executor session mapping. Phase 3 persists it. */
export interface ExecutorSessionStore {
  get(workerId: string): Promise<ExecutorSession | undefined>;
  put(session: ExecutorSession): Promise<void>;
  delete(workerId: string): Promise<void>;
}

export class MemoryExecutorSessionStore implements ExecutorSessionStore {
  private readonly rows = new Map<string, ExecutorSession>();

  async get(workerId: string): Promise<ExecutorSession | undefined> {
    const row = this.rows.get(workerId);
    return row ? { ...row } : undefined;
  }

  async put(session: ExecutorSession): Promise<void> {
    this.rows.set(session.workerId, { ...session });
  }

  async delete(workerId: string): Promise<void> {
    this.rows.delete(workerId);
  }
}

export interface ExecutorRun {
  terminal: ExecutorTerminal;
  usage: ExecutorUsage;
  progress: string[];
}

/**
 * Drains one turn. A turn that ends without a terminal event counts as
 * failed. `onEvent` may return a terminal to end the turn early (budget).
 */
export async function driveTurn(
  turn: ExecutorTurn,
  onEvent?: (
    event: ExecutorEvent,
    usage: ExecutorUsage,
  ) => Promise<ExecutorTerminal | undefined | void> | ExecutorTerminal | undefined | void,
): Promise<ExecutorRun> {
  const usage = emptyExecutorUsage();
  const progress: string[] = [];
  let terminal: ExecutorTerminal | undefined;
  for await (const event of turn.events) {
    if (event.type === 'usage') addExecutorUsage(usage, event.usage);
    if (event.type === 'progress') progress.push(event.text);
    const early = await onEvent?.(event, usage);
    if (early) {
      terminal = early;
      break;
    }
    if (isTerminal(event)) {
      terminal = event;
      break;
    }
  }
  return {
    terminal: terminal ?? { type: 'failed', error: 'executor turn ended without a result' },
    usage,
    progress,
  };
}

export interface ExecutorCoderOptions {
  model?: string;
  /** Team rules appended to the system prompt. */
  rules?: string;
  sessions?: ExecutorSessionStore;
  onEvent?: (event: ExecutorEvent, workerId: string) => Promise<void> | void;
  /** Wrap-up threshold. Default 0.8. */
  wrapUpAt?: number;
  now?: () => number;
  /**
   * The executor runs inside the worker's box (`worker.sandboxRef`) on the
   * materialized checkout and edits it there; the loop then tests and pulls
   * the diff from the box as usual.
   */
  box?: { sandbox: SandboxPort; workdir: string };
}

/**
 * Runs an Executor behind the loop's `CoderPort`. The first event of a worker
 * starts a session; later events (CI failure, review comment, follow-up) go
 * into the same session with `send`, so the executor keeps its context and
 * its prompt cache.
 */
export class ExecutorCoder implements CoderPort {
  private readonly sessions: ExecutorSessionStore;

  constructor(
    readonly executor: Executor,
    private readonly options: ExecutorCoderOptions = {},
  ) {
    this.sessions = options.sessions ?? new MemoryExecutorSessionStore();
  }

  /** Host executors work in the host checkout; box executors edit the box copy. */
  get wantsWorkdir(): boolean {
    return !this.options.box;
  }

  async apply(input: {
    dir?: string;
    snapshot?: string;
    brief: string;
    event: NormalizedEvent;
    worker: WorkerRecord;
  }): Promise<CoderResult> {
    const worker = input.worker;
    const box = this.options.box;
    const boxId = box ? worker.sandboxRef : undefined;
    if (box && !boxId) throw new Error('ExecutorCoder box mode needs worker.sandboxRef.');
    const workdir = box?.workdir ?? input.dir ?? (await mkdtemp(join(tmpdir(), 'maka-exec-')));
    const existing = await this.sessions.get(worker.workerId);
    const reuse = existing && existing.kind === this.executor.kind && existing.workdir === workdir;
    const turn = reuse
      ? await this.executor.send(existing, {
          kind: inputKindOf(input.event),
          text: input.brief,
        })
      : await this.executor.start({
          workerId: worker.workerId,
          ticket: input.brief,
          mandate: worker.mandate,
          workdir,
          ...(this.options.model ? { model: this.options.model } : {}),
          systemPrompt: executorSystemPrompt(worker.mandate, this.options.rules),
          ...(boxId ? { boxId } : {}),
        });
    await this.sessions.put(turn.session);
    const spentTurns = reuse ? (existing.turns ?? 0) : 0;
    const budget = assignmentBudget(worker.mandate, worker.usage, spentTurns);
    const ran = await this.guarded(turn, budget, worker.workerId);
    await this.sessions.put({ ...turn.session, turns: spentTurns + ran.usage.turns });
    return this.result(workdir, ran, box && boxId ? { sandbox: box.sandbox, boxId } : undefined);
  }

  /**
   * Budget guard (efficiency.md §3). At 80% of any dimension the session
   * gets one wrap-up notice through `send`; at 100% it is stopped and the
   * run ends as needs-person with a short report. Wall time also has timers,
   * so a silent executor is stopped too.
   */
  private async guarded(
    turn: ExecutorTurn,
    budget: AssignmentBudget,
    workerId: string,
  ): Promise<ExecutorRun> {
    const now = this.options.now ?? Date.now;
    const started = now();
    let wrapped = false;
    let stopReason: string | undefined;
    const wrapUp = async (reason: string) => {
      if (wrapped || stopReason) return;
      wrapped = true;
      await this.options.onEvent?.(
        { type: 'progress', text: `budget wrap-up (${reason})` },
        workerId,
      );
      await this.executor.send(turn.session, { kind: 'wrap-up', text: WRAP_UP_TEXT });
    };
    const halt = async (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      await this.executor.stop(turn.session);
    };
    const timers: NodeJS.Timeout[] = [];
    if (budget.wallMs !== undefined) {
      const wall = budget.wallMs;
      const wrapAt = this.options.wrapUpAt ?? 0.8;
      timers.push(
        setTimeout(
          () => void wrapUp(`wall_ms ${Math.round(wall * wrapAt)}/${wall}`),
          wall * wrapAt,
        ),
      );
      timers.push(setTimeout(() => void halt(`wall_ms ${wall}/${wall}`), wall));
      for (const timer of timers) timer.unref();
    }
    try {
      const ran = await driveTurn(turn, async (event, usage) => {
        await this.options.onEvent?.(event, workerId);
        if (event.type !== 'usage' || isTerminal(event)) return undefined;
        const check = checkBudget(budget, usage, now() - started, this.options.wrapUpAt);
        if (check.level === 'stop') {
          await halt(check.reason);
          return budgetStop(check.reason, usage, []);
        }
        if (check.level === 'wrap-up') await wrapUp(check.reason);
        return undefined;
      });
      if (!stopReason) return ran;
      const changed = await gitChanged(turn.session.workdir);
      return {
        ...ran,
        terminal: budgetStop(stopReason, ran.usage, ran.progress, changed),
      };
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  }

  private async result(
    workdir: string,
    ran: ExecutorRun,
    box?: { sandbox: SandboxPort; boxId: string },
  ): Promise<CoderResult> {
    const terminal = ran.terminal;
    const reported = terminal.type === 'ready' ? (terminal.changed ?? []) : [];
    const found = box
      ? await boxChanged(box.sandbox, box.boxId, workdir)
      : await gitChanged(workdir);
    const changed = [...new Set([...reported, ...found])].sort();
    // Box edits are already in the box checkout; nothing to copy back in.
    const files: Record<string, string> = {};
    for (const rel of box ? [] : changed) {
      const text = await readText(join(workdir, rel));
      if (text !== undefined) files[rel] = text;
    }
    const usage = ledgerUsage(ran.usage);
    if (terminal.type === 'ready') {
      return { changed, files, summary: terminal.summary, usage };
    }
    const detail =
      terminal.type === 'needs-person'
        ? terminal.ask.question
        : terminal.type === 'blocked'
          ? terminal.reason
          : terminal.error;
    return {
      changed,
      files,
      summary: `${terminal.type}: ${detail}`,
      usage,
      outcome: terminal,
    };
  }
}

function budgetStop(
  reason: string,
  usage: ExecutorUsage,
  progress: readonly string[],
  changed: readonly string[] = [],
): ExecutorTerminal {
  return {
    type: 'needs-person',
    ask: {
      question: `The Assignment used its whole budget (${reason}). Raise the budget, or stop here?`,
      options: ['Raise the budget and continue', 'Stop here'],
      reason: budgetReport({ reason, usage, progress, changed }),
    },
  };
}

export function inputKindOf(event: NormalizedEvent): ExecutorInputKind {
  if (event.type === 'ci_failed' || event.type === 'ci_passed') return 'ci';
  if (event.type.startsWith('review') || event.type === 'pr_comment') return 'review';
  return 'follow-up';
}

/** Paths changed in a git checkout, untracked included. Not a checkout: none. */
export async function gitChanged(dir: string): Promise<string[]> {
  try {
    await stat(join(dir, '.git'));
  } catch {
    return [];
  }
  const { stdout } = await run('git', ['-C', dir, 'status', '--porcelain', '-uall', '-z']);
  return parsePorcelainZ(stdout);
}

async function boxChanged(sandbox: SandboxPort, boxId: string, workdir: string): Promise<string[]> {
  const ran = await sandbox.exec(boxId, {
    cmd: 'git status --porcelain -uall -z',
    cwd: workdir,
    timeoutSeconds: 60,
  });
  if (ran.exitCode !== 0) return [];
  return parsePorcelainZ(ran.stdout);
}

function parsePorcelainZ(stdout: string): string[] {
  const out: string[] = [];
  const rows = stdout.split('\0').filter(Boolean);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as string;
    const code = row.slice(0, 2);
    if (!code.includes('D')) out.push(row.slice(3));
    // A rename row is followed by its old path.
    if (code.startsWith('R') || code.startsWith('C')) index += 1;
  }
  return out;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
