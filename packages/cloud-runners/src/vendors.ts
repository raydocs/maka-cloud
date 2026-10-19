import type { ModelAccess } from './types.js';
import { shq } from './shell.js';

/** What a CLI's event stream says, reduced to what a runner reports. */
export type ParsedEvent =
  | { kind: 'session'; id: string }
  | { kind: 'progress'; note: string }
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
  baseUrl?: string;
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
  command(input: CommandInput): string;
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

function guardLine(message: string): string {
  return `{ echo ${shq(`MAKA_GUARD: ${message}`)}; finish 42; exit 42; }`;
}

// -- Claude (the Claude CLI that the Agent SDK drives) ------------------------------------------

function claudeParser(redact: Redact = keep): LineParser {
  return {
    feed(line) {
      const event = parseJson(line);
      if (!event) return [];
      const out: ParsedEvent[] = [];
      const type = str(event.type);
      if (type === 'system' && event.subtype === 'init') {
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
            }
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
  command(input) {
    const args = [
      'claude',
      '-p',
      shq(input.prompt),
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--setting-sources',
      'project,local',
    ];
    if (input.resumeSessionId) args.push('--resume', shq(input.resumeSessionId));
    if (input.model) args.push('--model', shq(input.model));
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
      args.push('--mcp-config', shq(JSON.stringify(config)), '--strict-mcp-config');
    }
    return args.join(' ');
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
  command(input) {
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
    const args = ['codex', 'exec'];
    if (input.resumeSessionId) args.push('resume', shq(input.resumeSessionId));
    args.push('--json', '--skip-git-repo-check');
    for (const config of configs) args.push('-c', shq(config));
    args.push(shq(input.prompt));
    return args.join(' ');
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
