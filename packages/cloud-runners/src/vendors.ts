import type { ModelAccess } from './types.js';
import { shq } from './shell.js';

/** What a CLI's event stream says, reduced to what a runner reports. */
export type ParsedEvent =
  | { kind: 'session'; id: string }
  | { kind: 'progress'; note: string }
  /** What the agent says it is doing now: the item in progress on its own todo list. */
  | { kind: 'step'; text: string }
  /** A page the agent fetched and got an answer for. */
  | { kind: 'opened'; url: string }
  /** Tokens of one model call. A repeat with the same `id` replaces the earlier count. */
  | { kind: 'usage'; id: string; tokens: TokenUsage }
  /** The CLI's own total for this invocation, in dollars; it replaces the token estimate. */
  | { kind: 'cost'; totalUsd: number }
  | { kind: 'result'; ok: boolean; text?: string };

/** Token counts of one model call. `input` excludes the cached tokens. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Dollars per million tokens. */
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Estimates for metering a run while it works, until the model gateway's own ledger (T17) is the
 * source. Claude: Claude Opus 5.5 list prices (the conductor uses the same table), and the CLI's
 * own total replaces the estimate when each invocation ends. Codex: a stand-in to override with
 * `prices` for the model actually configured.
 */
export const DEFAULT_PRICES: Record<VendorAdapter['name'], TokenPrices> = {
  'claude-agent-sdk': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  codex: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

export function tokenCostUsd(tokens: TokenUsage, prices: TokenPrices): number {
  return (
    (tokens.input * prices.input +
      tokens.output * prices.output +
      tokens.cacheRead * prices.cacheRead +
      tokens.cacheWrite * prices.cacheWrite) /
    1_000_000
  );
}

export interface LineParser {
  /** One output line. Lines that are not JSON events return nothing. */
  feed(line: string): ParsedEvent[];
}

/** Removes secrets from text. Parsers apply it to every piece of text before they shorten it. */
export type Redact = (text: string) => string;

const keep: Redact = (text) => text;

export interface CommandInput {
  prompt: string;
  resumeSessionId?: string;
  /** Orchestrator MCP endpoint as the sandbox reaches it. The token travels in MAKA_MCP_TOKEN. */
  mcpUrl?: string;
  model?: string;
  /** One of `EFFORT_LEVELS`; the CLI's own default when absent. */
  effort?: string;
  baseUrl?: string;
}

/** Reasoning levels both CLIs take. Anything else is refused before a sandbox is touched. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

/** A model id as a CLI argument: a short, plain name. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

/** Why a run's model or effort cannot be used, or undefined. */
export function runSettingsProblem(settings: {
  model?: string;
  effort?: string;
}): string | undefined {
  if (settings.model !== undefined && !MODEL_ID.test(settings.model)) {
    return 'the run names a model id with characters a model id does not have';
  }
  if (
    settings.effort !== undefined &&
    !(EFFORT_LEVELS as readonly string[]).includes(settings.effort)
  ) {
    return `the run names an effort that is not one of ${EFFORT_LEVELS.join(', ')}`;
  }
  return undefined;
}

export interface VendorAdapter {
  /** The runner name registered with the orchestrator. */
  readonly name: 'claude-agent-sdk' | 'codex';
  readonly binary: string;
  readonly npmPackage: string;
  readonly defaultVersion: string;
  /** Variables that would select a subscription login. Unset before the CLI starts. */
  readonly unsetVars: readonly string[];
  /** Shell lines that refuse to start when a subscription login is present in the sandbox. */
  readonly guard: string;
  /** The program and its arguments, as they are, with no shell quoting: the machine quotes them. */
  argv(input: CommandInput): string[];
  env(access: ModelAccess, mcpToken: string | undefined): Record<string, string>;
  parser(redact?: Redact): LineParser;
}

const MAX_NOTE = 200;

export function clip(text: string, max = MAX_NOTE): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function parseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MAX_STEP = 120;
const MAX_PENDING_FETCHES = 32;

// Controls, direction and zero-width marks, private-use and unassigned code points, separators
// and invisible letters: an agent's line cannot show something other than what it is.
const UNPRINTABLE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

/**
 * The item in progress on an agent's own todo list, as one short printable line, or nothing. No
 * model is asked: the agent keeps this list anyway. The idea is Reason Network's `doing.rs`
 * (MIT or Apache-2.0); no code is taken from it.
 */
export function stepLine(text: string, redact: Redact = keep): string | undefined {
  const line = redact(text).replace(UNPRINTABLE, ' ').replace(/\s+/gu, ' ').trim();
  return line === '' ? undefined : clip(line, MAX_STEP);
}

/** The text of the first todo that is in progress, from the shapes the CLIs write. */
function inProgress(
  items: unknown,
  status: (item: Record<string, unknown>) => boolean,
): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    const entry = obj(item);
    if (!entry || !status(entry)) continue;
    return str(entry.activeForm) ?? str(entry.content) ?? str(entry.subject) ?? str(entry.text);
  }
  return undefined;
}

function guardLine(message: string): string {
  return `{ echo ${shq(`MAKA_GUARD: ${message}`)}; finish 42; exit 42; }`;
}

// -- Claude (the Claude CLI that the Agent SDK drives) ------------------------------------------

function claudeParser(redact: Redact = keep): LineParser {
  // WebFetch calls waiting for their answer, by tool call id; a page is opened once it answered.
  const fetches = new Map<string, string>();
  // The session's own title stands in until the agent's todo list has an item in progress.
  let stepSeen = false;
  return {
    feed(line) {
      const event = parseJson(line);
      if (!event) return [];
      const out: ParsedEvent[] = [];
      const type = str(event.type);
      if (type === 'ai-title' || type === 'summary') {
        // The title the CLI gives its own session, as a transcript line (fed by the T28 mirror).
        const title = stepLine(str(event.aiTitle) ?? str(event.summary) ?? '', redact);
        if (title !== undefined && !stepSeen) out.push({ kind: 'step', text: title });
      } else if (type === 'system' && event.subtype === 'init') {
        const id = str(event.session_id);
        if (id) out.push({ kind: 'session', id });
      } else if (type === 'assistant') {
        const message = obj(event.message);
        const id = str(message?.id);
        const usage = obj(message?.usage);
        if (id && usage) {
          out.push({
            kind: 'usage',
            id,
            tokens: {
              input: num(usage.input_tokens),
              output: num(usage.output_tokens),
              cacheRead: num(usage.cache_read_input_tokens),
              cacheWrite: num(usage.cache_creation_input_tokens),
            },
          });
        }
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = obj(block);
            if (!b) continue;
            if (b.type === 'text' && str(b.text))
              out.push({ kind: 'progress', note: clip(redact(b.text as string)) });
            if (b.type === 'tool_use' && str(b.name)) {
              out.push({ kind: 'progress', note: `tool: ${clip(redact(String(b.name)), 80)}` });
              const input = obj(b.input);
              if (b.name === 'TodoWrite') {
                const text = inProgress(input?.todos, (todo) => todo.status === 'in_progress');
                const step = text === undefined ? undefined : stepLine(text, redact);
                if (step !== undefined) {
                  stepSeen = true;
                  out.push({ kind: 'step', text: step });
                }
              } else if (b.name === 'TaskUpdate' && input?.status === 'in_progress') {
                const step = stepLine(str(input.activeForm) ?? str(input.subject) ?? '', redact);
                if (step !== undefined) {
                  stepSeen = true;
                  out.push({ kind: 'step', text: step });
                }
              } else if (b.name === 'WebFetch' && str(b.id) && str(input?.url)) {
                if (fetches.size >= MAX_PENDING_FETCHES) fetches.clear();
                fetches.set(b.id as string, input?.url as string);
              }
            }
          }
        }
      } else if (type === 'user') {
        const content = obj(event.message)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = obj(block);
            const id = b?.type === 'tool_result' ? str(b.tool_use_id) : undefined;
            const url = id === undefined ? undefined : fetches.get(id);
            if (id === undefined || url === undefined) continue;
            fetches.delete(id);
            if (b?.is_error !== true) out.push({ kind: 'opened', url });
          }
        }
      } else if (type === 'result') {
        const id = str(event.session_id);
        if (id) out.push({ kind: 'session', id });
        if (typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd)) {
          out.push({ kind: 'cost', totalUsd: Math.max(0, event.total_cost_usd) });
        }
        const text = str(event.result);
        out.push({
          kind: 'result',
          ok: event.is_error !== true && !String(event.subtype ?? '').startsWith('error'),
          ...(text ? { text: clip(redact(text)) } : {}),
        });
      }
      return out;
    },
  };
}

export const claudeAdapter: VendorAdapter = {
  name: 'claude-agent-sdk',
  binary: 'claude',
  npmPackage: '@anthropic-ai/claude-code',
  defaultVersion: '2.1.303',
  unsetVars: [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ],
  guard: [
    `if [ -e "$HOME/.claude/.credentials.json" ] || { [ -f "$HOME/.claude.json" ] && grep -q oauthAccount "$HOME/.claude.json"; }; then`,
    `  ${guardLine('a subscription login is present in the sandbox; only API keys are allowed')}`,
    'fi',
  ].join('\n'),
  argv(input) {
    const args = [
      'claude',
      '-p',
      input.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--setting-sources',
      'project,local',
    ];
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
    if (input.model) args.push('--model', input.model);
    if (input.effort) args.push('--effort', input.effort);
    if (input.mcpUrl) {
      const config = {
        mcpServers: {
          maka: {
            type: 'http',
            url: input.mcpUrl,
            // Expanded by the CLI from its environment, so the token is never written to disk.
            headers: { Authorization: 'Bearer ${MAKA_MCP_TOKEN}' },
          },
        },
      };
      args.push('--mcp-config', JSON.stringify(config), '--strict-mcp-config');
    }
    return args;
  },
  env(access, mcpToken) {
    return {
      ANTHROPIC_API_KEY: access.apiKey,
      ...(access.baseUrl ? { ANTHROPIC_BASE_URL: access.baseUrl } : {}),
      ...(mcpToken ? { MAKA_MCP_TOKEN: mcpToken } : {}),
      DISABLE_AUTOUPDATER: '1',
    };
  },
  parser: claudeParser,
};

// -- Codex ---------------------------------------------------------------------------------------

function codexParser(redact: Redact = keep): LineParser {
  return {
    feed(line) {
      const event = parseJson(line);
      if (!event) return [];
      const out: ParsedEvent[] = [];
      const type = str(event.type);
      if (type === 'thread.started') {
        const id = str(event.thread_id);
        if (id) out.push({ kind: 'session', id });
      } else if (
        (type === 'item.started' || type === 'item.updated' || type === 'item.completed') &&
        obj(event.item)?.type === 'todo_list'
      ) {
        const text = inProgress(obj(event.item)?.items, (todo) => todo.completed !== true);
        const step = text === undefined ? undefined : stepLine(text, redact);
        if (step !== undefined) out.push({ kind: 'step', text: step });
      } else if (type === 'item.started' || type === 'item.completed') {
        const item = obj(event.item);
        const itemType = str(item?.type);
        if (type === 'item.completed' && itemType === 'agent_message' && str(item?.text)) {
          out.push({ kind: 'progress', note: clip(redact(item?.text as string)) });
        } else if (
          type === 'item.started' &&
          itemType === 'command_execution' &&
          str(item?.command)
        ) {
          out.push({
            kind: 'progress',
            note: `run: ${clip(redact(item?.command as string), 120)}`,
          });
        } else if (type === 'item.started' && itemType === 'mcp_tool_call') {
          out.push({
            kind: 'progress',
            note: `tool: ${clip(redact(`${str(item?.server) ?? 'mcp'}.${str(item?.tool) ?? '?'}`), 80)}`,
          });
        } else if (type === 'item.completed' && itemType === 'file_change') {
          out.push({ kind: 'progress', note: 'edited files' });
        }
      } else if (type === 'turn.completed') {
        const usage = obj(event.usage);
        if (usage && (num(usage.input_tokens) > 0 || num(usage.output_tokens) > 0)) {
          // OpenAI counts cached tokens inside input_tokens.
          const cached = num(usage.cached_input_tokens);
          out.push({
            kind: 'usage',
            id: 'turn',
            tokens: {
              input: Math.max(0, num(usage.input_tokens) - cached),
              output: num(usage.output_tokens),
              cacheRead: cached,
              cacheWrite: 0,
            },
          });
        }
        out.push({ kind: 'result', ok: true });
      } else if (type === 'turn.failed') {
        const message = str(obj(event.error)?.message);
        out.push({
          kind: 'result',
          ok: false,
          ...(message ? { text: clip(redact(message)) } : {}),
        });
      } else if (type === 'error') {
        const message = str(event.message);
        out.push({
          kind: 'result',
          ok: false,
          ...(message ? { text: clip(redact(message)) } : {}),
        });
      }
      return out;
    },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export const codexAdapter: VendorAdapter = {
  name: 'codex',
  binary: 'codex',
  npmPackage: '@openai/codex',
  defaultVersion: '0.163.0',
  unsetVars: [],
  guard: [
    `if [ -f "\${CODEX_HOME:-$HOME/.codex}/auth.json" ] && grep -Eq '"auth_mode": *"chatgpt"|"tokens"' "\${CODEX_HOME:-$HOME/.codex}/auth.json"; then`,
    `  ${guardLine('a subscription login is present in the sandbox; only API keys are allowed')}`,
    'fi',
  ].join('\n'),
  argv(input) {
    // Everything goes through -c so the same options work for `exec` and `exec resume`.
    const configs = [
      'sandbox_mode="danger-full-access"',
      'approval_policy="never"',
      'forced_login_method="api"',
    ];
    if (input.baseUrl) configs.push(`openai_base_url=${tomlString(input.baseUrl)}`);
    if (input.mcpUrl) {
      configs.push(
        `mcp_servers.maka.url=${tomlString(input.mcpUrl)}`,
        'mcp_servers.maka.bearer_token_env_var="MAKA_MCP_TOKEN"',
      );
    }
    if (input.model) configs.push(`model=${tomlString(input.model)}`);
    if (input.effort) configs.push(`model_reasoning_effort=${tomlString(input.effort)}`);
    const args = ['codex', 'exec'];
    if (input.resumeSessionId) args.push('resume', input.resumeSessionId);
    args.push('--json', '--skip-git-repo-check');
    for (const config of configs) args.push('-c', config);
    args.push(input.prompt);
    return args;
  },
  env(access, mcpToken) {
    return {
      OPENAI_API_KEY: access.apiKey,
      CODEX_API_KEY: access.apiKey,
      ...(mcpToken ? { MAKA_MCP_TOKEN: mcpToken } : {}),
    };
  },
  parser: codexParser,
};

/** The shell lines that run before the CLI: drop login selectors, then refuse a subscription login. */
export function preambleFor(vendor: VendorAdapter): string {
  const unset = vendor.unsetVars.map((name) => `unset ${name}`).join('\n');
  return `${unset}\n${vendor.guard}`;
}
