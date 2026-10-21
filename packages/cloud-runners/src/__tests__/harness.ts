import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { InstaboxClient } from '@maka-cloud/instabox';
import { FakeInstabox, type FakeInstaboxOptions } from '@maka-cloud/instabox/testing';
import type { RunHandle, RunnerEvent, RunSpec } from '@maka-cloud/orchestrator';
import { type CloudRunners, createCloudRunners } from '../index.js';
import type { CloudRunnersOptions } from '../fleet.js';
import { FixedMachineProvider } from '../providers.js';
import { MemorySessionStore } from '../session-store.js';
import type { ModelAccess, ModelAccessProvider } from '../types.js';
import { CLAUDE_CLI, CODEX_CLI } from './fake-cli.js';

/** The account the harness's runners run CLIs as; the sudo double only records it. */
export const HARNESS_AGENT = { user: 'maka-agent', group: 'maka' };

export const API_KEY = 'sk-test-api-key-1234567890';
export const MCP_TOKEN = 'mko_test_token_abcdefghijkl';

/**
 * A `sudo` that runs the command as the current user. The fake sandbox has one user, so the agent's
 * separate account is only a name here; `agent-user.test.ts` checks the real thing where a second
 * account exists. The `calls` file (next to it) records each `-u` account the double was asked for.
 */
export const SUDO_DOUBLE = `#!/bin/bash
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--preserve-env|-H) shift ;;
    -u) echo "$2" >> "$(dirname "$0")/sudo-users"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
exec "$@"
`;

export interface Harness {
  fake: FakeInstabox;
  client: InstaboxClient;
  runners: CloudRunners;
  /** Another set of runners over the same sandbox and session store, as a restarted process would build. */
  makeRunners(overrides?: Partial<CloudRunnersOptions>): CloudRunners;
  /** The group leader pid of a run's wrapper script, once it has started. */
  runPid(taskId: string, run?: string): Promise<number>;
  sessions: MemorySessionStore;
  /** Revocations seen by the model access provider, by task. */
  revoked: string[];
  /** The `upToAttempt` of each `revokeForTask` call. */
  revokedUpTo: Array<number | undefined>;
  tmp: string;
  /** The accounts the sudo double was asked to run something as, one entry per run. */
  sudoUsers(): Promise<string[]>;
  home: string;
  /** The sandbox's work root. */
  root: string;
  /** Where raw CLI output is kept (memory-backed in the real sandbox, /dev/shm here). */
  logRoot: string;
  /** Host side: brief and result files. */
  handoff: string;
  spec(taskId: string, extra?: Partial<RunSpec>): Promise<RunSpec>;
  setMode(mode: string): Promise<void>;
  /** Contents of the recorded CLI calls: argv (split on NUL) and env. */
  cliCall(vendor: 'claude' | 'codex', n: number): Promise<{ argv: string[]; env: string }>;
  cliCalls(vendor: 'claude' | 'codex'): Promise<number>;
  cleanup(): Promise<void>;
}

export interface SetupOptions {
  fake?: FakeInstaboxOptions;
  cloud?: Partial<CloudRunnersOptions>;
  /** Install the fake CLIs and their setup markers. Default true. */
  installClis?: boolean;
  /** A box with no agent account configured at all (the default harness has one). */
  noAgentChannel?: boolean;
}

export async function setup(options: SetupOptions = {}): Promise<Harness> {
  const tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'runners-test-')));
  const home = join(tmp, 'home');
  const root = join(tmp, 'work');
  const logRoot = join('/dev/shm', `maka-logs-${basename(tmp)}`);
  const handoff = join(tmp, 'handoff');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(handoff, { recursive: true });
  // Every CLI runs as the agent's account, so a box without one runs nothing: unless a test brings
  // its own account, the fake sandbox gets a `sudo` that only records the account it is asked for.
  const shim = join(tmp, 'sudo-double');
  const ownChannel = options.cloud?.agentChannel !== undefined || options.noAgentChannel === true;
  if (!ownChannel) {
    await fs.mkdir(shim, { recursive: true });
    await fs.writeFile(join(shim, 'sudo'), SUDO_DOUBLE, { mode: 0o755 });
  }
  const fake = await new FakeInstabox({
    home,
    ...options.fake,
    ...(ownChannel
      ? {}
      : { execPath: `${shim}:${options.fake?.execPath ?? process.env.PATH ?? ''}` }),
  }).start();
  const client = new InstaboxClient({
    apiKey: fake.apiKey,
    baseUrl: fake.url,
    sleep: async () => {},
    random: () => 0,
  });
  const sessions = new MemorySessionStore();
  const revoked: string[] = [];
  const revokedUpTo: Array<number | undefined> = [];
  const modelAccess: ModelAccessProvider = {
    async issue({ taskId }): Promise<ModelAccess> {
      return {
        apiKey: API_KEY,
        baseUrl: 'https://gateway.test/v1',
        revoke: () => void revoked.push(taskId),
      };
    },
    revokeForTask: (taskId, options) => {
      revoked.push(`orphan:${taskId}`);
      revokedUpTo.push(options?.upToAttempt);
    },
  };
  const baseOptions: CloudRunnersOptions = {
    client,
    sandboxes: new FixedMachineProvider(fake.machineId),
    modelAccess,
    sessions,
    workRoot: root,
    logRoot,
    versions: { 'claude-agent-sdk': '9.9.9', codex: '9.9.9' },
    pollIntervalMs: 5,
    stopGraceMs: 200,
    mcpUrlForSandbox: (url) => url.replace('127.0.0.1', 'orchestrator.internal'),
    ...(ownChannel
      ? {}
      : {
          agentChannel: {
            user: 'maka-agent',
            group: execFileSync('id', ['-gn']).toString().trim(),
          },
        }),
    ...options.cloud,
  };
  // The box check needs a second account; it has its own tests.
  const build = (overrides: Partial<CloudRunnersOptions>): CloudRunners => {
    const made = createCloudRunners({ ...baseOptions, ...overrides });
    if (!ownChannel) made.fleet.ensureAgentIsolation = async () => undefined;
    return made;
  };
  const runners = build({});

  if (options.installClis !== false) {
    const bin = join(home, '.maka-cli', 'bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(join(bin, 'claude'), CLAUDE_CLI, { mode: 0o755 });
    await fs.writeFile(join(bin, 'codex'), CODEX_CLI, { mode: 0o755 });
    await fs.mkdir(join(root, '.setup'), { recursive: true });
    await fs.writeFile(join(root, '.setup', 'claude-9.9.9.ok'), '');
    await fs.writeFile(join(root, '.setup', 'codex-9.9.9.ok'), '');
  }
  await fs.mkdir(join(home, 'fake-cli'), { recursive: true });
  await fs.writeFile(
    join(home, 'fake-cli', 'secret.txt'),
    'root-only secret that must not be copied',
  );

  return {
    fake,
    client,
    runners,
    makeRunners: (overrides = {}) => build(overrides),
    async runPid(taskId, run = 't1') {
      // A run is named for the attempt that started it when the spec has one: `e2.t1`.
      const named = new RegExp(`^(e\\d+\\.)?${run.replaceAll('.', '\\.')}\\.pid$`, 'u');
      for (let i = 0; i < 500; i++) {
        const names = (await fs.readdir(join(root, taskId)).catch(() => [] as string[])).filter(
          (name) => named.test(name),
        );
        for (const name of names) {
          const text = await fs.readFile(join(root, taskId, name), 'utf8').catch(() => '');
          if (text.trim()) return Number(text.trim());
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no pid for ${taskId} ${run}`);
    },
    sessions,
    revoked,
    revokedUpTo,
    tmp,
    async sudoUsers() {
      const text = await fs.readFile(join(shim, 'sudo-users'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean);
    },
    home,
    root,
    logRoot,
    handoff,
    async spec(taskId, extra = {}) {
      const dir = join(handoff, taskId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'brief.md'), `# Brief for ${taskId}\n\nDo the thing.\n`);
      return {
        taskId,
        runner: 'claude-agent-sdk',
        briefPath: join(dir, 'brief.md'),
        resultPath: join(dir, 'result.json'),
        ...extra,
      };
    },
    async setMode(mode) {
      await fs.writeFile(join(home, 'fake-cli', 'mode'), mode);
    },
    async cliCall(vendor, n) {
      const base = join(home, 'fake-cli', `${vendor}-${n}`);
      const argv = (await fs.readFile(`${base}.argv`, 'utf8')).split('\0').slice(0, -1);
      return { argv, env: await fs.readFile(`${base}.env`, 'utf8') };
    },
    async cliCalls(vendor) {
      const names = await fs.readdir(join(home, 'fake-cli'));
      return names.filter((name) => name.startsWith(`${vendor}-`) && name.endsWith('.argv')).length;
    },
    async cleanup() {
      // Kill anything a test left running before the files go away.
      for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
        if (!dir.startsWith('.'))
          await runners.fleet
            .machine(fake.machineId)
            .kill(dir)
            .catch(() => undefined);
      }
      for (const pid of await fs
        .readFile(join(home, 'fake-cli', 'children'), 'utf8')
        .then((text) => text.split('\n').filter(Boolean).map(Number))
        .catch(() => [] as number[])) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      await fake.close();
      await fs.rm(logRoot, { recursive: true, force: true });
      await fs.rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Everything a run reports, up to the end of its stream. */
export async function collect(handle: RunHandle): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

export function terminal(events: RunnerEvent[]): RunnerEvent | undefined {
  return events.find((event) => event.type === 'finished' || event.type === 'failed');
}

export function notes(events: RunnerEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'progress' ? [event.note] : []));
}

/** Whether the process still runs. A zombie (killed, not yet reaped by init) does not count. */
export async function isRunning(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/** Reads a run's events a step at a time, so a test can act in the middle of a run. */
export function reader(handle: RunHandle) {
  const iterator = handle.events[Symbol.asyncIterator]();
  const seen: RunnerEvent[] = [];
  return {
    seen,
    /** Reads until an event satisfies `predicate` and returns it. */
    async until(predicate: (event: RunnerEvent) => boolean): Promise<RunnerEvent> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error('the run ended before the expected event');
        seen.push(next.value);
        if (predicate(next.value)) return next.value;
      }
    },
    /** Reads to the end of the stream. */
    async rest(): Promise<RunnerEvent[]> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return seen;
        seen.push(next.value);
      }
    },
  };
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The outcome of `promise`, or `'stuck'` when it has not settled after `ms`. A failure detector for
 * code that must not wait, never a way to wait for something.
 */
export async function settles<T>(promise: Promise<T>, ms = 8_000): Promise<T | 'stuck'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'stuck'>((resolve) => {
        timer = setTimeout(() => resolve('stuck'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls a condition on the event loop until it holds (readiness of something the test started). */
export async function until(
  condition: () => boolean | Promise<boolean>,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function exists(path: string): Promise<boolean> {
  return await fs.access(path).then(
    () => true,
    () => false,
  );
}

/** Pids the fake CLI left behind (see `orphan` in fake-cli.ts). */
export async function children(h: Pick<Harness, 'home'>): Promise<number[]> {
  const text = await fs.readFile(join(h.home, 'fake-cli', 'children'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(Number);
}

/** Files under `dirs` (recursively) whose bytes contain any of `needles`. */
export async function filesContaining(dirs: string[], needles: string[]): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path).catch(() => Buffer.alloc(0));
        if (needles.some((needle) => bytes.includes(needle))) hits.push(path);
      }
    }
  };
  for (const dir of dirs) await walk(dir);
  return hits;
}

/** Every file under `dir`, recursively. Empty directories do not count. */
export async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}
