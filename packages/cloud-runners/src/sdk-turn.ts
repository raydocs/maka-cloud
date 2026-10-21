import type { Options, Query, SessionStore, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { StepLog } from '@maka-cloud/orchestrator';
import { readFile } from 'node:fs/promises';
import { stepHooks } from './hooks.js';
import type { ExecProcess } from './process-channel.js';
import { allowedSdkEnv } from './process-channel.js';

/** The part of the Claude Agent SDK this package uses. Injected, so tests never need the real one. */
export interface AgentSdk {
  query(params: { prompt: string; options?: Options }): Query;
  /**
   * The version of the `claude` CLI this SDK is built for. The CLI in the sandbox is installed at
   * this version, since the SDK passes flags (the transcript mirror among them) that older ones
   * may not know.
   */
  cliVersion?: string;
}

/** Loads the installed Claude Agent SDK. Throws when it is not installed. */
export async function loadAgentSdk(): Promise<AgentSdk> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const cliVersion = await cliVersionOf(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  return { query: sdk.query, ...(cliVersion ? { cliVersion } : {}) };
}

/** `claudeCodeVersion` in the SDK's package.json, which sits next to its entry file. */
async function cliVersionOf(entry: string): Promise<string | undefined> {
  try {
    const meta = JSON.parse(await readFile(new URL('package.json', entry), 'utf8')) as {
      claudeCodeVersion?: unknown;
    };
    const version = meta.claudeCodeVersion;
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/u.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

export interface AgentQueryInput {
  sdk: AgentSdk;
  prompt: string;
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  /** The orchestrator's MCP endpoint as the sandbox reaches it; the token is in `MAKA_MCP_TOKEN`. */
  mcpUrl?: string;
  /** The task's working directory on the sandbox. */
  workdir: string;
  /** Present when the run records steps. */
  steps?: StepLog;
  /**
   * Keeps the conversation off the sandbox. `store` receives every transcript line the CLI writes;
   * `configDir` is the CLI's configuration directory in the sandbox, where it writes them. The SDK
   * only accepts a line whose file is under the configuration directory it believes the CLI uses, so
   * both sides are told the same one.
   */
  mirror?: { store: SessionStore; configDir: string };
  redact(text: string): string;
  onProblem(message: string): void;
  /**
   * Starts the CLI on the sandbox with the arguments the SDK built. `args` are the SDK's;
   * `env` is only what `allowedSdkEnv` lets through of the SDK's own markers.
   */
  spawn(process: { args: string[]; env: Record<string, string>; signal: AbortSignal }): ExecProcess;
}

/**
 * One turn of the agent, driven by the SDK. It runs the same `claude` the CLI path runs, with the
 * flags `SandboxCliRunner` gives it (API-key access, project and local settings only, no
 * permission prompts, the orchestrator's MCP endpoint), but the SDK owns the conversation with it:
 * the prompt goes in as a message, and hooks call back into the host before and after every tool.
 *
 * The SDK's command and environment are not used. It would start its own bundled `claude` on the
 * host with the host's environment; here the process is a sandbox process, and what the SDK says
 * about its environment is reduced to its own markers.
 */
export function startAgentQuery(input: AgentQueryInput): Query {
  const options: Options = {
    cwd: input.workdir,
    // The CLI path's flags, `-p` aside: the Claude Code prompt, API-key access only.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'local'],
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort as NonNullable<Options['effort']> } : {}),
    ...(input.mcpUrl
      ? {
          mcpServers: {
            maka: {
              type: 'http',
              url: input.mcpUrl,
              // Expanded by the CLI from its environment, so the token is never written to disk.
              headers: { Authorization: 'Bearer ${MAKA_MCP_TOKEN}' },
            },
          },
          strictMcpConfig: true,
        }
      : {}),
    ...(input.steps ? { hooks: stepHooks(input.steps, input.redact, input.onProblem) } : {}),
    ...(input.mirror
      ? {
          sessionStore: input.mirror.store,
          // Each line is kept as it is written: a crash loses at most the line in flight.
          sessionStoreFlush: 'eager' as const,
          // Nothing of the host's environment is used; this is the one setting the SDK checks the
          // CLI's transcript paths against.
          env: { CLAUDE_CONFIG_DIR: input.mirror.configDir },
        }
      : {}),
    spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
      const configDir = input.mirror?.configDir;
      if (configDir !== undefined && spawnOptions.env.CLAUDE_CONFIG_DIR !== configDir) {
        input.onProblem(
          'the SDK moved the CLI’s configuration directory; transcript lines may not be kept',
        );
      }
      return input.spawn({
        args: spawnOptions.args,
        env: {
          ...allowedSdkEnv(spawnOptions.env),
          ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }),
        },
        signal: spawnOptions.signal,
      });
    },
  };
  return input.sdk.query({ prompt: input.prompt, options });
}
