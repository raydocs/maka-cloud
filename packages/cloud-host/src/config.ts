import { isAbsolute, join, relative, resolve } from 'node:path';
import { type ModelPrice, modelTable, priceProblem } from '@maka-cloud/gateway';
import {
  DEFAULT_MODES,
  withoutDeep,
  type ModesConfig,
  modelsOf,
  parseModesConfig,
  unnamedModels,
} from '@maka-cloud/modes';
import { scrubKeyShapes } from '@maka-cloud/orchestrator';
import { githubTokenProblem } from '@maka-cloud/playbooks/coding';
import { assertAgentChannel } from '@maka-cloud/runners';
import { DEFAULT_TASKS_PER_INVITE, proxyList, pushConfigFromEnv } from '@maka-cloud/server';
import { type BackupLayout, withoutSecretShapesInJson } from './backup.js';
import { type InboxConfig, readInboxConfig } from './inbox/config.js';

/**
 * Everything the stack needs, read from the environment. Secret values are kept
 * only where they are used; `describeConfig` never prints them.
 */
/** A reverse proxy on the same host: where the runbook's systemd setup puts it. */
const DEFAULT_PROXIES = ['127.0.0.1', '::1'] as const;

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
  /** The standing duties' database: projects, duties, webhook deliveries and the run ledger. */
  dutiesDbPath: string;
  /** The conversations of Claude tasks, kept off the sandboxes. Made only with `agentChannel`. */
  transcriptsDbPath: string;
  /**
   * The account the CLIs run as inside a sandbox, and its group. Every CLI (Claude and Codex) runs
   * as it, never as the sandbox user; without it no CLI is started. With it Claude tasks are also
   * driven through the Agent SDK (step log, durable resume, stored conversation). See
   * `agent-user.ts` in the runners for what the box must have.
   */
  agentChannel?: { user: string; group: string };
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
  /**
   * Set with `MAKA_CLOUD_BOXES=1`: tasks run on a pool of boxes the server makes, sleeps and deletes
   * itself, up to `maxPerInvite` per invite, instead of the fixed machine per invite in `sandboxes`
   * (which is then empty).
   */
  boxes?: { templateId: string; maxPerInvite: number };
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
   * The modes (quick, standard, deep): which model and effort each role runs with, and the budget
   * of each. Every model it names has a price in the gateway, or the config is refused.
   */
  modes: ModesConfig;
  /**
   * Set with `MAKA_CLOUD_DEEP_MODE=1`. Off at launch: the conductor is not told about `deep`, a
   * pick of it runs as `standard` with a notice, and `modes` holds `standard`'s values under `deep`.
   */
  deepMode: boolean;
  /**
   * What model spend may reach, in USD per UTC day or month. An invite with no limit of its own
   * (`cloud-server invite limits`) gets the invite defaults. Small on purpose: a server nobody
   * configured cannot spend much.
   */
  spend: SpendCaps;
  /**
   * Limits of one task on top of its tree's budget: the most one run (a start, or a resume after a
   * restart) may spend, and how long the task may run in all.
   */
  taskLimits: { turnUsd?: number; runMs: number };
  /**
   * Task trees one invite may run at once; a further top-level task waits its turn. 1 until each
   * task gets an agent account of its own: the tasks of an invite share one machine and account.
   */
  tasksPerInvite: number;
  /** Task timelines show what each step did, not only its kind. */
  timelineContent: boolean;
  /** The codex runner needs it when a task starts; the stack starts without it. */
  openAiKeySet: boolean;
  /** With it, research runs get a `web-search` command, paid per call from their budget. */
  searchKeySet: boolean;
  /** All three VAPID settings are set: the Web Push routes are on. The key itself is read from the environment by the stack. */
  pushSet: boolean;
  /**
   * Native push for the phone app is on (`MAKA_CLOUD_EXPO_PUSH=1`): the server tells phones through
   * the Expo push service. Off at launch. The optional Expo access token is read from the
   * environment by the stack, never kept here.
   */
  nativePushSet: boolean;
  /**
   * Standing duties are on: the GitHub webhook secret is set, so signed deliveries are accepted at
   * `/github/webhook`. The secret itself is read from the environment by the stack.
   */
  dutiesSet: boolean;
  /**
   * Proposed cards are on (T30): each project's daily read-only scan and the one-tap cards it makes.
   * Needs standing duties and the GitHub token.
   */
  cardsSet: boolean;
  /**
   * The repositories a project may be registered for, each tied by the operator to the GitHub
   * App installation it lives in and to the one invite that owns it. Empty: none, whatever the
   * invites ask.
   */
  dutyLinks: DutyLink[];
  /** Why no pull request can be opened with `MAKA_GITHUB_TOKEN`, if it cannot. */
  githubTokenProblem?: string;
  /**
   * Signing in with Apple, Google or an emailed code (T31). A way with no settings is off; with none
   * on, invite tokens are the only way in. The mail key is read from the environment by the stack.
   */
  signIn: {
    appleClientIds: string[];
    googleClientIds: string[];
    mail?: { apiUrl: string; from: string };
    /**
     * The addresses (IPs or CIDR ranges) of the reverse proxy in front: only a request from one of
     * them is counted by the client it forwards in the sign-in limits. Empty: none is trusted.
     */
    trustedProxies: string[];
  };
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
  | 'dutiesDbPath'
  | 'transcriptsDbPath'
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
    dutiesDbPath: join(dataDir, 'duties.db'),
    transcriptsDbPath: join(dataDir, 'transcripts.db'),
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
      rel(paths.dutiesDbPath),
      rel(paths.transcriptsDbPath),
    ],
    files: [rel(paths.runnerSessionsPath), rel(paths.codingDeliveriesPath)],
    trees: [rel(paths.conductorRoot), rel(paths.handoffRoot)],
    redact: {
      // A device's push secret lets whoever holds it read what the server sends that device, so
      // a backup keeps no subscriptions: devices turn notifications on again after a restore.
      [cloud]: (copy) => {
        try {
          copy.exec('DELETE FROM push_subscriptions');
          // A phone's push token lets whoever holds it send that phone notifications.
          copy.exec('DELETE FROM native_push_tokens');
        } catch (error) {
          if (!/no such table/iu.test(String((error as Error).message))) throw error;
        }
      },
      // The lines are kept exactly as the CLI wrote them (the model checks them on a resume), so a
      // key a task saw (a pasted one, a file in a repository, a run's own) is still in the live
      // file. A backup holds no keys: every line of the copy loses its key shapes, and only those
      // (no field is blanked for its name, so the signature of a thinking block stays). A
      // conversation restored from a backup loses only the lines that held a key.
      [rel(paths.transcriptsDbPath)]: (copy) => {
        const page = copy.prepare(
          `SELECT task_id, session_id, subpath, n, json FROM transcript_lines
           ORDER BY task_id, session_id, subpath, n LIMIT ? OFFSET ?`,
        );
        const update = copy.prepare(
          'UPDATE transcript_lines SET json = ? WHERE task_id = ? AND session_id = ? AND subpath = ? AND n = ?',
        );
        const size = 500;
        for (let offset = 0; ; offset += size) {
          const rows = page.all(size, offset) as Array<{
            task_id: string;
            session_id: string;
            subpath: string;
            n: number;
            json: string;
          }>;
          for (const row of rows) {
            const clean = scrubKeyShapes(withoutSecretShapesInJson(row.json));
            if (clean !== row.json) {
              update.run(clean, row.task_id, row.session_id, row.subpath, row.n);
            }
          }
          if (rows.length < size) break;
        }
      },
    },
  };
}

/** Where the kill switch lives under a data directory. */
export function pausePathOf(dataDir: string): string {
  return join(dataDir, 'paused');
}

/** Reads the per-task limits; a bad value is a problem, not a default. */
function taskLimits(
  value: (name: string) => string | undefined,
  problems: string[],
): StackConfig['taskLimits'] {
  const limits: StackConfig['taskLimits'] = { runMs: DEFAULT_TASK_RUN_HOURS * 3_600_000 };
  const turn = value('MAKA_CLOUD_TASK_TURN_USD');
  if (turn !== undefined) {
    const usd = Number(turn);
    if (!/^\d+(\.\d+)?$/u.test(turn) || !(usd > 0) || usd > 100_000) {
      problems.push('MAKA_CLOUD_TASK_TURN_USD must be a number of dollars above 0, up to 100000');
    } else {
      limits.turnUsd = usd;
    }
  }
  const hours = value('MAKA_CLOUD_TASK_RUN_HOURS');
  if (hours !== undefined) {
    const parsed = Number(hours);
    if (!/^\d+(\.\d+)?$/u.test(hours) || !(parsed > 0) || parsed > 168) {
      problems.push('MAKA_CLOUD_TASK_RUN_HOURS must be a number of hours above 0, up to 168');
    } else {
      limits.runMs = Math.round(parsed * 3_600_000);
    }
  }
  return limits;
}

/** How long a task may run in all, unless set. */
const DEFAULT_TASK_RUN_HOURS = 4;

/** The most `MAKA_CLOUD_TASKS_PER_INVITE` takes, the same as a conversation's unfinished tasks. */
const MAX_TASKS_PER_INVITE = 32;

/** Reads how many task trees one invite may run at once; a bad value is a problem, not a default. */
function tasksPerInvite(value: (name: string) => string | undefined, problems: string[]): number {
  const raw = value('MAKA_CLOUD_TASKS_PER_INVITE');
  if (raw === undefined) return DEFAULT_TASKS_PER_INVITE;
  const parsed = Number(raw);
  if (!/^\d+$/u.test(raw) || parsed < 1 || parsed > MAX_TASKS_PER_INVITE) {
    problems.push(
      `MAKA_CLOUD_TASKS_PER_INVITE must be a whole number from 1 to ${MAX_TASKS_PER_INVITE}`,
    );
    return DEFAULT_TASKS_PER_INVITE;
  }
  return parsed;
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

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MAIL_ADDRESS = '[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+';
/** `a@b.c`, `<a@b.c>` or `Name <a@b.c>`: the brackets come as a pair. */
const MAIL_FROM = new RegExp(
  `^(?:${MAIL_ADDRESS}|(?:[A-Za-z0-9 ._'-]{1,60} )?<${MAIL_ADDRESS}>)$`,
  'u',
);

function clientIds(raw: string | undefined, name: string, problems: string[]): string[] {
  if (raw === undefined) return [];
  const ids = raw.split(',').map((id) => id.trim());
  if (ids.some((id) => !CLIENT_ID.test(id))) {
    problems.push(`${name} must be client ids separated by commas`);
    return [];
  }
  return ids;
}

function readSignIn(
  value: (name: string) => string | undefined,
  problems: string[],
): StackConfig['signIn'] {
  const signIn: StackConfig['signIn'] = {
    appleClientIds: clientIds(
      value('MAKA_CLOUD_APPLE_CLIENT_IDS'),
      'MAKA_CLOUD_APPLE_CLIENT_IDS',
      problems,
    ),
    googleClientIds: clientIds(
      value('MAKA_CLOUD_GOOGLE_CLIENT_IDS'),
      'MAKA_CLOUD_GOOGLE_CLIENT_IDS',
      problems,
    ),
    trustedProxies: [...DEFAULT_PROXIES],
  };
  const proxy = value('MAKA_CLOUD_TRUST_PROXY');
  if (proxy === '0') signIn.trustedProxies = [];
  else if (proxy !== undefined) {
    const entries = proxy.split(',').map((entry) => entry.trim());
    try {
      proxyList(entries);
      signIn.trustedProxies = entries;
    } catch {
      problems.push(
        'MAKA_CLOUD_TRUST_PROXY must be 0 or IP addresses or ranges separated by commas (for example 127.0.0.1,::1)',
      );
    }
  }
  const apiUrl = value('MAKA_CLOUD_MAIL_API_URL');
  const key = value('MAKA_CLOUD_MAIL_API_KEY');
  const from = value('MAKA_CLOUD_MAIL_FROM');
  if (apiUrl === undefined && key === undefined && from === undefined) return signIn;
  if (apiUrl === undefined || key === undefined || from === undefined) {
    problems.push(
      'MAKA_CLOUD_MAIL_API_URL, MAKA_CLOUD_MAIL_API_KEY and MAKA_CLOUD_MAIL_FROM go together',
    );
    return signIn;
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(apiUrl);
  } catch {
    problems.push('MAKA_CLOUD_MAIL_API_URL is not a URL');
  }
  if (parsed !== undefined) {
    if (parsed.protocol !== 'https:') problems.push('MAKA_CLOUD_MAIL_API_URL must be an https URL');
    else if (parsed.username !== '' || parsed.password !== '') {
      problems.push('MAKA_CLOUD_MAIL_API_URL must not carry credentials');
    } else if (!MAIL_FROM.test(from)) {
      problems.push('MAKA_CLOUD_MAIL_FROM must be an address or Name <address>');
    } else signIn.mail = { apiUrl, from };
  }
  return signIn;
}

/** The shortest webhook secret accepted: the duties engine refuses a shorter one. */
const MIN_WEBHOOK_SECRET_LENGTH = 16;

/**
 * The shortest key accepted for a service. The scrubber that keeps keys out of logs, errors and
 * events replaces a known value only from this length up (a shorter one would eat ordinary
 * words), so a shorter key would print in the clear: it is refused at start instead. No real key
 * is this short.
 */
const MIN_KEY_LENGTH = 8;
const KEY_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'INSTABOX_API_KEY',
  'CLOUD_PUSH_VAPID_PRIVATE',
  'MAKA_CLOUD_EXPO_ACCESS_TOKEN',
  'MAKA_GITHUB_TOKEN',
  'MAKA_CLOUD_MAIL_API_KEY',
] as const;

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
    'MAKA_CLOUD_TASK_TURN_USD',
    'the most one run of a task (a start, or a resume after a restart) may spend in model calls, on top of the task’s own budget; above 0. Unset: no turn limit',
  ],
  [
    'MAKA_CLOUD_TASK_RUN_HOURS',
    'how long a task may run in all, over every attempt and restart, before it is stopped with a note (default 4, at most 168)',
  ],
  [
    'MAKA_CLOUD_TASKS_PER_INVITE',
    'how many tasks one invite may run at once; a further one waits its turn and says so (default 1, at most 32). Keep 1 until each task runs as an account of its own: the tasks of an invite share one machine and agent account',
  ],
  [
    'MAKA_CLOUD_TIMELINE_CONTENT',
    'set to 1 to let a task’s timeline show what each step did (its command or file); by default it shows only the kind of step, its state and its timing',
  ],
  [
    'MAKA_CLOUD_AGENT_USER',
    'the account every CLI (Claude, Codex) runs as inside a sandbox (not the sandbox user, no sudo); with MAKA_CLOUD_AGENT_GROUP it also turns on Agent SDK runs, the step log and the stored conversation. Unset: no CLI is started',
  ],
  [
    'MAKA_CLOUD_AGENT_GROUP',
    'the group the sandbox user and that account share; goes with MAKA_CLOUD_AGENT_USER',
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
    'required unless MAKA_CLOUD_BOXES=1: JSON object {"<inviteId>": "<sandbox machine>"}, one machine per invite; an invite with no machine runs no tasks',
  ],
  [
    'MAKA_CLOUD_BOXES',
    '1: the server makes, sleeps and deletes the sandboxes itself, a pool per invite, instead of a fixed machine per invite (do not set MAKA_CLOUD_SANDBOXES); needs MAKA_CLOUD_BOX_TEMPLATE',
  ],
  [
    'MAKA_CLOUD_BOX_TEMPLATE',
    'the sandbox template id new boxes start from; required with MAKA_CLOUD_BOXES=1',
  ],
  [
    'MAKA_CLOUD_BOX_MAX',
    'the most boxes one invite may have (1 to 32, default 3); when instabox refuses a create the task waits for a free box of its invite',
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
    'JSON array of model prices for the gateway: {vendor, model, inputPerMTokUsd, outputPerMTokUsd, cacheReadPerMTokUsd?, maxOutputTokens, longContext?}; adds prices and replaces a built-in one by vendor and model (built in: the Claude models and gpt-6.1-sol, the built-in modes’ Codex model); any other Codex model needs one',
  ],
  [
    'MAKA_CLOUD_MODES',
    'JSON: the modes (quick, standard, deep) as "maka-cloud modes" prints them: per mode the conductor, implementer, reviewer and helper models and effort, and the budgets; every model named needs a gateway price. Unset: the built-in modes',
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
    'MAKA_CLOUD_EXPO_PUSH',
    '1 turns on native push for the phone app through the Expo push service (APNs and FCM credentials live in the EAS project, not here): a phone is told, with fixed words and ids only, when a decision waits or a result is ready. Unset or 0: off',
  ],
  [
    'MAKA_CLOUD_EXPO_ACCESS_TOKEN',
    'the Expo access token, when the Expo project requires one for push; kept in memory only. Needs MAKA_CLOUD_EXPO_PUSH=1',
  ],
  [
    'MAKA_GITHUB_TOKEN',
    'fine-grained GitHub token for opening pull requests, read when one is opened',
  ],
  [
    'MAKA_GITHUB_WEBHOOK_SECRET',
    'the GitHub App’s webhook secret (16 characters or more), kept in memory only. Set: signed deliveries are accepted at /github/webhook and standing duties run. Unset: no standing duties',
  ],
  [
    'MAKA_CLOUD_DEEP_MODE',
    '1 turns on deep mode. Off at launch: deep research has a provenance gap that is parked until after launch, so a request for deep runs in standard mode with a notice and the conductor is not told about deep. Unset or 0: off',
  ],
  [
    'MAKA_CLOUD_CARDS',
    '1 turns on proposed cards: each project is scanned read-only once a day (and after the employee’s own task on it finishes) and offers up to 3 one-tap cards. Needs MAKA_GITHUB_WEBHOOK_SECRET and MAKA_GITHUB_TOKEN. Unset or 0: off',
  ],
  [
    'MAKA_CLOUD_APPLE_CLIENT_IDS',
    'comma separated Sign in with Apple client ids (the app’s bundle id, the web Services id) a token may be made for. Unset: no Sign in with Apple',
  ],
  [
    'MAKA_CLOUD_GOOGLE_CLIENT_IDS',
    'comma separated Google OAuth client ids (iOS, Android, web) a token may be made for. Unset: no Sign in with Google',
  ],
  [
    'MAKA_CLOUD_MAIL_API_URL',
    'https URL of the mail service that sends sign-in codes: it takes a POST of {from, to, subject, text} with a bearer key. With the next two, turns on sign-in by emailed code. All three or none',
  ],
  ['MAKA_CLOUD_MAIL_API_KEY', 'the mail service’s bearer key, kept in memory only'],
  [
    'MAKA_CLOUD_MAIL_FROM',
    'the sender of sign-in mail, an address or Name <address> your mail service allows',
  ],
  [
    'MAKA_CLOUD_TRUST_PROXY',
    'comma separated IP addresses or ranges of the reverse proxy in front of the server. Only a request from one of them has its X-Forwarded-For client counted in the sign-in limits; from any other peer the header is ignored. Default 127.0.0.1,::1 (a proxy on the same host); under Compose the proxy’s fixed address. 0: trust none',
  ],
  [
    'MAKA_CLOUD_DUTY_REPOS',
    'comma separated owner/name@<installation id>=<invite id> links a project may be registered through: the repository, the GitHub App installation it lives in and the one invite that owns it; needs MAKA_GITHUB_WEBHOOK_SECRET. Unset: no project can be registered',
  ],
] as const;

/** The spend caps an environment sets itself; one it leaves out is not listed (its default is not a choice). */
export function explicitSpendCaps(env: NodeJS.ProcessEnv): Partial<SpendCaps> {
  const caps: Partial<SpendCaps> = {};
  const names = [
    ['inviteDailyUsd', 'MAKA_CLOUD_INVITE_DAILY_USD'],
    ['inviteMonthlyUsd', 'MAKA_CLOUD_INVITE_MONTHLY_USD'],
    ['serverDailyUsd', 'MAKA_CLOUD_SERVER_DAILY_USD'],
  ] as const;
  for (const [field, name] of names) {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') continue;
    const usd = Number(raw);
    if (Number.isFinite(usd) && usd >= 0) caps[field] = usd;
  }
  return caps;
}

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
  const flag = (name: string): boolean => {
    const raw = value(name);
    if (raw === undefined || raw === '0') return false;
    if (raw === '1') return true;
    problems.push(`${name} must be 1 or 0`);
    return false;
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
    modes: DEFAULT_MODES,
    deepMode: false,
    spend: {
      inviteDailyUsd: dollars('MAKA_CLOUD_INVITE_DAILY_USD', DEFAULT_SPEND_CAPS.inviteDailyUsd),
      inviteMonthlyUsd: dollars(
        'MAKA_CLOUD_INVITE_MONTHLY_USD',
        DEFAULT_SPEND_CAPS.inviteMonthlyUsd,
      ),
      serverDailyUsd: dollars('MAKA_CLOUD_SERVER_DAILY_USD', DEFAULT_SPEND_CAPS.serverDailyUsd),
    },
    taskLimits: taskLimits(value, problems),
    tasksPerInvite: tasksPerInvite(value, problems),
    timelineContent: flag('MAKA_CLOUD_TIMELINE_CONTENT'),
    openAiKeySet: value('OPENAI_API_KEY') !== undefined,
    searchKeySet: value('DEEPSEEK_API_KEY') !== undefined,
    pushSet: false,
    nativePushSet: flag('MAKA_CLOUD_EXPO_PUSH'),
    dutiesSet: false,
    cardsSet: false,
    dutyLinks: [],
    signIn: { appleClientIds: [], googleClientIds: [], trustedProxies: [...DEFAULT_PROXIES] },
  };
  const modes = readModes(value('MAKA_CLOUD_MODES'), config.gateway.models, problems);
  if (modes !== undefined) config.modes = modes;
  config.deepMode = flag('MAKA_CLOUD_DEEP_MODE');
  // Off, `deep` is `standard` for every consumer that reads the modes (see `StackConfig.deepMode`).
  if (!config.deepMode) config.modes = withoutDeep(config.modes);
  try {
    config.pushSet = pushConfigFromEnv(env) !== undefined;
  } catch (error) {
    // The message names the missing variables and never a value.
    problems.push(error instanceof Error ? error.message : 'the Web Push settings are not valid');
  }
  if (value('MAKA_CLOUD_EXPO_ACCESS_TOKEN') !== undefined && !config.nativePushSet) {
    problems.push('MAKA_CLOUD_EXPO_ACCESS_TOKEN needs MAKA_CLOUD_EXPO_PUSH=1');
  }
  for (const name of KEY_VARIABLES) {
    const key = value(name);
    // The message never carries the value.
    if (key !== undefined && key.length < MIN_KEY_LENGTH) {
      problems.push(`${name} is too short to be a key (at least ${MIN_KEY_LENGTH} characters)`);
    }
  }
  const webhookSecret = value('MAKA_GITHUB_WEBHOOK_SECRET');
  if (webhookSecret !== undefined) {
    // The message never carries the value.
    if (webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
      problems.push(
        `MAKA_GITHUB_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
      );
    } else {
      config.dutiesSet = true;
    }
  }
  const dutyLinks = value('MAKA_CLOUD_DUTY_REPOS');
  if (dutyLinks !== undefined) {
    const links = parseDutyLinks(dutyLinks);
    if (typeof links === 'string') {
      problems.push(`MAKA_CLOUD_DUTY_REPOS ${links}`);
    } else if (webhookSecret === undefined) {
      problems.push('MAKA_CLOUD_DUTY_REPOS needs MAKA_GITHUB_WEBHOOK_SECRET');
    } else {
      config.dutyLinks = links;
    }
  }
  config.signIn = readSignIn(value, problems);
  const github = githubTokenProblem(env.MAKA_GITHUB_TOKEN);
  if (github !== undefined) config.githubTokenProblem = github;
  if (flag('MAKA_CLOUD_CARDS')) {
    if (!config.dutiesSet) problems.push('MAKA_CLOUD_CARDS needs MAKA_GITHUB_WEBHOOK_SECRET');
    else if (value('MAKA_GITHUB_TOKEN') === undefined) {
      problems.push('MAKA_CLOUD_CARDS needs MAKA_GITHUB_TOKEN, which the scan reads with');
    } else config.cardsSet = true;
  }
  const backupDir = value('MAKA_CLOUD_BACKUP_DIR');
  if (backupDir !== undefined) {
    const problem = backupDirProblem(dataDir, backupDir);
    if (problem === undefined) config.backupDir = backupDir;
    else problems.push(problem);
  }
  const agentUser = value('MAKA_CLOUD_AGENT_USER');
  const agentGroup = value('MAKA_CLOUD_AGENT_GROUP');
  if (agentUser !== undefined || agentGroup !== undefined) {
    if (agentUser === undefined || agentGroup === undefined) {
      problems.push('MAKA_CLOUD_AGENT_USER and MAKA_CLOUD_AGENT_GROUP go together');
    } else {
      try {
        config.agentChannel = assertAgentChannel({ user: agentUser, group: agentGroup });
      } catch (error) {
        problems.push(
          `MAKA_CLOUD_AGENT_USER / MAKA_CLOUD_AGENT_GROUP: ${(error as Error).message}`,
        );
      }
    }
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
    const boxes = readBoxes(value, problems);
    if (boxes !== undefined) config.boxes = boxes;
    // With the pool asked for, a problem with it is the only thing to report about where tasks run.
    if (value('MAKA_CLOUD_BOXES') === undefined) {
      config.sandboxes = sandboxTable(value('MAKA_CLOUD_SANDBOXES'), problems);
    }
  }
  if (options.sandboxes === 'single-machine' && value('MAKA_CLOUD_BOXES') !== undefined) {
    problems.push('MAKA_CLOUD_BOXES is not used with a single machine');
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

/** One repository of a standing duty, the installation it lives in and the invite that owns it. */
export interface DutyLink {
  /** `owner/name`, lower case. */
  repo: string;
  installationId: number;
  inviteId: string;
}

const DUTY_LINK =
  /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})@([1-9][0-9]{0,15})=(inv_[0-9a-f]{12})$/u;

/**
 * `owner/name@<installation id>=<invite id>`, comma separated. A repository belongs to one invite
 * and one installation: the operator is the one who knows who owns what, so a repository named
 * twice is a mistake, not a choice. The problem as text, or the links.
 */
function parseDutyLinks(text: string): DutyLink[] | string {
  const links: DutyLink[] = [];
  for (const entry of text.split(',').map((part) => part.trim())) {
    const match = DUTY_LINK.exec(entry);
    if (!match) {
      return 'must be comma separated owner/name@<installation id>=<invite id> links';
    }
    const repo = (match[1] as string).toLowerCase();
    if (links.some((link) => link.repo === repo)) return `names ${repo} more than once`;
    links.push({ repo, installationId: Number(match[2]), inviteId: match[3] as string });
  }
  return links;
}
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/**
 * The most boxes an invite may ask for: the pool's own bound (slot numbers are labels). The instabox
 * account limit is not assumed; a refused create makes the task wait for a box of its invite.
 */
const MAX_BOXES_PER_INVITE = 32;
const DEFAULT_BOXES_PER_INVITE = 3;

/**
 * `MAKA_CLOUD_BOXES=1` with its template, or nothing. Mixing it with `MAKA_CLOUD_SANDBOXES` is an
 * error: it would be unclear which machine a task runs on. Settings of the pool without the switch
 * are an error too, so a forgotten switch is not silently ignored.
 */
function readBoxes(
  value: (name: string) => string | undefined,
  problems: string[],
): StackConfig['boxes'] {
  const switchValue = value('MAKA_CLOUD_BOXES');
  const template = value('MAKA_CLOUD_BOX_TEMPLATE');
  const max = value('MAKA_CLOUD_BOX_MAX');
  if (switchValue === undefined) {
    if (template !== undefined || max !== undefined) {
      problems.push('MAKA_CLOUD_BOX_TEMPLATE and MAKA_CLOUD_BOX_MAX need MAKA_CLOUD_BOXES=1');
    }
    return undefined;
  }
  if (switchValue !== '1') {
    problems.push('MAKA_CLOUD_BOXES must be 1, or unset');
    return undefined;
  }
  let ok = true;
  if (value('MAKA_CLOUD_SANDBOXES') !== undefined) {
    problems.push('MAKA_CLOUD_BOXES=1 and MAKA_CLOUD_SANDBOXES are both set: use one of them');
    ok = false;
  }
  if (template === undefined) {
    problems.push('MAKA_CLOUD_BOX_TEMPLATE is not set');
    ok = false;
  } else if (!MACHINE_ID.test(template)) {
    problems.push('MAKA_CLOUD_BOX_TEMPLATE is not a template id');
    ok = false;
  }
  let maxPerInvite = DEFAULT_BOXES_PER_INVITE;
  if (max !== undefined) {
    const parsed = Number(max);
    if (!/^\d+$/u.test(max) || parsed < 1 || parsed > MAX_BOXES_PER_INVITE) {
      problems.push(`MAKA_CLOUD_BOX_MAX must be a whole number from 1 to ${MAX_BOXES_PER_INVITE}`);
      ok = false;
    } else {
      maxPerInvite = parsed;
    }
  }
  return ok && template !== undefined ? { templateId: template, maxPerInvite } : undefined;
}

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

/**
 * The modes the environment sets, or undefined for the built-in ones. A config that does not
 * parse, or that names a model the gateway has no price for, is a problem: a run on such a model
 * would be refused at the gateway, so it is refused here, at start.
 */
export function readModes(
  raw: string | undefined,
  prices: readonly ModelPrice[],
  problems: string[],
): ModesConfig | undefined {
  const parsed = raw === undefined ? undefined : parseModesConfig(raw);
  if (parsed && !parsed.ok) {
    for (const problem of parsed.problems) problems.push(`MAKA_CLOUD_MODES ${problem}`);
    return undefined;
  }
  const config = parsed?.config ?? DEFAULT_MODES;
  const table = modelTable(prices);
  for (const { vendor, model } of modelsOf(config)) {
    if (!table.has(`${vendor}:${model}`)) {
      problems.push(
        `${raw === undefined ? 'the built-in modes name' : 'MAKA_CLOUD_MODES names'} the ${vendor} model "${model}", which the gateway has no price for: add it to MAKA_CLOUD_GATEWAY_MODELS`,
      );
    }
  }
  return parsed?.config;
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
    config.boxes === undefined
      ? `sandbox machines:    ${Object.keys(config.sandboxes).length} (one per invite)`
      : `sandbox boxes:       up to ${config.boxes.maxPerInvite} per invite, from template ${config.boxes.templateId}`,
    `sandbox API URL:     ${config.instabox.apiUrl ?? '(default)'}`,
    `Codex runner key:    ${config.openAiKeySet ? 'set' : 'not set (Codex tasks will fail)'}`,
    `model gateway:       http://${config.gateway.host}:${config.gateway.port}`,
    `gateway for tasks:   ${config.gateway.publicUrl ?? '(not set: tasks get the local URL)'}`,
    `gateway models:      ${describeModels(config.gateway.models)}`,
    `modes:               ${describeModes(config.modes)}`,
    `web search key:      ${config.searchKeySet ? 'set' : 'not set (tasks get no web search)'}`,
    `Web Push:            ${config.pushSet ? 'on' : 'off (set the CLOUD_PUSH_* variables to turn it on)'}`,
    `phone push:          ${config.nativePushSet ? 'on, through the Expo push service' : 'off (set MAKA_CLOUD_EXPO_PUSH=1 to turn it on)'}`,
    `GitHub token:        ${config.githubTokenProblem ?? 'set (fine-grained)'}`,
    `standing duties:     ${config.dutiesSet ? `on, projects may be registered for ${config.dutyLinks.length === 0 ? 'no repository yet' : config.dutyLinks.map((link) => link.repo).join(', ')}` : 'off (set MAKA_GITHUB_WEBHOOK_SECRET to turn them on)'}`,
    `sign-in:             ${describeSignIn(config.signIn)}`,
    `deep mode:           ${config.deepMode ? 'on' : 'off (set MAKA_CLOUD_DEEP_MODE=1 to turn it on)'}`,
    `proposed cards:      ${config.cardsSet ? 'on, each project is scanned read-only once a day' : 'off (set MAKA_CLOUD_CARDS=1 to turn them on)'}`,
    `CLIs run as:         ${config.agentChannel ? `${config.agentChannel.user} (group ${config.agentChannel.group}); Claude through the Agent SDK, conversation kept in ${config.transcriptsDbPath}` : 'nothing: no CLI starts until MAKA_CLOUD_AGENT_USER and MAKA_CLOUD_AGENT_GROUP are set'}`,
    `task limits:         ${config.taskLimits.turnUsd === undefined ? 'no limit per turn' : `$${config.taskLimits.turnUsd} per turn`}, ${config.taskLimits.runMs / 3_600_000} h of run time`,
    `tasks at once:       ${config.tasksPerInvite} per invite; the next one waits its turn`,
    `invites file:        ${config.invitesPath}`,
    `backups:             ${config.backupDir ?? '(not set: no backups are written)'}`,
    `spend alert:         ${config.spendAlert ? `$${config.spendAlert.usd}/day to ${config.spendAlert.ownerInvite}'s devices` : '(not set)'}`,
    `work checks:        ${describeVerifiers(config.inbox)}`,
    `digest summary:      ${config.inbox.summaryModel}`,
    `spend limits:        invite $${config.spend.inviteDailyUsd}/day and $${config.spend.inviteMonthlyUsd}/month unless set per invite, server $${config.spend.serverDailyUsd}/day`,
  ];
}

function describeSignIn(signIn: StackConfig['signIn']): string {
  const ways = [
    ...(signIn.appleClientIds.length > 0 ? ['Apple'] : []),
    ...(signIn.googleClientIds.length > 0 ? ['Google'] : []),
    ...(signIn.mail ? ['emailed code'] : []),
  ];
  if (ways.length === 0)
    return 'invite token only (set the Apple, Google or mail variables to add more)';
  const proxies =
    signIn.trustedProxies.length > 0
      ? `; client address trusted from ${signIn.trustedProxies.join(', ')}`
      : '; limits count the socket address (no proxy trusted)';
  return `${ways.join(', ')} and invite token${proxies}`;
}

function describeModes(modes: ModesConfig): string {
  const open = unnamedModels(modes).length;
  const standard = modes.modes.standard.budget;
  return `quick, standard, deep (config version ${modes.version}, standard budget $${standard.defaultRunUsd}); ${open === 0 ? 'every role names its model' : `${open} Codex role(s) use the CLI's default model, which the gateway cannot price: name them with MAKA_CLOUD_MODES (see "maka-cloud modes")`}`;
}

function describeModels(models: readonly ModelPrice[]): string {
  const builtIn = 'built-in Claude and gpt-6.1-sol prices';
  if (models.length === 0) return `${builtIn} only`;
  return `${builtIn} and ${models.length} configured`;
}

function describeVerifiers(inbox: InboxConfig): string {
  if (inbox.verifierModels.length === 0) {
    return `no model configured (only the checks that need none run), daily cap $${inbox.dailyCapUsd}`;
  }
  const vendors = [...new Set(inbox.verifierModels.map((entry) => entry.vendor))].join(', ');
  return `${inbox.verifierModels.length} model(s) from ${vendors}, daily cap $${inbox.dailyCapUsd}`;
}
