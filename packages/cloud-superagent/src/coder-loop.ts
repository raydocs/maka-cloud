import {
  autonomyOf,
  compactHistory,
  estimateTokens,
  markApplied,
  observeStreamSilence,
  observeTimeLimit,
  observeToolCall,
  observeTurn,
} from './autonomy.js';
import {
  LoopProviderError,
  loopUsdMicros,
  StreamSilenceError,
  type LoopModel,
  type LoopModelTurn,
} from './coder-model.js';
import { BOX_REPO, safeRelPath, type BoxWorkspace } from './loop-box.js';
import type { CoderPort, CoderResult } from './loop.js';
import {
  appendMessage,
  buildRequest,
  recordCacheBreak,
  recordCacheUsage,
  toAnthropicLoopBody,
  workerCacheHitShare,
  type ContentBlock,
  type ToolDef,
  type WorkerRequest,
} from './prompt-cache.js';
import type { SandboxExecResult, SandboxPort } from './sandbox.js';
import {
  createToolCatalog,
  firstTurnRequest,
  handleLoadTools,
  isCallable,
  LOAD_TOOLS_NAME,
  toAnthropicTools,
  type ToolCatalog,
} from './tool-loading.js';
import type {
  AutonomyIncident,
  AutonomySettings,
  AutonomyState,
  NormalizedEvent,
  WorkerRecord,
} from './types.js';
import { DEFAULT_AUTONOMY } from './types.js';

/** The repo checkout a coder loop works in. Every tool is a command in it. */
export interface LoopWorkspace {
  readonly label: string;
  run(
    cmd: string,
    options?: { stdin?: string; timeoutSeconds?: number },
  ): Promise<SandboxExecResult>;
}

export function boxLoopWorkspace(box: BoxWorkspace): LoopWorkspace {
  return {
    label: 'box',
    run: (cmd, options = {}) => box.run(cmd, options.timeoutSeconds ?? 180, options.stdin),
  };
}

export function sandboxLoopWorkspace(
  sandbox: SandboxPort,
  machineId: string,
  cwd = BOX_REPO,
): LoopWorkspace {
  return {
    label: 'box',
    run: (cmd, options = {}) =>
      sandbox.exec(machineId, {
        cmd,
        cwd,
        timeoutSeconds: options.timeoutSeconds ?? 180,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      }),
  };
}

export interface LoopToolOutput {
  content: string | ContentBlock[];
  isError?: boolean;
  /** The configured test command ran and exited 0. */
  testsPassed?: boolean;
}

export interface LoopToolContext {
  workspace: LoopWorkspace;
  testCommand?: string;
  /**
   * Hand a long job to the loop. Its text is delivered to the model when it
   * finishes; a model that ends its turn while jobs run is woken by the first
   * one to finish (an awaited promise, not a poll).
   */
  background(label: string, job: Promise<string>): string;
}

export interface LoopTool {
  def: ToolDef;
  run(input: Record<string, unknown>, ctx: LoopToolContext): Promise<LoopToolOutput>;
}

export type CoderLoopStop =
  | 'tests_passed'
  | 'end_turn'
  | 'max_turns'
  | 'empty_turns'
  | 'repeat_tools'
  | 'time_limit'
  | 'stream_silence'
  | 'provider_error';

export interface CoderLoopStats {
  stop: CoderLoopStop;
  testsPassed: boolean;
  turns: number;
  modelRequests: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usdMicros: number;
  wallMs: number;
  /** Requests whose prefix was rewritten (should stay 0). */
  cacheBreaks: number;
  cacheHitShare: number;
  nudges: number;
  streamRetries: number;
  providerRetries: number;
  compactions: number;
  toolsLoaded: string[];
  backgroundJobs: number;
  model: string;
}

export interface ToolLoopOptions {
  model: LoopModel;
  /** Used when the caller has no box workspace (host checkout without a sandbox). */
  fallback?: CoderPort;
  maxTurns?: number;
  maxTokens?: number;
  maxWallMs?: number;
  settings?: AutonomySettings;
  /** Turn one carries only `coreTools` plus `load_tools`; the rest load on request. */
  toolLoading?: boolean;
  coreTools?: readonly string[];
  /** More tools, for example Script. Same contract as the built-ins. */
  extraTools?: readonly LoopTool[];
  /** Estimated request tokens that trigger a compaction into a fresh conversation. */
  compactAtTokens?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_CORE_TOOLS = ['read_file', 'run'] as const;
const MAX_STREAM_RETRIES = 3;
const MAX_PROVIDER_RETRIES = 3;
const READ_CAP = 20_000;
const RUN_HEAD = 2_000;
const RUN_TAIL = 6_000;

export const CODER_LOOP_SYSTEM = [
  'You are a coding worker inside a sandboxed copy of a repository.',
  'Work in small steps: read the code, edit it, run the tests, and repeat until the tests pass.',
  'Use the tools for every file and command; paths are relative to the repository root.',
  'Prefer apply_patch (unified diff) for small edits and write_file for new or rewritten files.',
  'When the tests pass, or you cannot make progress, stop calling tools and reply with a one-paragraph summary.',
].join('\n');

/**
 * Multi-turn coder: the model reads, edits and runs tests through tools until
 * the tests pass or a bound trips. Bounded autonomy (empty turns, repeated
 * identical calls, dropped streams, time limit) comes from `autonomy.ts`; the
 * request is append-only (`prompt-cache.ts`) and every request is checked
 * against the previous one, so a rewritten prefix shows up as `cacheBreaks`.
 */
export class ToolLoopCoder implements CoderPort {
  constructor(private readonly options: ToolLoopOptions) {}

  async apply(input: {
    dir?: string;
    snapshot?: string;
    brief: string;
    event: NormalizedEvent;
    worker: WorkerRecord;
    workspace?: LoopWorkspace;
    testCommand?: string;
  }): Promise<CoderResult> {
    if (!input.workspace) {
      if (this.options.fallback) return this.options.fallback.apply(input);
      throw new Error('ToolLoopCoder needs a sandbox workspace.');
    }
    return new LoopRun(this.options, input.workspace, input).run();
  }
}

class LoopRun {
  private readonly settings: AutonomySettings;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tools = new Map<string, LoopTool>();
  private readonly catalog?: ToolCatalog;
  private readonly wireTools: Array<Record<string, unknown>>;
  private readonly jobs = new Map<string, Promise<{ id: string; label: string; text: string }>>();
  private readonly finished: Array<{ id: string; label: string; text: string }> = [];
  private jobSeq = 0;
  private state: AutonomyState;
  private request!: WorkerRequest;
  private prev: WorkerRequest | undefined;
  private readonly incidents: AutonomyIncident[] = [];
  private readonly stats: CoderLoopStats;
  private readonly started: number;

  constructor(
    private readonly options: ToolLoopOptions,
    private readonly workspace: LoopWorkspace,
    private readonly input: { brief: string; worker: WorkerRecord; testCommand?: string },
  ) {
    this.settings = options.settings ?? DEFAULT_AUTONOMY;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (const tool of [...builtinTools(), ...(options.extraTools ?? [])]) {
      this.tools.set(tool.def.name, tool);
    }
    const defs = [...this.tools.values()].map((tool) => tool.def);
    if (options.toolLoading) {
      const coreNames = new Set(options.coreTools ?? DEFAULT_CORE_TOOLS);
      this.catalog = createToolCatalog({
        core: defs.filter((def) => coreNames.has(def.name)),
        deferred: defs.filter((def) => !coreNames.has(def.name)),
      });
      this.wireTools = toAnthropicTools(this.catalog);
    } else {
      this.wireTools = defs.map((def) => ({
        name: def.name,
        ...(def.description === undefined ? {} : { description: def.description }),
        input_schema: def.inputSchema ?? { type: 'object', properties: {} },
      }));
    }
    // Per-run counters start clean; cumulative cache counters carry over.
    this.state = {
      ...autonomyOf(input.worker),
      emptyTurns: 0,
      lastToolKey: null,
      lastToolResultHash: null,
      identicalToolRuns: 0,
      timeLimitAttempts: 0,
      streamRetries: 0,
      pending: undefined,
    };
    this.started = this.now();
    this.stats = {
      stop: 'max_turns',
      testsPassed: false,
      turns: 0,
      modelRequests: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usdMicros: 0,
      wallMs: 0,
      cacheBreaks: 0,
      cacheHitShare: 0,
      nudges: 0,
      streamRetries: 0,
      providerRetries: 0,
      compactions: 0,
      toolsLoaded: [],
      backgroundJobs: 0,
      model: options.model.model,
    };
  }

  async run(): Promise<CoderResult> {
    const listing = await this.workspace.run(listCommand('.'), { timeoutSeconds: 60 });
    const task = taskMessage(this.input.brief, this.input.testCommand, listing.stdout);
    this.request = this.freshRequest(task);
    const maxTurns = this.options.maxTurns ?? 24;
    let lastText = '';
    const breaksAtStart = this.state.cacheBreaks;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (this.now() - this.started > (this.options.maxWallMs ?? 20 * 60_000)) {
        const observed = observeTimeLimit(this.state, this.now(), {
          ...this.settings,
          timeLimitAttempts: 1,
        });
        this.state = observed.state;
        this.incidents.push(observed.incident);
        this.stats.stop = 'time_limit';
        break;
      }
      this.maybeCompact(task);
      this.stats.turns = turn;
      const reply = await this.callModel();
      if ('stop' in reply) {
        this.stats.stop = reply.stop;
        break;
      }
      this.request = appendMessage(this.request, { role: 'assistant', content: reply.content });
      const text = textOf(reply.content);
      if (text) lastText = text;
      const toolUses = reply.content.filter((block) => block.type === 'tool_use');
      const observedTurn = observeTurn(
        this.state,
        { visible: text.length > 0 || toolUses.length > 0 },
        this.now(),
        this.settings,
      );
      this.state = observedTurn.state;
      if (observedTurn.incident) {
        this.incidents.push(observedTurn.incident);
        this.stats.stop = 'empty_turns';
        break;
      }
      if (toolUses.length === 0) {
        if (text.length === 0) {
          this.request = appendMessage(this.request, {
            role: 'user',
            content: [{ type: 'text', text: EMPTY_TURN_NUDGE }],
          });
          continue;
        }
        if (this.jobs.size > 0) {
          await this.waitForJob();
          this.request = appendMessage(this.request, {
            role: 'user',
            content: this.drainFinished(),
          });
          continue;
        }
        this.stats.stop = 'end_turn';
        break;
      }

      const results: ContentBlock[] = [];
      let stop: CoderLoopStop | undefined;
      let nudge: AutonomyIncident | undefined;
      for (const block of toolUses) {
        const out = await this.runTool(block, reply.invalidToolInputs ?? []);
        this.stats.toolCalls += 1;
        if (out.testsPassed) this.stats.testsPassed = true;
        results.push({
          type: 'tool_result',
          tool_use_id: String(block.id),
          content: out.content,
          ...(out.isError ? { is_error: true } : {}),
        });
        const observed = observeToolCall(
          this.state,
          {
            name: String(block.name),
            args: block.input ?? {},
            result: typeof out.content === 'string' ? out.content : JSON.stringify(out.content),
          },
          this.now(),
          this.settings,
        );
        this.state = observed.state;
        if (observed.incident) {
          this.incidents.push(observed.incident);
          if (observed.incident.action === 'stop') stop = 'repeat_tools';
          if (observed.incident.action === 'nudge') nudge = observed.incident;
        }
      }
      if (nudge) {
        this.stats.nudges += 1;
        results.push({ type: 'text', text: repeatNudge(nudge) });
      }
      results.push(...this.drainFinished());
      this.request = appendMessage(this.request, { role: 'user', content: results });
      if (stop) {
        this.stats.stop = stop;
        break;
      }
      if (this.stats.testsPassed) {
        this.stats.stop = 'tests_passed';
        break;
      }
    }

    this.stats.cacheBreaks = this.state.cacheBreaks - breaksAtStart;
    this.stats.cacheHitShare = workerCacheHitShare({
      inputTokens: this.stats.inputTokens,
      cacheReadTokens: this.stats.cacheReadTokens,
      cacheWriteTokens: this.stats.cacheWriteTokens,
    });
    this.stats.wallMs = this.now() - this.started;
    if (this.catalog) {
      this.stats.toolsLoaded = this.request.appendedTools.map((tool) => tool.name);
    }
    const changed = await this.changedFiles();
    const last = this.incidents.at(-1);
    const stopIncident = last && last.action === 'stop' ? last : undefined;
    return {
      changed,
      files: {},
      summary:
        lastText.slice(0, 600) ||
        `coder loop stopped (${this.stats.stop}) after ${this.stats.turns} turns`,
      usage: {
        tokens: this.stats.inputTokens + this.stats.outputTokens,
        usdMicros: this.stats.usdMicros,
        wallMs: this.stats.wallMs,
        inputTokens: this.stats.inputTokens,
        outputTokens: this.stats.outputTokens,
      },
      loop: { ...this.stats, toolsLoaded: [...this.stats.toolsLoaded] },
      autonomy: stopIncident ? { ...this.state, pending: stopIncident } : markApplied(this.state),
      ...(stopIncident ? { incident: stopIncident } : {}),
    };
  }

  private freshRequest(task: string): WorkerRequest {
    const messages = [{ role: 'user' as const, content: [{ type: 'text', text: task }] }];
    if (this.catalog) {
      return firstTurnRequest(this.catalog, { system: CODER_LOOP_SYSTEM, messages });
    }
    return buildRequest({
      system: CODER_LOOP_SYSTEM,
      tools: [...this.tools.values()].map((tool) => tool.def),
      messages,
    });
  }

  /**
   * Over budget: start a fresh conversation from a 16k summary. The old
   * history is never edited (thinking blocks are checked against it); the new
   * one is a deliberate cache reset, so it is counted as a compaction, not a break.
   */
  private maybeCompact(task: string): void {
    const budget = this.options.compactAtTokens ?? 120_000;
    const size = estimateTokens(JSON.stringify(this.request.messages));
    if (size <= budget || this.request.messages.length < 3) return;
    const rendered = this.request.messages.slice(1).map((row) => ({
      role: row.role,
      content: renderForSummary(row.content),
    }));
    const compacted = compactHistory(rendered, this.settings.compactionSummaryTokens);
    const summary = compacted.messages.map((row) => `${row.role}: ${row.content}`).join('\n');
    // Loaded tools came in as tool_reference blocks of the old conversation;
    // the fresh one starts with core tools again and says what to reload.
    const loaded = this.request.appendedTools.map((tool) => tool.name);
    const reload = loaded.length
      ? `\n\nTools you had loaded (call ${LOAD_TOOLS_NAME} again if you need them): ${loaded.join(', ')}`
      : '';
    this.request = this.freshRequest(
      `${task}\n\nEarlier work in this task (compacted to ${compacted.tokens} tokens):\n${summary}${reload}`,
    );
    this.prev = undefined;
    this.stats.compactions += 1;
  }

  private async callModel(): Promise<LoopModelTurn | { stop: CoderLoopStop }> {
    const body = toAnthropicLoopBody(this.request, {
      model: this.options.model.model,
      maxTokens: this.options.maxTokens ?? 16_000,
      wireTools: this.wireTools,
    });
    const cache = recordCacheBreak(this.state, this.prev, this.request);
    this.state = cache.state;
    this.prev = this.request;
    let silences = 0;
    let failures = 0;
    for (;;) {
      const ac = new AbortController();
      let silent = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          silent = true;
          ac.abort();
        }, this.settings.streamSilenceMs);
      };
      arm();
      this.stats.modelRequests += 1;
      try {
        const turn = await this.options.model.next(body, { signal: ac.signal, onEvent: arm });
        this.recordUsage(turn);
        return turn;
      } catch (error) {
        if (silent || error instanceof StreamSilenceError) {
          silences += 1;
          this.stats.streamRetries += 1;
          const observed = observeStreamSilence(this.state, this.now(), this.settings);
          this.state = observed.state;
          this.incidents.push(observed.incident);
          if (silences >= MAX_STREAM_RETRIES) return { stop: 'stream_silence' };
          continue;
        }
        const retryable = error instanceof LoopProviderError ? error.retryable : false;
        failures += 1;
        if (!retryable || failures >= MAX_PROVIDER_RETRIES) {
          this.incidents.push({
            action: 'stop',
            rule: 'stream_silence',
            detail: `Provider error on ${this.options.model.endpoint}: ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 300),
            at: this.now(),
          });
          return { stop: 'provider_error' };
        }
        // Same provider, same body: a retry must not move the cache prefix.
        this.stats.providerRetries += 1;
        await this.sleep(1000 * 2 ** (failures - 1));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  private recordUsage(turn: LoopModelTurn): void {
    this.stats.inputTokens += turn.usage.inputTokens;
    this.stats.outputTokens += turn.usage.outputTokens;
    this.stats.cacheReadTokens += turn.usage.cacheReadTokens;
    this.stats.cacheWriteTokens += turn.usage.cacheWriteTokens;
    this.stats.usdMicros += loopUsdMicros(turn.model, turn.usage);
    this.state = recordCacheUsage(this.state, {
      inputTokens: turn.usage.inputTokens,
      cacheReadTokens: turn.usage.cacheReadTokens,
      cacheWriteTokens: turn.usage.cacheWriteTokens,
    });
  }

  private async runTool(block: ContentBlock, invalid: readonly string[]): Promise<LoopToolOutput> {
    const name = String(block.name ?? '');
    const args = (block.input ?? {}) as Record<string, unknown>;
    if (typeof block.id === 'string' && invalid.includes(block.id)) {
      return {
        content: 'INVALID_JSON: the tool input was not valid JSON; send it again.',
        isError: true,
      };
    }
    if (this.catalog && name === LOAD_TOOLS_NAME) {
      const loaded = handleLoadTools(this.request, this.catalog, {
        ...(Array.isArray(args.names) ? { names: args.names as string[] } : {}),
        ...(typeof args.query === 'string' ? { query: args.query } : {}),
      });
      this.request = loaded.request;
      return { content: loaded.content };
    }
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool ${name}.`, isError: true };
    if (this.catalog && !isCallable(this.request, name)) {
      return {
        content: `${name} is not loaded yet; call ${LOAD_TOOLS_NAME} first.`,
        isError: true,
      };
    }
    try {
      return await tool.run(args, {
        workspace: this.workspace,
        ...(this.input.testCommand ? { testCommand: this.input.testCommand } : {}),
        background: (label, job) => this.addJob(label, job),
      });
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  private addJob(label: string, job: Promise<string>): string {
    this.jobSeq += 1;
    const id = `job_${this.jobSeq}`;
    this.stats.backgroundJobs += 1;
    const settled = job.then(
      (text) => ({ id, label, text }),
      (error: unknown) => ({
        id,
        label,
        text: `failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    this.jobs.set(
      id,
      settled.then((row) => {
        this.jobs.delete(id);
        this.finished.push(row);
        return row;
      }),
    );
    return id;
  }

  private async waitForJob(): Promise<void> {
    if (this.finished.length > 0 || this.jobs.size === 0) return;
    await Promise.race(this.jobs.values());
  }

  private drainFinished(): ContentBlock[] {
    const rows = this.finished.splice(0);
    return rows.map((row) => ({
      type: 'text',
      text: `Background ${row.label} ${row.id} finished:\n${row.text}`,
    }));
  }

  private async changedFiles(): Promise<string[]> {
    const status = await this.workspace.run('git status --porcelain --untracked-files=all', {
      timeoutSeconds: 60,
    });
    if (status.exitCode !== 0) return [];
    return status.stdout
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((path) => path.length > 0 && !path.startsWith('.maka/'));
  }
}

const EMPTY_TURN_NUDGE =
  'Your last reply had no visible output. Continue with the task using the tools, or reply with a short summary if you are done.';

function repeatNudge(incident: AutonomyIncident): string {
  return `${incident.detail} The same call keeps returning the same result. Change approach: read a different file, edit the code, or run a different command.`;
}

function taskMessage(brief: string, testCommand: string | undefined, listing: string): string {
  return [
    `Task: ${brief}`,
    testCommand ? `Test command: ${testCommand}` : 'Find and run the repository tests.',
    `Repository files:\n${clip(listing.trim() || '(empty)', 4000)}`,
  ].join('\n\n');
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n')
    .trim();
}

function renderForSummary(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.type === 'text') return String(block.text ?? '');
      if (block.type === 'tool_use') return `[${block.name}] ${JSON.stringify(block.input ?? {})}`;
      if (block.type === 'tool_result') {
        const body =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        return `[result] ${clip(body, 1500)}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more chars)`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function relPath(value: unknown, fallback?: string): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (raw === undefined) throw new Error('path is required');
  const rel = raw.replace(/^\.\/+/, '') || '.';
  if (rel === '.') return rel;
  return safeRelPath(rel);
}

function listCommand(path: string): string {
  const q = shellQuote(path);
  return `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files --cached --others --exclude-standard -- ${q} | head -1000; else find ${q} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | head -1000; fi`;
}

function formatRun(result: SandboxExecResult): string {
  const out =
    result.stdout.length > RUN_HEAD + RUN_TAIL
      ? `${result.stdout.slice(0, RUN_HEAD)}\n… (${result.stdout.length - RUN_HEAD - RUN_TAIL} chars cut) …\n${result.stdout.slice(-RUN_TAIL)}`
      : result.stdout;
  return [
    `exit=${result.exitCode}`,
    `--- stdout ---\n${out}`,
    `--- stderr ---\n${clip(result.stderr, 4000)}`,
  ].join('\n');
}

function sameCommand(command: string, testCommand: string | undefined): boolean {
  if (!testCommand) return false;
  const norm = (value: string) => value.trim().replace(/\s+/g, ' ');
  return norm(command).includes(norm(testCommand));
}

/** read_file, list_files, search, apply_patch, write_file, run — all commands in the workspace. */
export function builtinTools(): LoopTool[] {
  return [
    {
      def: {
        name: 'read_file',
        description:
          'Read a text file. Lines come back numbered. Use offset (1-based line) and limit for big files.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to the repository root.' },
            offset: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1 },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const path = relPath(input.path);
        const result = await ctx.workspace.run(`cat -- ${shellQuote(path)}`, {
          timeoutSeconds: 60,
        });
        if (result.exitCode !== 0) {
          return { content: clip(result.stderr || `cannot read ${path}`, 2000), isError: true };
        }
        const lines = result.stdout.split('\n');
        const offset = Math.max(1, Number(input.offset ?? 1) || 1);
        const limit = Math.max(1, Number(input.limit ?? 2000) || 2000);
        const window = lines.slice(offset - 1, offset - 1 + limit);
        const body = window.map((line, i) => `${offset + i}\t${line}`).join('\n');
        const more = offset - 1 + limit < lines.length ? `\n… (${lines.length} lines in file)` : '';
        return { content: clip(body, READ_CAP) + more };
      },
    },
    {
      def: {
        name: 'list_files',
        description:
          'List files under a directory (git-tracked and untracked, ignoring .gitignore).',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory; defaults to the root.' } },
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const result = await ctx.workspace.run(listCommand(relPath(input.path, '.')), {
          timeoutSeconds: 60,
        });
        return {
          content: clip(result.stdout.trim() || '(no files)', READ_CAP),
          isError: result.exitCode !== 0,
        };
      },
    },
    {
      def: {
        name: 'search',
        description: 'Search file contents with a grep regular expression. Returns path:line:text.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', description: 'Directory or file; defaults to the root.' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const pattern = String(input.pattern ?? '');
        if (!pattern) return { content: 'pattern is required', isError: true };
        const path = relPath(input.path, '.');
        const result = await ctx.workspace.run(
          `grep -rnIE --exclude-dir=.git --exclude-dir=node_modules -e ${shellQuote(pattern)} -- ${shellQuote(path)} | head -200`,
          { timeoutSeconds: 60 },
        );
        return { content: clip(result.stdout.trim() || 'no matches', READ_CAP) };
      },
    },
    {
      def: {
        name: 'apply_patch',
        description:
          'Apply a unified diff (git diff format, paths a/... b/...) to the repository. Fails without changing files if it does not apply.',
        inputSchema: {
          type: 'object',
          properties: { patch: { type: 'string' } },
          required: ['patch'],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const patch = String(input.patch ?? '');
        if (!patch.trim()) return { content: 'patch is empty', isError: true };
        const text = patch.endsWith('\n') ? patch : `${patch}\n`;
        for (const header of text.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) {
          if (header[1] !== '/dev/null') relPath(header[1]);
        }
        const result = await ctx.workspace.run(
          'git apply --whitespace=nowarn --recount - 2>&1 || patch -p1 --forward --batch 2>&1',
          { stdin: text, timeoutSeconds: 60 },
        );
        if (result.exitCode !== 0) {
          return {
            content: clip(`patch did not apply:\n${result.stdout}${result.stderr}`, 4000),
            isError: true,
          };
        }
        return { content: 'patch applied' };
      },
    },
    {
      def: {
        name: 'write_file',
        description: 'Create or overwrite a file with the full content given.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const path = relPath(input.path);
        const content = typeof input.content === 'string' ? input.content : '';
        const q = shellQuote(path);
        const result = await ctx.workspace.run(`mkdir -p "$(dirname ${q})" && base64 -d > ${q}`, {
          stdin: Buffer.from(content).toString('base64'),
          timeoutSeconds: 60,
        });
        if (result.exitCode !== 0) {
          return { content: clip(result.stderr || `cannot write ${path}`, 2000), isError: true };
        }
        return { content: `wrote ${path} (${Buffer.byteLength(content)} bytes)` };
      },
    },
    {
      def: {
        name: 'run',
        description:
          'Run a shell command in the repository root (tests, builds, git). Output is clipped; exit code is reported.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_seconds: { type: 'integer', minimum: 1, maximum: 900 },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const command = String(input.command ?? '').trim();
        if (!command) return { content: 'command is required', isError: true };
        const timeout = Math.min(900, Math.max(1, Number(input.timeout_seconds ?? 300) || 300));
        const result = await ctx.workspace.run(command, { timeoutSeconds: timeout });
        return {
          content: formatRun(result),
          isError: result.exitCode !== 0,
          testsPassed: result.exitCode === 0 && sameCommand(command, ctx.testCommand),
        };
      },
    },
  ];
}
