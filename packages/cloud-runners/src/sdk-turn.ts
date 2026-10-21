import type { Options, Query, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { StepLog } from '@maka-cloud/orchestrator';
import { stepHooks } from './hooks.js';
import type { ExecProcess } from './process-channel.js';
import { allowedSdkEnv } from './process-channel.js';

/** The part of the Claude Agent SDK this package uses. Injected, so tests never need the real one. */
export interface AgentSdk {
  query(params: { prompt: string; options?: Options }): Query;
}

/** Loads the installed Claude Agent SDK. Throws when it is not installed. */
export async function loadAgentSdk(): Promise<AgentSdk> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return { query: sdk.query };
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
    spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) =>
      input.spawn({
        args: spawnOptions.args,
        env: allowedSdkEnv(spawnOptions.env),
        signal: spawnOptions.signal,
      }),
  };
  return input.sdk.query({ prompt: input.prompt, options });
}
