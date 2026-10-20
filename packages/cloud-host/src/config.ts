import { isAbsolute, join, relative, resolve } from 'node:path';
import { type ModelPrice, priceProblem } from '@maka-cloud/gateway';
import { githubTokenProblem } from '@maka-cloud/playbooks/coding';
import { pushConfigFromEnv } from '@maka-cloud/server';
import type { BackupLayout } from './backup.js';
import { type InboxConfig, readInboxConfig } from './inbox/config.js';

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
  /** The supervisor's own database. */
  supervisorDbPath: string;
  /** The model gateway's journal of what tasks spent, read back after a restart. */
  gatewaySpendPath: string;
  /** Where the server writes its daily backups. Unset: it writes none. */
  backupDir?: string;
  /**
   * Tell `ownerInvite`'s devices (Web Push) once the server's spend of a UTC day reaches
   * `usd` dollars. Unset: no alert.
   */
  spendAlert?: { usd: number; ownerInvite: string };
  /** The operator's kill switch: while this file exists, nothing may spend. See `PauseSwitch`. */
  pausePath: string;
  host: string;
  port: number;
  mcp: {
    host: string;
    port: number;
    /** The orchestrator's MCP URL as the sandbox reaches it. Without it, tasks get the local URL. */
    publicUrl?: string;
  };
  /** The conductor reaches the model through the gateway, which alone holds the vendor key. */
  conductor: {
    connectionId?: string;
  };
  instabox: {
    apiUrl?: string;
  };
  /**
   * The sandbox machine of each invite, by invite id. A task runs only on its invite's machine, so
   * invites never share a machine, a Unix user or a process table. An invite with no entry cannot
   * run tasks.
   */
  sandboxes: Record<string, string>;
  /** The model gateway sandbox runs reach the vendors through. It reads the vendor keys itself. */
  gateway: {
    host: string;
    port: number;
    /** The gateway as sandboxes reach it. Without it, sandboxes get the local URL. */
    publicUrl?: string;
    /** Prices beyond the built-in Claude ones; Codex models need an entry here. */
    models: ModelPrice[];
    anthropicBaseUrl?: string;
    openAiBaseUrl?: string;
    /** The web search provider's API, when not its default. */
    searchBaseUrl?: string;
  };
  inbox: InboxConfig;
  /**
   * What model spend may reach, in USD per UTC day or month. An invite with no limit of its own
   * (`cloud-server invite limits`) gets the invite defaults. Small on purpose: a server nobody
   * configured cannot spend much.
   */
  spend: SpendCaps;
  /** The codex runner needs it when a task starts; the stack starts without it. */
  openAiKeySet: boolean;
  /** With it, research runs get a `web-search` command, paid per call from their budget. */
  searchKeySet: boolean;
  /** All three VAPID settings are set: the Web Push routes are on. The key itself is read from the environment by the stack. */
  pushSet: boolean;
  /** Why no pull request can be opened with `MAKA_GITHUB_TOKEN`, if it cannot. */
  githubTokenProblem?: string;
}

/** Why a backup directory cannot be used with a data directory, if it cannot. */
export function backupDirProblem(dataDir: string, backupDir: string): string | undefined {
  const inside = (parent: string, child: string): boolean => {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  if (!isAbsolute(backupDir)) return 'MAKA_CLOUD_BACKUP_DIR must be an absolute path';
  if (inside(dataDir, backupDir) || inside(backupDir, dataDir)) {
    return 'MAKA_CLOUD_BACKUP_DIR must not be inside the data directory or contain it';
  }
  return undefined;
}

/** Where the server keeps its state under a data directory. */
export function dataPathsOf(
  dataDir: string,
): Pick<
  StackConfig,
  | 'dbPath'
  | 'invitesPath'
  | 'handoffRoot'
  | 'conductorRoot'
  | 'runnerSessionsPath'
  | 'codingDeliveriesPath'
  | 'supervisorDbPath'
  | 'gatewaySpendPath'
> {
  return {
    dbPath: join(dataDir, 'cloud.db'),
    invitesPath: join(dataDir, 'invites.db'),
    handoffRoot: join(dataDir, 'handoff'),
    conductorRoot: join(dataDir, 'conductor'),
    runnerSessionsPath: join(dataDir, 'runner-sessions.json'),
    codingDeliveriesPath: join(dataDir, 'coding-deliveries.json'),
    supervisorDbPath: join(dataDir, 'supervisor.db'),
    gatewaySpendPath: join(dataDir, 'gateway-spend.db'),
  };
}

/** What a backup holds: every database and file the server keeps its state in, and nothing else. */
export function backupLayoutOf(dataDir: string): BackupLayout {
  const paths = dataPathsOf(dataDir);
  const rel = (path: string): string => relative(dataDir, path);
  const cloud = rel(paths.dbPath);
  return {
    databases: [
      cloud,
      rel(paths.invitesPath),
      rel(paths.supervisorDbPath),
      rel(paths.gatewaySpendPath),
    ],
    files: [rel(paths.runnerSessionsPath), rel(paths.codingDeliveriesPath)],
    trees: [rel(paths.conductorRoot), rel(paths.handoffRoot)],
    redact: {
      // A device's push secret lets whoever holds it read what the server sends that device, so
      // a backup keeps no subscriptions: devices turn notifications on again after a restore.
      [cloud]: (copy) => {
        try {
          copy.exec('DELETE FROM push_subscriptions');
        } catch (error) {
          if (!/no such table/iu.test(String((error as Error).message))) throw error;
        }
      },
    },
  };
}

/** Where the kill switch lives under a data directory. */
export function pausePathOf(dataDir: string): string {
  return join(dataDir, 'paused');
}

export interface SpendCaps {
  inviteDailyUsd: number;
  inviteMonthlyUsd: number;
  serverDailyUsd: number;
}

export const DEFAULT_SPEND_CAPS: SpendCaps = {
  inviteDailyUsd: 5,
  inviteMonthlyUsd: 50,
  serverDailyUsd: 25,
};

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `The environment does not configure the stack:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }

  /** Its message is ours (setting names and what is wrong), so the log may print it. */
  readonly safeToLog = true;
}

/** The variables `readStackConfig` reads, for the usage text. */
export const ENV_VARIABLES = [
  [
    'MAKA_CLOUD_DATA_DIR',
    'required: directory for the databases, handoff files and conductor storage',
  ],
  [
    'MAKA_CLOUD_BACKUP_DIR',
    'directory for the daily backup (kept 7 days, no keys inside); outside the data directory. Unset: no backups',
  ],
  [
    'MAKA_CLOUD_SPEND_ALERT_USD',
    'send a push notification to the owner’s devices once a UTC day’s spend reaches this many dollars; needs MAKA_CLOUD_OWNER_INVITE and Web Push',
  ],
  [
    'MAKA_CLOUD_OWNER_INVITE',
    'the invite id (inv_…) whose devices get the spend alert; its devices turn notifications on in the web app',
  ],
  ['MAKA_CLOUD_HOST', 'public API host (default 127.0.0.1)'],
  ['MAKA_CLOUD_PORT', 'public API port (default 8080)'],
  ['MAKA_CLOUD_MCP_HOST', 'orchestrator MCP host (default 127.0.0.1)'],
  ['MAKA_CLOUD_MCP_PORT', 'orchestrator MCP port (default 8081)'],
  ['MAKA_CLOUD_MCP_PUBLIC_URL', 'the MCP URL as the sandbox reaches it (http or https)'],
  [
    'ANTHROPIC_API_KEY',
    'required: the model gateway’s key for Claude (the conductor, checks and runs go through it)',
  ],
  ['ANTHROPIC_BASE_URL', 'Messages API base URL, for the conductor and the model gateway'],
  ['MAKA_CLOUD_LLM_CONNECTION_ID', 'stable id of the conductor’s model connection'],
  ['INSTABOX_API_KEY', 'required: sandbox API key'],
  [
    'MAKA_CLOUD_SANDBOXES',
    'required: JSON object {"<inviteId>": "<sandbox machine>"}, one machine per invite; an invite with no machine runs no tasks',
  ],
  ['INSTABOX_API_URL', 'sandbox API base URL'],
  ['OPENAI_API_KEY', 'the model gateway’s key for Codex runs'],
  ['OPENAI_BASE_URL', 'Responses API base URL for the model gateway'],
  ['DEEPSEEK_API_KEY', 'the model gateway’s key for web search (DeepSeek Search API)'],
  ['DEEPSEEK_BASE_URL', 'DeepSeek API base URL for web search'],
  ['MAKA_CLOUD_GATEWAY_HOST', 'model gateway host (default 127.0.0.1)'],
  ['MAKA_CLOUD_GATEWAY_PORT', 'model gateway port (default 8082)'],
  [
    'MAKA_CLOUD_GATEWAY_PUBLIC_URL',
    'the model gateway as the sandbox reaches it (https, or http on a loopback host)',
  ],
  [
    'MAKA_CLOUD_GATEWAY_MODELS',
    'JSON array of model prices for the gateway: {vendor, model, inputPerMTokUsd, outputPerMTokUsd, cacheReadPerMTokUsd?, maxOutputTokens, longContext?}; Codex models need one',
  ],
  [
    'MAKA_CLOUD_VERIFIER_MODELS',
    'JSON array of models that check finished work: {vendor, model, inputPerMTokUsd, outputPerMTokUsd}; none means only the checks that need no model run',
  ],
  [
    'MAKA_CLOUD_VERIFIER_DAILY_CAP_USD',
    'daily cap on model checks, default 5; changeable in the inbox settings',
  ],
  ['MAKA_CLOUD_SUMMARY_MODEL', 'model that writes the digest summary (default claude-haiku-5-5)'],
  [
    'MAKA_CLOUD_INVITE_DAILY_USD',
    'most an invite may spend per UTC day unless set with "cloud-server invite limits", default 5',
  ],
  [
    'MAKA_CLOUD_INVITE_MONTHLY_USD',
    'most an invite may spend per UTC month unless set with "cloud-server invite limits", default 50',
  ],
  ['MAKA_CLOUD_SERVER_DAILY_USD', 'most all invites together may spend per UTC day, default 25'],
  ['CLOUD_PUSH_VAPID_PUBLIC', 'Web Push: the VAPID public key (with the next two, turns push on)'],
  ['CLOUD_PUSH_VAPID_PRIVATE', 'Web Push: the VAPID private key, kept in memory only'],
  ['CLOUD_PUSH_SUBJECT', 'Web Push: the VAPID contact, a mailto: or https: URL'],
  [
    'CLOUD_PUSH_ALLOWED_HOSTS',
    'Web Push: comma separated push service hosts, default FCM, Mozilla, Apple, Windows',
  ],
  [
    'MAKA_GITHUB_TOKEN',
    'fine-grained GitHub token for opening pull requests, read when one is opened',
  ],
] as const;

export interface ReadStackConfigOptions {
  /**
   * Where tasks run. `per-invite` (default, the product) needs `MAKA_CLOUD_SANDBOXES` and refuses
   * `INSTABOX_MACHINE_ID`. `single-machine` is for a caller with no invites, such as the benchmark
   * harness: it needs `INSTABOX_MACHINE_ID`, and `sandboxes` stays empty.
   */
  sandboxes?: 'per-invite' | 'single-machine';
}

export function readStackConfig(
  env: NodeJS.ProcessEnv,
  options: ReadStackConfigOptions = {},
): StackConfig {
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
  const dollars = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!/^\d+(\.\d+)?$/u.test(raw) || !Number.isFinite(parsed) || parsed > 100_000) {
      problems.push(`${name} must be a number of dollars from 0 to 100000`);
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
    ...dataPathsOf(dataDir),
    pausePath: pausePathOf(dataDir),
    host: value('MAKA_CLOUD_HOST') ?? '127.0.0.1',
    port: port('MAKA_CLOUD_PORT', 8080),
    mcp: {
      host: value('MAKA_CLOUD_MCP_HOST') ?? '127.0.0.1',
      port: port('MAKA_CLOUD_MCP_PORT', 8081),
    },
    conductor: {},
    instabox: {},
    sandboxes: {},
    gateway: {
      host: value('MAKA_CLOUD_GATEWAY_HOST') ?? '127.0.0.1',
      port: port('MAKA_CLOUD_GATEWAY_PORT', 8082),
      models: gatewayModels(value('MAKA_CLOUD_GATEWAY_MODELS'), problems),
    },
    inbox: readInboxConfig(value, problems),
    spend: {
      inviteDailyUsd: dollars('MAKA_CLOUD_INVITE_DAILY_USD', DEFAULT_SPEND_CAPS.inviteDailyUsd),
      inviteMonthlyUsd: dollars(
        'MAKA_CLOUD_INVITE_MONTHLY_USD',
        DEFAULT_SPEND_CAPS.inviteMonthlyUsd,
      ),
      serverDailyUsd: dollars('MAKA_CLOUD_SERVER_DAILY_USD', DEFAULT_SPEND_CAPS.serverDailyUsd),
    },
    openAiKeySet: value('OPENAI_API_KEY') !== undefined,
    searchKeySet: value('DEEPSEEK_API_KEY') !== undefined,
    pushSet: false,
  };
  try {
    config.pushSet = pushConfigFromEnv(env) !== undefined;
  } catch (error) {
    // The message names the missing variables and never a value.
    problems.push(error instanceof Error ? error.message : 'the Web Push settings are not valid');
  }
  const github = githubTokenProblem(env.MAKA_GITHUB_TOKEN);
  if (github !== undefined) config.githubTokenProblem = github;
  const backupDir = value('MAKA_CLOUD_BACKUP_DIR');
  if (backupDir !== undefined) {
    const problem = backupDirProblem(dataDir, backupDir);
    if (problem === undefined) config.backupDir = backupDir;
    else problems.push(problem);
  }
  const alertUsd = value('MAKA_CLOUD_SPEND_ALERT_USD');
  const ownerInvite = value('MAKA_CLOUD_OWNER_INVITE');
  if (alertUsd !== undefined || ownerInvite !== undefined) {
    const usd = Number(alertUsd);
    if (alertUsd === undefined || ownerInvite === undefined) {
      problems.push('MAKA_CLOUD_SPEND_ALERT_USD and MAKA_CLOUD_OWNER_INVITE go together');
    } else if (!/^\d+(\.\d+)?$/u.test(alertUsd) || !(usd > 0) || usd > 100_000) {
      problems.push('MAKA_CLOUD_SPEND_ALERT_USD must be a number of dollars above 0, up to 100000');
    } else if (!/^inv_[0-9a-f]{12}$/u.test(ownerInvite)) {
      problems.push('MAKA_CLOUD_OWNER_INVITE must be an invite id such as inv_0123456789ab');
    } else if (!config.pushSet) {
      problems.push(
        'MAKA_CLOUD_SPEND_ALERT_USD needs Web Push: set the CLOUD_PUSH_* variables, or there is nobody to tell',
      );
    } else {
      config.spendAlert = { usd, ownerInvite };
    }
  }
  const publicUrl = url('MAKA_CLOUD_MCP_PUBLIC_URL');
  if (publicUrl !== undefined) config.mcp.publicUrl = publicUrl;
  // Checked here, read only by the gateway: the key is kept out of the config the stack passes on.
  required('ANTHROPIC_API_KEY');
  const baseUrl = url('ANTHROPIC_BASE_URL');
  if (baseUrl !== undefined) config.gateway.anthropicBaseUrl = baseUrl;
  const openAiBaseUrl = url('OPENAI_BASE_URL');
  if (openAiBaseUrl !== undefined) config.gateway.openAiBaseUrl = openAiBaseUrl;
  const searchBaseUrl = url('DEEPSEEK_BASE_URL');
  if (searchBaseUrl !== undefined) config.gateway.searchBaseUrl = searchBaseUrl;
  const gatewayUrl = url('MAKA_CLOUD_GATEWAY_PUBLIC_URL');
  if (gatewayUrl !== undefined) {
    // The task token travels in every request: in the clear only on the host itself.
    if (new URL(gatewayUrl).protocol === 'https:' || isLoopback(new URL(gatewayUrl).hostname)) {
      config.gateway.publicUrl = gatewayUrl;
    } else {
      problems.push('MAKA_CLOUD_GATEWAY_PUBLIC_URL must be https, except on a loopback host');
    }
  }
  const connectionId = value('MAKA_CLOUD_LLM_CONNECTION_ID');
  if (connectionId !== undefined) config.conductor.connectionId = connectionId;
  required('INSTABOX_API_KEY');
  if (options.sandboxes === 'single-machine') {
    required('INSTABOX_MACHINE_ID');
  } else {
    if (value('INSTABOX_MACHINE_ID') !== undefined) {
      problems.push(
        'INSTABOX_MACHINE_ID is no longer used: one machine for every invite lets invites read each other, set MAKA_CLOUD_SANDBOXES',
      );
    }
    config.sandboxes = sandboxTable(value('MAKA_CLOUD_SANDBOXES'), problems);
  }
  const apiUrl = url('INSTABOX_API_URL');
  if (apiUrl !== undefined) config.instabox.apiUrl = apiUrl;
  if (config.port === config.mcp.port && config.host === config.mcp.host) {
    problems.push('MAKA_CLOUD_PORT and MAKA_CLOUD_MCP_PORT must differ');
  }
  for (const [name, other] of [
    ['MAKA_CLOUD_PORT', config],
    ['MAKA_CLOUD_MCP_PORT', config.mcp],
  ] as const) {
    if (config.gateway.port === other.port && config.gateway.host === other.host) {
      problems.push(`MAKA_CLOUD_GATEWAY_PORT and ${name} must differ`);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/u.test(hostname);
}

const INVITE_ID = /^inv_[0-9a-f]{12}$/u;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** `{"<inviteId>": "<machine>"}`, at least one entry, and no machine used by two invites. */
function sandboxTable(raw: string | undefined, problems: string[]): Record<string, string> {
  if (raw === undefined) {
    problems.push('MAKA_CLOUD_SANDBOXES is not set');
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push('MAKA_CLOUD_SANDBOXES is not JSON');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push('MAKA_CLOUD_SANDBOXES must be a JSON object');
    return {};
  }
  const table: Record<string, string> = {};
  const owners = new Map<string, string>();
  const entries = Object.entries(parsed);
  if (entries.length === 0) problems.push('MAKA_CLOUD_SANDBOXES has no entry');
  for (const [inviteId, machineId] of entries) {
    if (!INVITE_ID.test(inviteId)) {
      problems.push('MAKA_CLOUD_SANDBOXES: a key is not an invite id (inv_ and 12 hex digits)');
    } else if (typeof machineId !== 'string' || !MACHINE_ID.test(machineId)) {
      problems.push(`MAKA_CLOUD_SANDBOXES: the machine of ${inviteId} is not a machine id`);
    } else if (owners.has(machineId)) {
      problems.push(
        `MAKA_CLOUD_SANDBOXES: ${inviteId} and ${owners.get(machineId)} share a machine`,
      );
    } else {
      owners.set(machineId, inviteId);
      table[inviteId] = machineId;
    }
  }
  return table;
}

function gatewayModels(raw: string | undefined, problems: string[]): ModelPrice[] {
  if (raw === undefined) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    problems.push('MAKA_CLOUD_GATEWAY_MODELS is not JSON');
    return [];
  }
  if (!Array.isArray(list)) {
    problems.push('MAKA_CLOUD_GATEWAY_MODELS must be a JSON array');
    return [];
  }
  const models: ModelPrice[] = [];
  list.forEach((entry: unknown, index) => {
    const problem =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? priceProblem(entry as ModelPrice)
        : 'must be an object';
    if (problem === undefined) models.push(entry as ModelPrice);
    else problems.push(`MAKA_CLOUD_GATEWAY_MODELS entry ${index + 1}: ${problem}`);
  });
  return models;
}

/** The resolved configuration without secret values, one setting per line. */
export function describeConfig(config: StackConfig): string[] {
  return [
    `data directory:      ${config.dataDir}`,
    `public API:          http://${config.host}:${config.port}`,
    `orchestrator MCP:    http://${config.mcp.host}:${config.mcp.port}/mcp`,
    `MCP URL for tasks:   ${config.mcp.publicUrl ?? '(not set: tasks get the local URL)'}`,
    `model API base URL:  ${config.gateway.anthropicBaseUrl ?? '(default)'}`,
    `model connection id: ${config.conductor.connectionId ?? '(default)'}`,
    `sandbox machines:    ${Object.keys(config.sandboxes).length} (one per invite)`,
    `sandbox API URL:     ${config.instabox.apiUrl ?? '(default)'}`,
    `Codex runner key:    ${config.openAiKeySet ? 'set' : 'not set (Codex tasks will fail)'}`,
    `model gateway:       http://${config.gateway.host}:${config.gateway.port}`,
    `gateway for tasks:   ${config.gateway.publicUrl ?? '(not set: tasks get the local URL)'}`,
    `gateway models:      ${describeModels(config.gateway.models)}`,
    `web search key:      ${config.searchKeySet ? 'set' : 'not set (tasks get no web search)'}`,
    `Web Push:            ${config.pushSet ? 'on' : 'off (set the CLOUD_PUSH_* variables to turn it on)'}`,
    `GitHub token:        ${config.githubTokenProblem ?? 'set (fine-grained)'}`,
    `invites file:        ${config.invitesPath}`,
    `backups:             ${config.backupDir ?? '(not set: no backups are written)'}`,
    `spend alert:         ${config.spendAlert ? `$${config.spendAlert.usd}/day to ${config.spendAlert.ownerInvite}'s devices` : '(not set)'}`,
    `work checks:        ${describeVerifiers(config.inbox)}`,
    `digest summary:      ${config.inbox.summaryModel}`,
    `spend limits:        invite $${config.spend.inviteDailyUsd}/day and $${config.spend.inviteMonthlyUsd}/month unless set per invite, server $${config.spend.serverDailyUsd}/day`,
  ];
}

function describeModels(models: readonly ModelPrice[]): string {
  if (models.length === 0) return 'built-in Claude prices only (Codex tasks will be refused)';
  return `built-in Claude prices and ${models.length} configured`;
}

function describeVerifiers(inbox: InboxConfig): string {
  if (inbox.verifierModels.length === 0) {
    return `no model configured (only the checks that need none run), daily cap $${inbox.dailyCapUsd}`;
  }
  const vendors = [...new Set(inbox.verifierModels.map((entry) => entry.vendor))].join(', ');
  return `${inbox.verifierModels.length} model(s) from ${vendors}, daily cap $${inbox.dailyCapUsd}`;
}
