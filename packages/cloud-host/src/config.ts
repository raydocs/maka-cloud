import { join } from 'node:path';
import { githubTokenProblem } from '@maka-cloud/playbooks/coding';

/**
 * Everything the stack needs, read from the environment. Secret values are kept
 * only where they are used; `describeConfig` never prints them.
 */
export interface StackConfig {
  dataDir: string;
  dbPath: string;
  invitesPath: string;
  handoffRoot: string;
  conductorRoot: string;
  runnerSessionsPath: string;
  codingDeliveriesPath: string;
  host: string;
  port: number;
  mcp: {
    host: string;
    port: number;
    /** The orchestrator's MCP URL as the sandbox reaches it. Without it, tasks get the local URL. */
    publicUrl?: string;
  };
  conductor: {
    apiKey: string;
    baseUrl?: string;
    connectionId?: string;
  };
  instabox: {
    machineId: string;
    apiUrl?: string;
  };
  /** The codex runner needs it when a task starts; the stack starts without it. */
  openAiKeySet: boolean;
  /** Why no pull request can be opened with `MAKA_GITHUB_TOKEN`, if it cannot. */
  githubTokenProblem?: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `The environment does not configure the stack:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

/** The variables `readStackConfig` reads, for the usage text. */
export const ENV_VARIABLES = [
  [
    'MAKA_CLOUD_DATA_DIR',
    'required: directory for the databases, handoff files and conductor storage',
  ],
  ['MAKA_CLOUD_HOST', 'public API host (default 127.0.0.1)'],
  ['MAKA_CLOUD_PORT', 'public API port (default 8080)'],
  ['MAKA_CLOUD_MCP_HOST', 'orchestrator MCP host (default 127.0.0.1)'],
  ['MAKA_CLOUD_MCP_PORT', 'orchestrator MCP port (default 8081)'],
  ['MAKA_CLOUD_MCP_PUBLIC_URL', 'the MCP URL as the sandbox reaches it (http or https)'],
  ['ANTHROPIC_API_KEY', 'required: the conductor’s and the Claude runner’s API key'],
  ['ANTHROPIC_BASE_URL', 'Messages API base URL, for a gateway'],
  ['MAKA_CLOUD_LLM_CONNECTION_ID', 'stable id of the conductor’s model connection'],
  ['INSTABOX_API_KEY', 'required: sandbox API key'],
  ['INSTABOX_MACHINE_ID', 'required: the sandbox machine tasks run in'],
  ['INSTABOX_API_URL', 'sandbox API base URL'],
  ['OPENAI_API_KEY', 'the Codex runner’s API key, read when a task starts'],
  [
    'MAKA_GITHUB_TOKEN',
    'fine-grained GitHub token for opening pull requests, read when one is opened',
  ],
] as const;

export function readStackConfig(env: NodeJS.ProcessEnv): StackConfig {
  const problems: string[] = [];
  const value = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const required = (name: string): string => {
    const found = value(name);
    if (found === undefined) problems.push(`${name} is not set`);
    return found ?? '';
  };
  const port = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!/^\d+$/u.test(raw) || parsed < 1 || parsed > 65535) {
      problems.push(`${name} must be a port number from 1 to 65535`);
      return fallback;
    }
    return parsed;
  };
  const url = (name: string): string | undefined => {
    const raw = value(name);
    if (raw === undefined) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      problems.push(`${name} is not a URL`);
      return undefined;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      problems.push(`${name} must be an http or https URL`);
      return undefined;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      problems.push(`${name} must not carry credentials`);
      return undefined;
    }
    return raw;
  };

  const dataDir = required('MAKA_CLOUD_DATA_DIR');
  const config: StackConfig = {
    dataDir,
    dbPath: join(dataDir, 'cloud.db'),
    invitesPath: join(dataDir, 'invites.db'),
    handoffRoot: join(dataDir, 'handoff'),
    conductorRoot: join(dataDir, 'conductor'),
    runnerSessionsPath: join(dataDir, 'runner-sessions.json'),
    codingDeliveriesPath: join(dataDir, 'coding-deliveries.json'),
    host: value('MAKA_CLOUD_HOST') ?? '127.0.0.1',
    port: port('MAKA_CLOUD_PORT', 8080),
    mcp: {
      host: value('MAKA_CLOUD_MCP_HOST') ?? '127.0.0.1',
      port: port('MAKA_CLOUD_MCP_PORT', 8081),
    },
    conductor: { apiKey: required('ANTHROPIC_API_KEY') },
    instabox: { machineId: '' },
    openAiKeySet: value('OPENAI_API_KEY') !== undefined,
  };
  const github = githubTokenProblem(env.MAKA_GITHUB_TOKEN);
  if (github !== undefined) config.githubTokenProblem = github;
  const publicUrl = url('MAKA_CLOUD_MCP_PUBLIC_URL');
  if (publicUrl !== undefined) config.mcp.publicUrl = publicUrl;
  const baseUrl = url('ANTHROPIC_BASE_URL');
  if (baseUrl !== undefined) config.conductor.baseUrl = baseUrl;
  const connectionId = value('MAKA_CLOUD_LLM_CONNECTION_ID');
  if (connectionId !== undefined) config.conductor.connectionId = connectionId;
  required('INSTABOX_API_KEY');
  config.instabox.machineId = required('INSTABOX_MACHINE_ID');
  const apiUrl = url('INSTABOX_API_URL');
  if (apiUrl !== undefined) config.instabox.apiUrl = apiUrl;
  if (config.port === config.mcp.port && config.host === config.mcp.host) {
    problems.push('MAKA_CLOUD_PORT and MAKA_CLOUD_MCP_PORT must differ');
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The resolved configuration without secret values, one setting per line. */
export function describeConfig(config: StackConfig): string[] {
  return [
    `data directory:      ${config.dataDir}`,
    `public API:          http://${config.host}:${config.port}`,
    `orchestrator MCP:    http://${config.mcp.host}:${config.mcp.port}/mcp`,
    `MCP URL for tasks:   ${config.mcp.publicUrl ?? '(not set: tasks get the local URL)'}`,
    `model API base URL:  ${config.conductor.baseUrl ?? '(default)'}`,
    `model connection id: ${config.conductor.connectionId ?? '(default)'}`,
    `sandbox machine:     ${config.instabox.machineId}`,
    `sandbox API URL:     ${config.instabox.apiUrl ?? '(default)'}`,
    `Codex runner key:    ${config.openAiKeySet ? 'set' : 'not set (Codex tasks will fail)'}`,
    `GitHub token:        ${config.githubTokenProblem ?? 'set (fine-grained)'}`,
    `invites file:        ${config.invitesPath}`,
  ];
}
