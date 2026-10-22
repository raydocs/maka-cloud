import { generateKeyPairSync } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { InstaboxClient } from '@maka-cloud/instabox';
import { githubTokenProblem } from '@maka-cloud/playbooks/coding';
import { InviteStore } from '@maka-cloud/server';
import { ConfigError, DEFAULT_SPEND_CAPS, describeConfig, readStackConfig } from './config.js';

/**
 * `maka-cloud setup`: the first-run wizard. It asks only for what it cannot choose (the domain, the
 * model and sandbox keys, the owner's sandbox machine, and optionally a GitHub token and a contact
 * address), fills everything else with safe defaults, makes the owner's invite and writes two
 * files: the server's settings and the names Compose substitutes into the proxy. Run again, it
 * edits those files: every value not changed is kept, and a variable it does not know is kept as
 * it was.
 */

/** Settings only `setup --from-env` reads; the server never reads them. */
export const SETUP_VARIABLES = [
  [
    'MAKA_CLOUD_SETUP_DOMAIN',
    'your domain: the app is app.<domain>, the MCP endpoint mcp.<domain> and the model gateway models.<domain>',
  ],
  ['MAKA_CLOUD_SETUP_MACHINE', 'the instabox machine id of the owner’s sandbox'],
  [
    'MAKA_CLOUD_SETUP_EMAIL',
    'optional: a contact address for the Web Push services (default: the app’s URL)',
  ],
  ['ANTHROPIC_API_KEY', 'required, as for the server'],
  [
    'OPENAI_API_KEY',
    'recommended, as for the server: without it no change is reviewed by a second vendor',
  ],
  ['INSTABOX_API_KEY', 'required, as for the server'],
  ['MAKA_GITHUB_TOKEN', 'optional, as for the server'],
] as const;

/** The account and group the CLIs run as inside a sandbox; the box image must have both. */
export const DEFAULT_AGENT_USER = 'maka-agent';
export const DEFAULT_AGENT_GROUP = 'maka-box';

/** A push to the owner once a UTC day's spend reaches this: the owner's own daily cap by default. */
export const DEFAULT_SPEND_ALERT_USD = DEFAULT_SPEND_CAPS.inviteDailyUsd;

/** The models that check finished work, at the gateway's built-in prices. */
const VERIFIERS = {
  anthropic: {
    vendor: 'anthropic',
    model: 'claude-sonnet-5-5',
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 10,
  },
  openai: { vendor: 'openai', model: 'gpt-6.1-sol', inputPerMTokUsd: 2, outputPerMTokUsd: 10 },
} as const;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** A public domain, or `localhost` for a trial on this machine (the rehearsal's names). */
function isDomain(name: string): boolean {
  return name === 'localhost' || DOMAIN.test(name);
}
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EMAIL = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/u;
const NAME = /^[A-Z][A-Z0-9_]*$/u;

/** What the wizard asks for. Keys are kept only in memory and in the settings file. */
export interface SetupAnswers {
  domain: string;
  anthropicKey: string;
  openAiKey?: string;
  instaboxKey: string;
  machine: string;
  githubToken?: string;
  email?: string;
}

/** An ordered `NAME=value` file; values are read and written as systemd, Compose and sh all read them. */
export type EnvEntries = Map<string, string>;

export function parseEnvFile(text: string): EnvEntries {
  const entries: EnvEntries = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (NAME.test(name)) entries.set(name, value);
  }
  return entries;
}

/** Why a value cannot go in the file as one line, if it cannot. */
function valueProblem(name: string, value: string): string | undefined {
  if (/[\n\r\0]/u.test(value)) return `${name} must be one line`;
  if (value.includes("'")) return `${name} must not hold a single quote`;
  return undefined;
}

export function renderEnvFile(entries: EnvEntries, header: string[]): string {
  const lines = header.map((line) => `# ${line}`);
  for (const [name, value] of entries) {
    const problem = valueProblem(name, value);
    if (problem !== undefined) throw new ConfigError([problem]);
    // Single quotes: read the same way by systemd, Compose and the shell, and needed for JSON.
    lines.push(/^[A-Za-z0-9_./:@+-]*$/u.test(value) ? `${name}=${value}` : `${name}='${value}'`);
  }
  return `${lines.join('\n')}\n`;
}

/** A P-256 key pair for VAPID, as the Web Push settings take it (base64url, raw). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x as string, 'base64url'),
    Buffer.from(pub.y as string, 'base64url'),
  ]);
  return { publicKey: raw.toString('base64url'), privateKey: priv.d as string };
}

/** What is wrong with the answers, each problem naming a setting and never a value. */
export function answerProblems(answers: SetupAnswers): string[] {
  const problems: string[] = [];
  if (!isDomain(answers.domain)) problems.push('the domain must be a name such as example.com');
  if (!MACHINE_ID.test(answers.machine)) problems.push('the sandbox machine is not a machine id');
  if (answers.email !== undefined && !EMAIL.test(answers.email)) {
    problems.push('the contact address is not an email address');
  }
  if (answers.githubToken !== undefined) {
    const problem = githubTokenProblem(answers.githubToken);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

export interface PlannedSetup {
  /** The server's settings. */
  server: EnvEntries;
  /** The names Compose substitutes into the proxy. */
  compose: EnvEntries;
}

/**
 * The two files, from the answers and what the files held before. A value the wizard does not own
 * is kept; one it owns is replaced; the VAPID pair is kept once made, so devices stay subscribed.
 */
export function planSetup(input: {
  answers: SetupAnswers;
  ownerInvite: string;
  existing?: { server?: EnvEntries; compose?: EnvEntries };
  vapid: () => { publicKey: string; privateKey: string };
}): PlannedSetup {
  const { answers, ownerInvite } = input;
  const server: EnvEntries = new Map(input.existing?.server ?? []);
  const compose: EnvEntries = new Map(input.existing?.compose ?? []);
  const app = `app.${answers.domain}`;
  const mcp = `mcp.${answers.domain}`;
  const models = `models.${answers.domain}`;
  const set = (entries: EnvEntries, name: string, value: string | undefined): void => {
    if (value === undefined) entries.delete(name);
    else entries.set(name, value);
  };

  set(server, 'ANTHROPIC_API_KEY', answers.anthropicKey);
  set(server, 'OPENAI_API_KEY', answers.openAiKey);
  set(server, 'INSTABOX_API_KEY', answers.instaboxKey);
  set(server, 'MAKA_GITHUB_TOKEN', answers.githubToken);

  let sandboxes: Record<string, string> = {};
  try {
    const before = JSON.parse(server.get('MAKA_CLOUD_SANDBOXES') ?? '{}') as unknown;
    if (typeof before === 'object' && before !== null && !Array.isArray(before)) {
      sandboxes = before as Record<string, string>;
    }
  } catch {
    // A map that does not parse is replaced by the owner's entry alone.
  }
  // One machine per invite: the owner's machine leaves any other invite it was given to.
  for (const [invite, machine] of Object.entries(sandboxes)) {
    if (machine === answers.machine) delete sandboxes[invite];
  }
  sandboxes[ownerInvite] = answers.machine;
  set(server, 'MAKA_CLOUD_SANDBOXES', JSON.stringify(sandboxes));

  set(server, 'MAKA_CLOUD_MCP_PUBLIC_URL', `https://${mcp}/mcp`);
  set(server, 'MAKA_CLOUD_GATEWAY_PUBLIC_URL', `https://${models}`);
  if (!server.has('MAKA_CLOUD_AGENT_USER') || !server.has('MAKA_CLOUD_AGENT_GROUP')) {
    set(server, 'MAKA_CLOUD_AGENT_USER', DEFAULT_AGENT_USER);
    set(server, 'MAKA_CLOUD_AGENT_GROUP', DEFAULT_AGENT_GROUP);
  }

  // The checkers are the wizard's own unless the operator chose others (an empty list included),
  // and those are kept as long as their keys are still set.
  const ownVerifiers = [
    JSON.stringify([VERIFIERS.anthropic]),
    JSON.stringify([VERIFIERS.anthropic, VERIFIERS.openai]),
  ];
  const chosen = server.get('MAKA_CLOUD_VERIFIER_MODELS');
  const keepChosen =
    chosen !== undefined &&
    !ownVerifiers.includes(chosen) &&
    (answers.openAiKey !== undefined || !chosen.includes('"openai"'));
  if (!keepChosen) {
    const verifiers = [VERIFIERS.anthropic, ...(answers.openAiKey ? [VERIFIERS.openai] : [])];
    set(server, 'MAKA_CLOUD_VERIFIER_MODELS', JSON.stringify(verifiers));
  }

  if (!server.has('CLOUD_PUSH_VAPID_PUBLIC') || !server.has('CLOUD_PUSH_VAPID_PRIVATE')) {
    const pair = input.vapid();
    set(server, 'CLOUD_PUSH_VAPID_PUBLIC', pair.publicKey);
    set(server, 'CLOUD_PUSH_VAPID_PRIVATE', pair.privateKey);
  }
  set(server, 'CLOUD_PUSH_SUBJECT', answers.email ? `mailto:${answers.email}` : `https://${app}`);
  set(server, 'MAKA_CLOUD_OWNER_INVITE', ownerInvite);
  if (!server.has('MAKA_CLOUD_SPEND_ALERT_USD')) {
    set(server, 'MAKA_CLOUD_SPEND_ALERT_USD', String(DEFAULT_SPEND_ALERT_USD));
  }
  // The caps the server would use anyway, written out so the owner sees them in the file.
  for (const [name, usd] of [
    ['MAKA_CLOUD_INVITE_DAILY_USD', DEFAULT_SPEND_CAPS.inviteDailyUsd],
    ['MAKA_CLOUD_INVITE_MONTHLY_USD', DEFAULT_SPEND_CAPS.inviteMonthlyUsd],
    ['MAKA_CLOUD_SERVER_DAILY_USD', DEFAULT_SPEND_CAPS.serverDailyUsd],
  ] as const) {
    if (!server.has(name)) set(server, name, String(usd));
  }

  set(compose, 'MAKA_CLOUD_APP_NAME', app);
  set(compose, 'MAKA_CLOUD_MCP_NAME', mcp);
  set(compose, 'MAKA_CLOUD_MODELS_NAME', models);
  return { server, compose };
}

/** One live check of a key or a machine: a free call, never one that spends. */
export interface CheckResult {
  what: string;
  /** `refused`: the service said no, so the value is wrong. `unreachable`: nothing is known. */
  outcome: 'ok' | 'refused' | 'unreachable';
  detail?: string;
}

export async function checkAnswers(
  answers: SetupAnswers,
  options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CheckResult[]> {
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? {};
  const timeoutMs = options.timeoutMs ?? 15_000;
  const get = async (what: string, url: string, headers: Record<string, string>) => {
    try {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      if (response.ok) return { what, outcome: 'ok' } as const;
      if (response.status === 401 || response.status === 403) {
        return { what, outcome: 'refused', detail: `HTTP ${response.status}` } as const;
      }
      return { what, outcome: 'unreachable', detail: `HTTP ${response.status}` } as const;
    } catch (error) {
      return { what, outcome: 'unreachable', detail: (error as Error).name } as const;
    }
  };
  const base = (name: string, fallback: string): string =>
    (env[name]?.trim() || fallback).replace(/\/+$/u, '');
  const checks: Promise<CheckResult>[] = [
    get(
      'the Anthropic API key',
      `${base('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')}/v1/models`,
      {
        'x-api-key': answers.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
    ),
  ];
  if (answers.openAiKey !== undefined) {
    checks.push(
      get('the OpenAI API key', `${base('OPENAI_BASE_URL', 'https://api.openai.com/v1')}/models`, {
        authorization: `Bearer ${answers.openAiKey}`,
      }),
    );
  }
  if (answers.githubToken !== undefined) {
    checks.push(
      get('the GitHub token', 'https://api.github.com/user', {
        authorization: `Bearer ${answers.githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'maka-cloud-setup',
      }),
    );
  }
  checks.push(
    (async (): Promise<CheckResult> => {
      const what = 'the instabox key and the sandbox machine';
      try {
        const apiUrl = env.INSTABOX_API_URL?.trim();
        const client = new InstaboxClient({
          apiKey: answers.instaboxKey,
          fetch: fetchImpl,
          ...(apiUrl ? { baseUrl: apiUrl } : {}),
        });
        await client.getMachine(answers.machine, { signal: AbortSignal.timeout(timeoutMs) });
        return { what, outcome: 'ok' };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status === 401 || status === 403 || status === 404) {
          return { what, outcome: 'refused', detail: `HTTP ${status}` };
        }
        return { what, outcome: 'unreachable', detail: (error as Error).name };
      }
    })(),
  );
  return await Promise.all(checks);
}

/** How the wizard talks to a person. `secret` reads without echo. */
export interface SetupIO {
  ask(question: string, options?: { secret?: boolean }): Promise<string>;
  say(line: string): void;
}

export interface SetupOptions {
  /** The server's settings file, read if it exists and written mode 600. */
  envFile: string;
  /** The Compose substitutions file (the three names). */
  composeEnvFile: string;
  /** Where the invites database lives: the server's data directory. */
  dataDir: string;
  env: NodeJS.ProcessEnv;
  /** Answers from `env` (`--from-env`) instead of questions. */
  fromEnv: boolean;
  /** Check keys and the machine with free calls before writing anything. */
  verify: boolean;
  io: SetupIO;
  fetch?: typeof fetch;
  now?: () => Date;
}

function readIfThere(path: string): EnvEntries | undefined {
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : undefined;
}

/** Written whole or not at all, mode 600 from the first byte. */
export function writePrivateFile(path: string, text: string): void {
  const temporary = join(dirname(path), `.${Date.now()}.${process.pid}.setup.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

const KEY_QUESTIONS = [
  ['anthropicKey', 'ANTHROPIC_API_KEY', 'Anthropic API key (console.anthropic.com)', true],
  [
    'openAiKey',
    'OPENAI_API_KEY',
    'OpenAI API key, for the second-vendor review (Enter to skip)',
    false,
  ],
  ['instaboxKey', 'INSTABOX_API_KEY', 'instabox API key', true],
  [
    'githubToken',
    'MAKA_GITHUB_TOKEN',
    'GitHub fine-grained token, to open pull requests (Enter to skip)',
    false,
  ],
] as const;

async function askAnswers(
  io: SetupIO,
  before: EnvEntries | undefined,
  composeBefore: EnvEntries | undefined,
): Promise<SetupAnswers> {
  const previousDomain = composeBefore?.get('MAKA_CLOUD_APP_NAME')?.replace(/^app\./u, '');
  const previousMachine = (() => {
    const owner = before?.get('MAKA_CLOUD_OWNER_INVITE');
    try {
      const map = JSON.parse(before?.get('MAKA_CLOUD_SANDBOXES') ?? '{}') as Record<string, string>;
      return owner === undefined ? undefined : map[owner];
    } catch {
      return undefined;
    }
  })();
  const previousEmail = before?.get('CLOUD_PUSH_SUBJECT')?.match(/^mailto:(.+)$/u)?.[1];
  const line = async (question: string, previous: string | undefined, required: boolean) => {
    for (;;) {
      const answer = (
        await io.ask(previous ? `${question} [${previous}]: ` : `${question}: `)
      ).trim();
      if (answer !== '') return answer;
      if (previous !== undefined) return previous;
      if (!required) return undefined;
      io.say('  This one is required.');
    }
  };

  const answers: Partial<SetupAnswers> = {};
  for (;;) {
    const domain =
      (await line('Your domain (the app will be at app.<domain>)', previousDomain, true)) ?? '';
    if (isDomain(domain.toLowerCase())) {
      answers.domain = domain.toLowerCase();
      break;
    }
    io.say('  That is not a domain name such as example.com.');
  }
  for (const [field, name, question, required] of KEY_QUESTIONS) {
    const kept = before?.get(name);
    for (;;) {
      const prompt = kept ? `${question} [set; Enter keeps it, "-" removes it]: ` : `${question}: `;
      const answer = (await io.ask(prompt, { secret: true })).trim();
      if (answer === '-' && !required) break;
      const value = answer === '' ? kept : answer;
      if (value === undefined || value === '-') {
        if (!required) break;
        io.say('  This one is required.');
        continue;
      }
      if (field === 'githubToken') {
        const problem = githubTokenProblem(value);
        if (problem !== undefined) {
          io.say(`  ${problem}`);
          continue;
        }
      }
      answers[field] = value;
      break;
    }
    if (field === 'openAiKey' && answers.openAiKey === undefined) {
      io.say(
        '  Without it no Codex run starts, so a coding change gets no review from a second vendor.',
      );
    }
  }
  for (;;) {
    const machine =
      (await line('The instabox machine id of your sandbox', previousMachine, true)) ?? '';
    if (MACHINE_ID.test(machine)) {
      answers.machine = machine;
      break;
    }
    io.say('  That is not a machine id.');
  }
  for (;;) {
    const email = await line(
      'A contact address for push notifications (Enter to skip)',
      previousEmail,
      false,
    );
    if (email === undefined || EMAIL.test(email)) {
      if (email !== undefined) answers.email = email;
      break;
    }
    io.say('  That is not an email address.');
  }
  return answers as SetupAnswers;
}

function answersFromEnv(env: NodeJS.ProcessEnv): SetupAnswers | string[] {
  const value = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const problems: string[] = [];
  const required = (name: string): string => {
    const found = value(name);
    if (found === undefined) problems.push(`${name} is not set`);
    return found ?? '';
  };
  const answers: SetupAnswers = {
    domain: required('MAKA_CLOUD_SETUP_DOMAIN').toLowerCase(),
    anthropicKey: required('ANTHROPIC_API_KEY'),
    instaboxKey: required('INSTABOX_API_KEY'),
    machine: required('MAKA_CLOUD_SETUP_MACHINE'),
  };
  const openAiKey = value('OPENAI_API_KEY');
  if (openAiKey !== undefined) answers.openAiKey = openAiKey;
  const githubToken = value('MAKA_GITHUB_TOKEN');
  if (githubToken !== undefined) answers.githubToken = githubToken;
  const email = value('MAKA_CLOUD_SETUP_EMAIL');
  if (email !== undefined) answers.email = email;
  return problems.length > 0 ? problems : answers;
}

/** The owner's invite: the one the file names if it is still active, otherwise a new one. */
function ownerInviteOf(
  store: InviteStore,
  named: string | undefined,
): { inviteId: string; token?: string } {
  if (named !== undefined && store.active(named)) return { inviteId: named };
  return store.create('owner');
}

/** Runs the wizard; the exit code is 0 when both files are written, 2 when nothing was. */
export async function runSetup(options: SetupOptions): Promise<number> {
  const { io } = options;
  const before = readIfThere(options.envFile);
  const composeBefore = readIfThere(options.composeEnvFile);
  if (before !== undefined) {
    io.say(
      `Editing ${options.envFile}: Enter keeps a value, and settings this wizard does not ask about are kept.`,
    );
  }

  let answers: SetupAnswers;
  if (options.fromEnv) {
    const read = answersFromEnv(options.env);
    if (Array.isArray(read)) {
      for (const problem of read) io.say(problem);
      return 2;
    }
    answers = read;
  } else {
    answers = await askAnswers(io, before, composeBefore);
  }
  const problems = answerProblems(answers);
  if (problems.length > 0) {
    for (const problem of problems) io.say(problem);
    return 2;
  }

  if (options.verify) {
    io.say('Checking the keys and the machine (free calls only)...');
    const results = await checkAnswers(answers, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      env: { ...Object.fromEntries(before ?? []), ...options.env },
    });
    let refused = false;
    for (const result of results) {
      const detail = result.detail ? ` (${result.detail})` : '';
      if (result.outcome === 'ok') io.say(`  ok: ${result.what}`);
      else if (result.outcome === 'refused') {
        refused = true;
        io.say(`  refused: ${result.what}${detail}`);
      } else io.say(`  not checked, could not reach the service: ${result.what}${detail}`);
    }
    if (refused) {
      io.say('Nothing was written. Fix what was refused and run setup again.');
      return 2;
    }
  }

  const store = new InviteStore(join(options.dataDir, 'invites.db'));
  let owner: { inviteId: string; token?: string };
  let planned: PlannedSetup;
  try {
    owner = ownerInviteOf(store, before?.get('MAKA_CLOUD_OWNER_INVITE'));
    planned = planSetup({
      answers,
      ownerInvite: owner.inviteId,
      existing: {
        ...(before ? { server: before } : {}),
        ...(composeBefore ? { compose: composeBefore } : {}),
      },
      vapid: generateVapidKeys,
    });
    // The file must start the server: checked as the server reads it, before anything is written.
    try {
      const config = readStackConfig({
        ...Object.fromEntries(planned.server),
        MAKA_CLOUD_DATA_DIR: options.dataDir,
      });
      io.say('');
      for (const line of describeConfig(config)) io.say(line);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      // A new invite the file never names is no use to anyone.
      if (owner.token !== undefined) store.revoke(owner.inviteId);
      io.say(error.message);
      io.say('Nothing was written.');
      return 2;
    }
  } finally {
    store.close();
  }

  const stamp = (options.now ?? (() => new Date()))().toISOString();
  writePrivateFile(
    options.envFile,
    renderEnvFile(planned.server, [
      `maka-cloud settings, written by "maka-cloud setup" on ${stamp}.`,
      'Holds keys: root only, never in a repository. Every variable is in docs/fork/deploy.md.',
    ]),
  );
  writePrivateFile(
    options.composeEnvFile,
    renderEnvFile(planned.compose, [
      `The names Caddy serves, written by "maka-cloud setup" on ${stamp}. Point all three at this host.`,
    ]),
  );
  io.say('');
  io.say(`Wrote ${options.envFile} and ${options.composeEnvFile}.`);
  io.say(
    `Point app.${answers.domain}, mcp.${answers.domain} and models.${answers.domain} at this host.`,
  );
  if (owner.token !== undefined) {
    io.say('');
    io.say(`Your sign-in token (shown once; it is your login, keep it private): ${owner.token}`);
  } else {
    io.say(`Your invite ${owner.inviteId} is kept; its token still signs you in.`);
  }
  return 0;
}
