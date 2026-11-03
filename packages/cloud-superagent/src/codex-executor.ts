import { randomUUID } from 'node:crypto';
import {
  eventsOf,
  routeGone,
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
import type { GatewayRoute } from './claude-code-executor.js';
import {
  NodeProcessRunner,
  executorEnv,
  redactDeep,
  signedIn,
  type ExecutorProcess,
  type ProcessRunner,
} from './executor-process.js';

export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
/** Cheap Magpie model for scratch runs (executor-decision.md, Magpie section). */
export const DEFAULT_MAGPIE_CODEX_MODEL = 'codex/gpt-6-luna';
/** Codex reads the Magpie key from this variable (`env_key` of the provider). */
export const CODEX_MAGPIE_KEY_ENV = 'MAKA_CLOUD_MAGPIE_KEY';

export interface CodexExecutorOptions {
  /** Host env; only PATH-like basics and `CODEX_HOME` pass through, never host secrets. */
  env: NodeJS.ProcessEnv;
  /**
   * In the box: CLI auth variables taken from box Secrets, e.g.
   * `{ OPENAI_API_KEY: 'OPENAI_KEY_1' }`. Ignored for host runs, which use
   * the CLI's own login under `HOME` / `CODEX_HOME`.
   */
  boxSecretEnv?: Record<string, string>;
  /**
   * Magpie as a custom Codex provider (`-c model_providers.magpie...`,
   * `wire_api = "responses"`); the key reaches Codex as
   * `MAKA_CLOUD_MAGPIE_KEY`, never as an argument.
   */
  gateway?: GatewayRoute;
  /**
   * `always` (default with a gateway) or `fallback`: Magpie only where
   * `codex login status` says the CLI is not signed in.
   */
  gatewayMode?: 'always' | 'fallback';
  /** Model on the Magpie route. Default `codex/gpt-6-luna`. */
  gatewayModel?: string;
  runner?: ProcessRunner;
  bin?: string;
  model?: string;
  /**
   * `workspace-write` (default) keeps Codex's own sandbox on. `bypass` turns
   * it off; use it only inside a box, which is the sandbox.
   */
  sandbox?: 'workspace-write' | 'bypass';
}

interface CodexStreamState {
  model: string | undefined;
  lastText: string;
  turnStarted: number;
}

const RETRYABLE = /\b(408|429|5\d\d)\b|timed? ?out|reset|refused|overloaded/i;

/** Maps one `codex exec --json` line to executor events (and the turn's end). */
export function codexStreamEvents(
  row: unknown,
  state: CodexStreamState,
  session: ExecutorSession,
  now: () => number = Date.now,
): { events: ExecutorEvent[]; terminal?: ExecutorTerminal } {
  if (!row || typeof row !== 'object') return { events: [] };
  const line = row as Record<string, unknown>;
  const events: ExecutorEvent[] = [];
  if (line.type === 'thread.started' && typeof line.thread_id === 'string') {
    session.vendorSessionId = line.thread_id;
    // An event, so the coder stores the thread id before anything else happens.
    events.push({ type: 'progress', text: 'codex thread started' });
    return { events };
  }
  if (line.type === 'turn.started') {
    state.turnStarted = now();
    return { events };
  }
  if ((line.type === 'item.started' || line.type === 'item.completed') && line.item) {
    const item = line.item as Record<string, unknown>;
    if (item.type === 'command_execution' && line.type === 'item.started') {
      events.push({ type: 'progress', text: `$ ${String(item.command ?? '').slice(0, 200)}` });
    } else if (item.type === 'file_change' && line.type === 'item.completed') {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((change) => String((change as { path?: unknown }).path ?? ''))
        : [];
      events.push({ type: 'progress', text: `edited ${paths.join(', ')}`.slice(0, 200) });
    } else if (item.type === 'agent_message' && line.type === 'item.completed') {
      const text = typeof item.text === 'string' ? item.text : '';
      state.lastText = text;
      if (text.trim()) events.push({ type: 'progress', text: stripStatusLine(text).slice(0, 200) });
    } else if (item.type === 'error' && line.type === 'item.completed') {
      events.push({ type: 'progress', text: `codex: ${String(item.message ?? '').slice(0, 200)}` });
    }
    return { events };
  }
  if (line.type === 'turn.completed') {
    const raw = (line.usage ?? {}) as Record<string, unknown>;
    const num = (value: unknown) => (typeof value === 'number' ? value : 0);
    const cached = num(raw.cached_input_tokens);
    const written = num(raw.cache_write_input_tokens);
    const delta: Partial<ExecutorUsage> = {
      // input_tokens is the whole prompt, cached reads and writes included.
      inputTokens: Math.max(0, num(raw.input_tokens) - cached - written),
      cacheReadTokens: cached,
      cacheWriteTokens: written,
      outputTokens: num(raw.output_tokens),
      turns: 1,
      wallMs: state.turnStarted ? Math.max(0, now() - state.turnStarted) : 0,
    };
    delta.usdMicros = estimateUsdMicros(state.model, delta);
    events.push({ type: 'usage', usage: delta, route: session.route ?? 'builtin' });
    const text = state.lastText;
    return {
      events,
      terminal: parseStatusLine(text) ?? {
        type: 'ready',
        summary: stripStatusLine(text).slice(0, 500) || 'codex finished',
      },
    };
  }
  if (line.type === 'turn.failed') {
    const error = (line.error ?? {}) as { message?: unknown };
    const message = String(error.message ?? 'turn failed').slice(0, 500);
    return {
      events,
      terminal: { type: 'failed', error: message, retryable: RETRYABLE.test(message) },
    };
  }
  // Top-level `error` lines are reconnect notices; the turn's end decides.
  return { events };
}

interface Live {
  proc: ExecutorProcess;
}

/** Our id in Codex's argv (through `-o`), so the box runner can stop and sample it. */
function codexMarker(session: ExecutorSession): string {
  return `maka-codex-${session.sessionId}`;
}

/**
 * Codex driven headless (`codex exec --json`). One process per turn with the
 * prompt on stdin; later turns are `codex exec resume <thread id>`. Codex
 * picks the thread id itself (from `thread.started`), so the session keeps
 * its own uuid for storage and puts it in argv through `-o`, which is what
 * the box runner kills and samples by. Codex reads its prompt to EOF, so a
 * `send` during a running turn is kept for the next turn.
 */
export class CodexExecutor implements Executor {
  readonly kind = 'codex' as const;
  private readonly runner: ProcessRunner;
  private readonly live = new Map<string, Live>();
  private readonly deferred = new Map<string, string[]>();
  private readonly env: Record<string, string>;
  private readonly gatewayEnv: Record<string, string> | undefined;
  readonly route: ExecutorRoute;
  private readonly routes = new Map<string, Promise<ExecutorRoute>>();

  constructor(private readonly options: CodexExecutorOptions) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.route = options.gateway && options.gatewayMode !== 'fallback' ? 'magpie' : 'builtin';
    this.env = executorEnv(options.env, ['CODEX_HOME']);
    this.gatewayEnv = options.gateway
      ? executorEnv(options.env, ['CODEX_HOME'], { [CODEX_MAGPIE_KEY_ENV]: options.gateway.token })
      : undefined;
  }

  async start(input: ExecutorStart): Promise<ExecutorTurn> {
    const route = await this.pickRoute(input.boxId, input.workdir);
    const session: ExecutorSession = {
      sessionId: randomUUID(),
      kind: 'codex',
      workerId: input.workerId,
      workdir: input.workdir,
      model:
        route === 'magpie'
          ? (this.options.gatewayModel ?? DEFAULT_MAGPIE_CODEX_MODEL)
          : (input.model ?? this.options.model ?? DEFAULT_CODEX_MODEL),
      systemPrompt: input.systemPrompt,
      startedAt: Date.now(),
      route,
      ...(input.boxId ? { boxId: input.boxId } : {}),
    };
    // No system-prompt flag: the Mandate prefix opens the first message and
    // stays in the thread's history for later turns.
    return this.run(session, false, `${session.systemPrompt}\n\n${input.ticket}`);
  }

  private pickRoute(boxId: string | undefined, cwd: string): Promise<ExecutorRoute> {
    if (!this.options.gateway || this.options.gatewayMode !== 'fallback') {
      return Promise.resolve(this.route);
    }
    const key = boxId ?? '';
    let picked = this.routes.get(key);
    if (!picked) {
      picked = signedIn(this.runner, {
        command: this.options.bin ?? 'codex',
        args: ['login', 'status'],
        cwd,
        env: this.env,
        ...(boxId ? { machineId: boxId } : {}),
        ...(boxId && this.options.boxSecretEnv ? { envFromBox: this.options.boxSecretEnv } : {}),
      }).then((yes): ExecutorRoute => (yes ? 'builtin' : 'magpie'));
      this.routes.set(key, picked);
    }
    return picked;
  }

  async send(session: ExecutorSession, input: ExecutorInput): Promise<ExecutorTurn> {
    if (this.live.has(session.sessionId)) {
      const kept = this.deferred.get(session.sessionId) ?? [];
      kept.push(input.text);
      this.deferred.set(session.sessionId, kept);
      return { session, events: eventsOf([]), queued: true };
    }
    return this.run(session, true, input.text);
  }

  async resume(session: ExecutorSession, note: string): Promise<ExecutorTurn> {
    return this.run(session, true, note);
  }

  canResume(session: ExecutorSession): boolean {
    return Boolean(session.vendorSessionId);
  }

  async stop(session: ExecutorSession): Promise<void> {
    this.live.get(session.sessionId)?.proc.kill();
  }

  /** argv for one run. No secret is ever an argument. */
  args(session: ExecutorSession, resume: boolean): string[] {
    const bypass = this.options.sandbox === 'bypass';
    const args = ['exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check'];
    if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
    // `exec resume` has no `-s`; the config key sets the same mode.
    else if (resume) args.push('-c', 'sandbox_mode="workspace-write"');
    else args.push('-s', 'workspace-write');
    if ((session.route ?? this.route) === 'magpie' && this.options.gateway) {
      const base = this.options.gateway.baseUrl.replace(/\/+$/, '');
      args.push(
        '-c',
        'model_provider="magpie"',
        '-c',
        'model_providers.magpie.name="magpie"',
        '-c',
        `model_providers.magpie.base_url=${JSON.stringify(`${base}/v1`)}`,
        '-c',
        `model_providers.magpie.env_key="${CODEX_MAGPIE_KEY_ENV}"`,
        '-c',
        'model_providers.magpie.wire_api="responses"',
      );
    }
    if (session.model) args.push('-m', session.model);
    args.push('-o', `/tmp/${codexMarker(session)}.txt`);
    if (resume) args.push(session.vendorSessionId as string);
    args.push('-');
    return args;
  }

  private run(session: ExecutorSession, resume: boolean, text: string): ExecutorTurn {
    if (resume && !session.vendorSessionId) {
      return {
        session,
        events: eventsOf([
          {
            type: 'failed',
            error: 'codex session has no thread id to resume (its first turn never started)',
            retryable: false,
          },
        ]),
      };
    }
    if (session.route === 'magpie' && !this.gatewayEnv) return routeGone(session);
    const magpie = (session.route ?? this.route) === 'magpie' && this.gatewayEnv;
    const proc = this.runner.spawn({
      command: this.options.bin ?? 'codex',
      args: this.args(session, resume),
      marker: codexMarker(session),
      cwd: session.workdir,
      env: magpie ? magpie : this.env,
      ...(session.boxId ? { machineId: session.boxId } : {}),
      ...(session.boxId && this.options.boxSecretEnv && !magpie
        ? { envFromBox: this.options.boxSecretEnv }
        : {}),
    });
    const live: Live = { proc };
    this.live.set(session.sessionId, live);
    const kept = this.deferred.get(session.sessionId) ?? [];
    this.deferred.delete(session.sessionId);
    proc.write([...kept, text].join('\n\n'));
    proc.endInput();
    return { session, events: this.events(session, live) };
  }

  /** Every event's text leaves with the Magpie key redacted (progress, errors, summaries). */
  private clean<T extends ExecutorEvent>(event: T): T {
    return redactDeep(event, this.gatewayEnv ?? this.env, [CODEX_MAGPIE_KEY_ENV]);
  }

  private async *events(session: ExecutorSession, live: Live): AsyncIterable<ExecutorEvent> {
    const state: CodexStreamState = { model: session.model, lastText: '', turnStarted: 0 };
    try {
      for await (const raw of live.proc.lines) {
        let row: unknown;
        try {
          row = JSON.parse(raw);
        } catch {
          continue;
        }
        const parsed = codexStreamEvents(row, state, session);
        for (const event of parsed.events) yield this.clean(event);
        if (parsed.terminal) {
          yield this.clean(parsed.terminal);
          return;
        }
      }
      const exit = await live.proc.exited;
      const stderr = exit.stderr.trim().slice(-800);
      yield this.clean({
        type: 'failed',
        error: `codex exited ${exit.code ?? exit.signal ?? 'unknown'} before a result${stderr ? `: ${stderr}` : ''}`,
        retryable: exit.signal === null,
      });
    } finally {
      if (this.live.get(session.sessionId) === live) this.live.delete(session.sessionId);
    }
  }
}
