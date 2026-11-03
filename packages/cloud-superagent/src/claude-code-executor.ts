import { randomUUID } from 'node:crypto';
import {
  addExecutorUsage,
  eventsOf,
  parseStatusLine,
  stripStatusLine,
  type Executor,
  type ExecutorEvent,
  type ExecutorInput,
  type ExecutorRoute,
  type ExecutorSession,
  type ExecutorStart,
  type ExecutorTerminal,
  type ExecutorTurn,
  type ExecutorUsage,
} from './executor.js';
import { estimateUsdMicros } from './executor-budget.js';
import {
  NodeProcessRunner,
  executorEnv,
  redactSecrets,
  type ExecutorProcess,
  type ProcessRunner,
} from './executor-process.js';

export const DEFAULT_CLAUDE_CODE_MODEL = 'claude-opus-5-5';

/** Magpie gateway route: an Anthropic-compatible base URL and a scoped token. */
export interface GatewayRoute {
  baseUrl: string;
  token: string;
}

export interface ClaudeCodeExecutorOptions {
  /** Host env; only PATH-like basics are passed through, never host secrets. */
  env: NodeJS.ProcessEnv;
  /**
   * Default: the CLI's own built-in login (in Instabox, configured by
   * Instabox; maka-cloud never sees it). With `gateway`, the run goes through
   * Magpie in `--bare` mode with the gateway's scoped token instead.
   */
  gateway?: GatewayRoute;
  /**
   * In the box: CLI auth variables taken from box Secrets, e.g.
   * `{ CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_TOKEN_1' }`. Ignored for host runs.
   */
  boxSecretEnv?: Record<string, string>;
  runner?: ProcessRunner;
  bin?: string;
  model?: string;
  /**
   * `acceptEdits` (default) lets it edit files; shell commands outside
   * `allowedTools` are refused. Use `bypassPermissions` only inside a box.
   */
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'auto';
  allowedTools?: readonly string[];
  /** Hard USD backstop per process run, on top of the host's budget guard. */
  maxBudgetUsd?: number;
}

interface Live {
  proc: ExecutorProcess;
  /** User messages written and not yet answered by a `result`. */
  pending: number;
}

const GATEWAY_KEYS = ['ANTHROPIC_API_KEY'] as const;

/** Parser state for one process run. */
export interface ClaudeStreamState {
  model?: string;
  route?: ExecutorRoute;
  seenMessages: Set<string>;
  usage: ExecutorUsage;
}

export function claudeStreamState(model?: string, route?: ExecutorRoute): ClaudeStreamState {
  return {
    ...(model ? { model } : {}),
    ...(route ? { route } : {}),
    seenMessages: new Set(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usdMicros: 0,
      turns: 0,
      wallMs: 0,
    },
  };
}

/**
 * One `--output-format stream-json` line → normalised events. A `result`
 * line yields `terminal`. Assistant messages repeat per content block with
 * the same id and usage, so usage counts once per message id.
 */
export function claudeStreamEvents(
  row: unknown,
  state: ClaudeStreamState,
): { events: ExecutorEvent[]; terminal?: ExecutorTerminal } {
  if (!row || typeof row !== 'object') return { events: [] };
  const line = row as Record<string, unknown>;
  const events: ExecutorEvent[] = [];
  if (line.type === 'system' && line.subtype === 'init') {
    if (typeof line.model === 'string') state.model = line.model;
    events.push({
      type: 'progress',
      text: `claude-code session started (${state.model ?? 'model'})`,
    });
    return { events };
  }
  if (line.type === 'assistant' && line.message && typeof line.message === 'object') {
    const message = line.message as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        events.push({ type: 'progress', text: `tool ${block.name}${toolHint(block.input)}` });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({
          type: 'progress',
          text: block.text.trim().split('\n')[0]?.slice(0, 200) ?? '',
        });
      }
    }
    const id = typeof message.id === 'string' ? message.id : undefined;
    if (id && !state.seenMessages.has(id)) {
      state.seenMessages.add(id);
      const delta = usageOf(message.usage);
      delta.turns = 1;
      delta.usdMicros = estimateUsdMicros(
        typeof message.model === 'string' ? message.model : state.model,
        delta,
      );
      addExecutorUsage(state.usage, delta);
      events.push({ type: 'usage', usage: delta, ...(state.route ? { route: state.route } : {}) });
    }
    return { events };
  }
  if (line.type === 'result') {
    // Reconcile with the run's own totals: cost is authoritative there.
    const total = usageOf(line.usage);
    const delta: Partial<ExecutorUsage> = {
      inputTokens: Math.max(0, total.inputTokens - state.usage.inputTokens),
      outputTokens: Math.max(0, total.outputTokens - state.usage.outputTokens),
      cacheReadTokens: Math.max(0, total.cacheReadTokens - state.usage.cacheReadTokens),
      cacheWriteTokens: Math.max(0, total.cacheWriteTokens - state.usage.cacheWriteTokens),
      wallMs:
        typeof line.duration_ms === 'number'
          ? Math.max(0, line.duration_ms - state.usage.wallMs)
          : 0,
    };
    if (typeof line.total_cost_usd === 'number') {
      delta.usdMicros = Math.max(
        0,
        Math.round(line.total_cost_usd * 1_000_000) - state.usage.usdMicros,
      );
    }
    addExecutorUsage(state.usage, delta);
    if (Object.values(delta).some((value) => value)) {
      events.push({ type: 'usage', usage: delta, ...(state.route ? { route: state.route } : {}) });
    }
    const text = typeof line.result === 'string' ? line.result : '';
    if (line.is_error === true || (line.subtype && line.subtype !== 'success')) {
      const kind = typeof line.subtype === 'string' ? line.subtype : 'error';
      return {
        events,
        terminal: {
          type: 'failed',
          error: `${kind}: ${text.slice(0, 500) || 'no result text'}`,
          retryable: kind === 'error_during_execution',
        },
      };
    }
    return {
      events,
      terminal: parseStatusLine(text) ?? {
        type: 'ready',
        summary: stripStatusLine(text).slice(0, 500) || 'claude-code finished',
      },
    };
  }
  return { events };
}

/**
 * Claude Code driven headless (`claude -p`, stream-json in and out). One
 * process per turn; `send` during a running turn is written to its stdin
 * when the runner streams (host process), else kept for the next turn (box
 * exec); later turns `--resume` the same session id. The Magpie route runs
 * `--bare`: gateway token only, no login, hooks or CLAUDE.md discovery.
 */
export class ClaudeCodeExecutor implements Executor {
  readonly kind = 'claude-code' as const;
  private readonly runner: ProcessRunner;
  private readonly live = new Map<string, Live>();
  /** Text sent while a non-streaming turn ran; it opens the next turn. */
  private readonly deferred = new Map<string, string[]>();
  private readonly env: Record<string, string>;
  readonly route: ExecutorRoute;

  constructor(private readonly options: ClaudeCodeExecutorOptions) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.route = options.gateway ? 'magpie' : 'builtin';
    this.env = options.gateway
      ? executorEnv(options.env, [], {
          ANTHROPIC_BASE_URL: options.gateway.baseUrl,
          ANTHROPIC_API_KEY: options.gateway.token,
        })
      : executorEnv(options.env, []);
  }

  async start(input: ExecutorStart): Promise<ExecutorTurn> {
    const session: ExecutorSession = {
      sessionId: randomUUID(),
      kind: 'claude-code',
      workerId: input.workerId,
      workdir: input.workdir,
      model: input.model ?? this.options.model ?? DEFAULT_CLAUDE_CODE_MODEL,
      systemPrompt: input.systemPrompt,
      startedAt: Date.now(),
      ...(input.boxId ? { boxId: input.boxId } : {}),
    };
    return this.run(session, ['--session-id', session.sessionId], input.ticket);
  }

  async send(session: ExecutorSession, input: ExecutorInput): Promise<ExecutorTurn> {
    const live = this.live.get(session.sessionId);
    if (live?.proc.write(userLine(input.text))) {
      live.pending += 1;
      return { session, events: eventsOf([]), queued: true };
    }
    if (live) {
      const kept = this.deferred.get(session.sessionId) ?? [];
      kept.push(input.text);
      this.deferred.set(session.sessionId, kept);
      return { session, events: eventsOf([]), queued: true };
    }
    return this.run(session, ['--resume', session.sessionId], input.text);
  }

  async resume(session: ExecutorSession, note: string): Promise<ExecutorTurn> {
    return this.run(session, ['--resume', session.sessionId], note);
  }

  async stop(session: ExecutorSession): Promise<void> {
    const live = this.live.get(session.sessionId);
    if (!live) return;
    live.proc.endInput();
    live.proc.kill();
  }

  /** argv for one run. Exported shape is checked by tests; no secret is ever an argument. */
  args(session: ExecutorSession, sessionArgs: readonly string[]): string[] {
    const args = [
      '-p',
      ...(this.options.gateway ? ['--bare'] : []),
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      ...sessionArgs,
      '--append-system-prompt',
      session.systemPrompt,
      '--permission-mode',
      this.options.permissionMode ?? 'acceptEdits',
    ];
    if (session.model) args.push('--model', session.model);
    if (this.options.allowedTools?.length)
      args.push('--allowedTools', ...this.options.allowedTools);
    if (this.options.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(this.options.maxBudgetUsd));
    }
    return args;
  }

  private run(
    session: ExecutorSession,
    sessionArgs: readonly string[],
    text: string,
  ): ExecutorTurn {
    const proc = this.runner.spawn({
      command: this.options.bin ?? 'claude',
      args: this.args(session, sessionArgs),
      cwd: session.workdir,
      env: this.env,
      ...(session.boxId ? { machineId: session.boxId } : {}),
      ...(session.boxId && this.options.boxSecretEnv && !this.options.gateway
        ? { envFromBox: this.options.boxSecretEnv }
        : {}),
    });
    const live: Live = { proc, pending: 1 };
    this.live.set(session.sessionId, live);
    const kept = this.deferred.get(session.sessionId) ?? [];
    this.deferred.delete(session.sessionId);
    proc.write(userLine([...kept, text].join('\n\n')));
    return { session, events: this.events(session, live) };
  }

  private async *events(session: ExecutorSession, live: Live): AsyncIterable<ExecutorEvent> {
    const state = claudeStreamState(session.model, this.route);
    try {
      for await (const raw of live.proc.lines) {
        let row: unknown;
        try {
          row = JSON.parse(raw);
        } catch {
          continue;
        }
        const parsed = claudeStreamEvents(row, state);
        for (const event of parsed.events) yield event;
        if (!parsed.terminal) continue;
        live.pending -= 1;
        // A message queued mid-turn (a wrap-up notice) gets its own result.
        if (live.pending > 0 && parsed.terminal.type !== 'failed') continue;
        live.proc.endInput();
        yield parsed.terminal;
        return;
      }
      const exit = await live.proc.exited;
      const stderr = redactSecrets(exit.stderr, this.env, GATEWAY_KEYS).trim().slice(-800);
      yield {
        type: 'failed',
        error: `claude exited ${exit.code ?? exit.signal ?? 'unknown'} before a result${stderr ? `: ${stderr}` : ''}`,
        retryable: exit.signal === null,
      };
    } finally {
      if (this.live.get(session.sessionId) === live) this.live.delete(session.sessionId);
      live.proc.endInput();
    }
  }
}

function userLine(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

function usageOf(raw: unknown): ExecutorUsage {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (key: string) => (typeof row[key] === 'number' ? (row[key] as number) : 0);
  return {
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
    cacheWriteTokens: num('cache_creation_input_tokens'),
    usdMicros: 0,
    turns: 0,
    wallMs: 0,
  };
}

function toolHint(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const row = input as Record<string, unknown>;
  const hint = row.command ?? row.file_path ?? row.path ?? row.pattern;
  return typeof hint === 'string' ? `: ${hint.slice(0, 120)}` : '';
}
