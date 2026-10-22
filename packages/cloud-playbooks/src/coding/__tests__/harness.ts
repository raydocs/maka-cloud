import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { TestContext } from 'node:test';
import { InstaboxClient } from '@maka-cloud/instabox';
import { FakeInstabox } from '@maka-cloud/instabox/testing';
import { DEFAULT_MODES } from '@maka-cloud/modes';
import type { RunHandle, RunnerEvent, RunSpec } from '@maka-cloud/orchestrator';
import { Fleet, FixedMachineProvider } from '@maka-cloud/runners';
import { MemoryCodingDeliveries } from '../deliveries.js';
import { verifyCodingManifest } from '../playbook.js';
import { type AgentRunner, CodingRunner, type CodingRunnerOptions } from '../runner.js';
import {
  type CodingSandbox,
  type ExecOptions,
  type ExecResult,
  FleetCodingSandbox,
  type SandboxWorkspace,
} from '../sandbox.js';
import type { Vendor } from '../task.js';

/** A one-shot latch: `wait()` resolves once `open()` is called. */
export function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export const BUGGY_ADD = 'add() { echo $(( $1 - $2 )); }\n';
export const FIXED_ADD = 'add() { echo $(( $1 + $2 )); }\n';
export const REPRO_TEST = 'source lib/add.sh\n[ "$(add 2 3)" = 5 ]\n';
export const TEST_COMMAND = 'bash tests/run.sh';

/** What a scripted agent turn sees. */
export interface AgentTurn {
  vendor: Vendor;
  kind: 'start' | 'resume';
  /** 1-based per vendor. */
  n: number;
  spec: RunSpec;
  prompt?: string;
  /** The repository in the sandbox (a local directory here). */
  workspace: string;
  /** The task directory in the sandbox. */
  dir: string;
  signal: AbortSignal;
  progress(note: string): void;
  /** Reports what this run has spent so far, like a real runner (cumulative per run). */
  usage(costUsd: number): void;
}

export type AgentScript = (turn: AgentTurn) => Promise<'ok' | { failed: string }>;

export interface ExecCall {
  script: string;
  envs: Record<string, string>;
}

/** Intercepts the coding runner's sandbox calls, so tests can hold one at a known point. */
export type ExecHook = (call: ExecCall, phase: 'before' | 'after') => Promise<void> | void;

/** Stands in for one sandbox call; `run` makes the real one. */
export type ExecReplace = (
  call: ExecCall,
  run: () => Promise<ExecResult>,
) => Promise<ExecResult> | undefined;

/** Whether a sandbox call runs a check (the test command or the reproduction test). */
export function isCheck(call: ExecCall): boolean {
  return call.envs.MAKA_CMD !== undefined;
}

/**
 * Shell that records the pid of the shell running it, as the host sees it, in
 * `$MAKA_TEST_PIDS/<name>-<random>` (or `file`): inside a PID namespace `$$` is the namespace's pid, while
 * /proc (the host's) gives the host's.
 */
export function recordPid(name: string, file = `"$MAKA_TEST_PIDS/${name}-$RANDOM$RANDOM"`): string {
  return `read -r pid _ < /proc/self/stat; f=${file}; echo "$pid" > "$f.tmp" && mv "$f.tmp" "$f"`;
}

/**
 * What an agent does when a test gives it no script: a review brief gets a review that finds nothing
 * (the runner delivers only a change the other vendor has reviewed), anything else does nothing.
 */
export const reviewsNothing: AgentScript = async (turn) => {
  const brief = await fs.readFile(turn.spec.briefPath, 'utf8');
  if (/# Review of a change/u.test(brief)) {
    await fs.writeFile(
      join(turn.dir, 'review.json'),
      JSON.stringify({ summary: 'Nothing to report.', findings: [] }),
    );
  }
  return 'ok';
};

export class FakeAgent implements AgentRunner {
  readonly turns: AgentTurn[] = [];
  open = 0;
  private n = 0;

  constructor(
    readonly vendor: Vendor,
    private readonly harness: Harness,
    public script: AgentScript = reviewsNothing,
  ) {}

  start(spec: RunSpec): Promise<RunHandle> {
    return this.run(spec, 'start');
  }

  resume(_taskId: string, input: { prompt: string; spec: RunSpec }): Promise<RunHandle> {
    return this.run(input.spec, 'resume', input.prompt);
  }

  private async run(spec: RunSpec, kind: 'start' | 'resume', prompt?: string): Promise<RunHandle> {
    const h = this.harness;
    // Like the real runners, every run reads its brief, a resume included.
    await fs.readFile(spec.briefPath, 'utf8');
    await h.fleet.updateRecord(spec.taskId, (current) => ({
      taskId: spec.taskId,
      runner: this.vendor,
      tenantId: 'default',
      machineId: h.fake.machineId,
      turns: (current?.turns ?? 0) + 1,
      snapshotIds: [],
      updatedAt: Date.now(),
    }));
    const abort = new AbortController();
    const events: RunnerEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const push = (event: RunnerEvent): void => {
      if (closed) return;
      events.push(event);
      wake?.();
    };
    const close = (): void => {
      closed = true;
      wake?.();
    };
    const dir = join(h.root, spec.taskId);
    const turn: AgentTurn = {
      vendor: this.vendor,
      kind,
      n: ++this.n,
      spec,
      ...(prompt === undefined ? {} : { prompt }),
      workspace: join(dir, 'workspace'),
      dir,
      signal: abort.signal,
      progress: (note) => push({ type: 'progress', note }),
      usage: (costUsd) => push({ type: 'usage', costUsd }),
    };
    this.turns.push(turn);
    this.open++;
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      this.open--;
      close();
    };
    const finished = (async () => {
      try {
        const outcome = await this.script(turn);
        if (abort.signal.aborted) return;
        if (outcome === 'ok') {
          await fs.writeFile(
            spec.resultPath,
            JSON.stringify({
              summary: `${this.vendor} turn ${turn.n}`,
              done: ['made the change'],
              notDone: [],
              confidence: 'high',
              knownIssues: [],
            }),
          );
          push({ type: 'finished' });
        } else {
          push({ type: 'failed', reason: outcome.failed });
        }
      } catch (error) {
        if (!abort.signal.aborted) push({ type: 'failed', reason: String(error) });
      } finally {
        end();
      }
    })();
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const item = events.shift();
            if (item) {
              yield item;
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        },
      },
      cancel: async () => {
        abort.abort();
        end();
        // Like a real runner, a cancel returns once the run has stopped.
        await finished;
      },
    };
  }
}

export interface Harness {
  fake: FakeInstabox;
  fleet: Fleet;
  runner: CodingRunner;
  claude: FakeAgent;
  codex: FakeAgent;
  deliveries: MemoryCodingDeliveries;
  /** The upstream repository (a bare repo the sandbox fetches from). */
  bare: string;
  baseSha: string;
  root: string;
  handoff: string;
  /** Where test processes started in the sandbox record their pids (`$MAKA_TEST_PIDS`). */
  pids: string;
  /** Sandbox calls made by the runner, in order. */
  calls: ExecCall[];
  hook: ExecHook | undefined;
  replace: ExecReplace | undefined;
  leases: { acquired: number; released: number };
  /** The accounts the sandbox's `sudo` double was asked to run something as, one entry per use. */
  sudoUsers(): Promise<string[]>;
  /** Resolves after the next workspace sample finishes. */
  nextSample(): Promise<void>;
  /** `lead` is written before the brief, as the conductor's code writes the `maka-mode:` line. */
  spec(taskId: string, block?: Record<string, unknown> | string, lead?: string): Promise<RunSpec>;
  makeRunner(overrides?: Partial<CodingRunnerOptions>): CodingRunner;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

const SUDO_DOUBLE = `#!/bin/bash
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--preserve-env|-H) shift ;;
    -u) echo "$2" >> "$(dirname "$0")/sudo-users"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
# The agent starts under \`env -i\`; the pid directory is the test's own channel to its processes.
if [ "$1" = env ] && [ "$2" = -i ] && [ -n "\${MAKA_TEST_PIDS:-}" ]; then
  shift 2
  exec env -i MAKA_TEST_PIDS="$MAKA_TEST_PIDS" "$@"
fi
exec "$@"
`;

/** A sandbox that records every exec and lets a test hold one. */
class RecordingSandbox implements CodingSandbox {
  constructor(
    private readonly inner: CodingSandbox,
    private readonly h: Harness,
    private readonly samples: (() => void)[],
  ) {}

  async open(taskId: string, signal?: AbortSignal, attempt?: number): Promise<SandboxWorkspace> {
    const ws = await this.inner.open(taskId, signal, attempt);
    this.h.leases.acquired++;
    const { h, samples } = this;
    const record = async (
      script: string,
      options: ExecOptions,
      run: () => Promise<ExecResult>,
    ): Promise<ExecResult> => {
      const call = { script, envs: options.envs ?? {} };
      h.calls.push(call);
      await h.hook?.(call, 'before');
      const result = (await h.replace?.(call, run)) ?? (await run());
      await h.hook?.(call, 'after');
      if (script.includes('hash-object --no-filters')) samples.splice(0).forEach((fn) => fn());
      return result;
    };
    return {
      dir: ws.dir,
      async exec(script, options = {}) {
        return record(script, options, () => ws.exec(script, options));
      },
      async execCheck(script, options = {}) {
        return record(script, options, () => ws.execCheck(script, options));
      },
      async execCheckStop(script, options = {}) {
        return record(script, options, () => ws.execCheckStop(script, options));
      },
      stopAll: (s) => ws.stopAll(s),
      agentOnSameMachine: () => ws.agentOnSameMachine(),
      async release() {
        h.leases.released++;
        await ws.release();
      },
    };
  }

  stopTask(taskId: string, signal?: AbortSignal, upToAttempt?: number): Promise<void> {
    return this.inner.stopTask(taskId, signal, upToAttempt);
  }
}

export async function setup(
  t: TestContext,
  options: Partial<CodingRunnerOptions> = {},
  sandbox: { execPath?: string; noAgentChannel?: boolean } = {},
): Promise<Harness> {
  const tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'coding-test-')));
  const home = join(tmp, 'home');
  const root = join(tmp, 'work');
  const logRoot = join('/dev/shm', `maka-logs-${basename(tmp)}`);
  const handoff = join(tmp, 'handoff');
  const upstream = join(tmp, 'upstream');
  const bare = join(tmp, 'repo.git');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(handoff, { recursive: true });
  await fs.mkdir(join(upstream, 'lib'), { recursive: true });
  await fs.mkdir(join(upstream, 'tests'), { recursive: true });
  await fs.writeFile(join(upstream, 'lib', 'add.sh'), BUGGY_ADD);
  await fs.writeFile(
    join(upstream, 'tests', 'run.sh'),
    'for t in tests/test_*.sh; do bash "$t" || { echo "FAIL $t"; exit 1; }; done\necho ALL PASS\n',
  );
  await fs.writeFile(
    join(upstream, 'tests', 'test_zero.sh'),
    'source lib/add.sh\n[ "$(add 2 0)" = 2 ]\n',
  );
  await fs.writeFile(join(upstream, '.gitignore'), 'build/\n');
  git(upstream, 'init', '-q', '-b', 'main');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'base');
  const baseSha = git(upstream, 'rev-parse', 'HEAD');
  git(tmp, 'clone', '-q', '--bare', upstream, bare);
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

  const pids = join(tmp, 'pids');
  await fs.mkdir(pids);
  // Checks run as the agent's account, so the fleet has one; the fake sandbox has a single user,
  // and its `sudo` runs the command as that user (the real second account has its own tests).
  const shim = join(tmp, 'sudo-double');
  await fs.mkdir(shim);
  await fs.writeFile(join(shim, 'sudo'), SUDO_DOUBLE, { mode: 0o755 });
  const fake = await new FakeInstabox({
    home,
    env: { MAKA_TEST_PIDS: pids },
    execPath: `${shim}:${sandbox.execPath ?? process.env.PATH ?? ''}`,
  }).start();
  const client = new InstaboxClient({
    apiKey: fake.apiKey,
    baseUrl: fake.url,
    sleep: async () => {},
    random: () => 0,
  });
  const fleet = new Fleet({
    client,
    sandboxes: new FixedMachineProvider(fake.machineId),
    workRoot: root,
    logRoot,
    pollIntervalMs: 5,
    ...(sandbox.noAgentChannel
      ? {}
      : {
          agentChannel: {
            user: 'maka-agent',
            group: execFileSync('id', ['-gn']).toString().trim(),
          },
        }),
  });
  fleet.ensureAgentIsolation = async () => undefined;
  const samples: (() => void)[] = [];
  const h = {
    fake,
    fleet,
    bare,
    baseSha,
    root,
    handoff,
    pids,
    calls: [],
    hook: undefined,
    replace: undefined,
    leases: { acquired: 0, released: 0 },
    nextSample: () => new Promise<void>((resolve) => samples.push(resolve)),
    async sudoUsers() {
      const text = await fs.readFile(join(shim, 'sudo-users'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean);
    },
  } as unknown as Harness;
  h.deliveries = new MemoryCodingDeliveries();
  h.claude = new FakeAgent('claude-agent-sdk', h);
  h.codex = new FakeAgent('codex', h);
  const recording = new RecordingSandbox(new FleetCodingSandbox(fleet), h, samples);
  h.makeRunner = (overrides = {}) =>
    new CodingRunner({
      agents: { 'claude-agent-sdk': h.claude, codex: h.codex },
      sandbox: recording,
      deliveries: h.deliveries,
      repoUrl: () => `file://${bare}`,
      sampleIntervalMs: 60_000,
      modes: DEFAULT_MODES,
      ...options,
      ...overrides,
    });
  h.runner = h.makeRunner();
  h.spec = async (taskId, block, lead = '') => {
    const dir = join(handoff, taskId);
    await fs.mkdir(dir, { recursive: true });
    const json =
      typeof block === 'string'
        ? block
        : JSON.stringify({
            repo: 'acme/calc',
            baseRef: 'main',
            testCommand: TEST_COMMAND,
            goal: 'add() subtracts; make it add.',
            ...block,
          });
    await fs.writeFile(
      join(dir, 'brief.md'),
      `${lead}# Fix add\n\nPlan: write a failing test, fix lib/add.sh.\n\n\`\`\`coding-task\n${json}\n\`\`\`\n`,
    );
    return {
      taskId,
      runner: 'coding',
      briefPath: join(dir, 'brief.md'),
      resultPath: join(dir, 'result.json'),
    };
  };

  t.after(async () => {
    for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
      if (!dir.startsWith('.'))
        await fleet
          .machine(fake.machineId)
          .kill(dir)
          .catch(() => undefined);
    }
    await fake.close();
    await fs.rm(logRoot, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return h;
}

/**
 * Pids recorded with recordPid under `name`, waiting until there are at least `count`; fails
 * instead when `until` settles first (the task or the check ended without recording them).
 */
export async function recordedPids(
  h: Harness,
  name: string,
  count = 0,
  until?: Promise<unknown>,
): Promise<number[]> {
  let ended = false;
  until?.then(
    () => (ended = true),
    () => (ended = true),
  );
  for (;;) {
    const settled = ended;
    const files = (await fs.readdir(h.pids)).filter(
      (file) => file.startsWith(`${name}-`) && !file.endsWith('.tmp'),
    );
    const pids = (await Promise.all(files.map((file) => fs.readFile(join(h.pids, file), 'utf8'))))
      .map((text) => Number(text.trim()))
      .filter((pid) => pid > 0);
    if (pids.length >= count) return pids;
    if (settled) throw new Error(`ended before ${count} ${name} pid(s) were recorded`);
    await new Promise((resolve) => setImmediate(resolve));
  }
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

export async function readJson<T = any>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as T;
}

// -- agent behaviours ------------------------------------------------------------------------------

export async function writeRepro(turn: AgentTurn, test = REPRO_TEST): Promise<void> {
  await fs.writeFile(join(turn.workspace, 'tests', 'test_add.sh'), test);
  await fs.writeFile(
    join(turn.dir, 'repro.json'),
    JSON.stringify({ command: 'bash tests/test_add.sh', files: ['tests/test_add.sh'] }),
  );
}

/** Writes the reproduction test and the fix. */
export const fixes: AgentScript = async (turn) => {
  await writeRepro(turn);
  await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), FIXED_ADD);
  return 'ok';
};

/** Writes the reproduction test but never fixes the code. */
export const testOnly: AgentScript = async (turn) => {
  await writeRepro(turn);
  return 'ok';
};

export function isAlive(pid: number): boolean {
  try {
    const stat = execFileSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8' });
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

export function zeroStats(runner: CodingRunner): void {
  const stats = { ...runner.stats };
  for (const [key, value] of Object.entries(stats)) {
    if (value !== 0) throw new Error(`${key} is ${value}, not 0: ${JSON.stringify(stats)}`);
  }
}

/**
 * The task was stopped (or ended) while the review was not done: the change that passed the checks
 * is already on the host, kept for the owner, with the reason and without a verdict of its own.
 */
export async function keptAfterStop(h: Harness, id: string) {
  const dir = join(h.handoff, id);
  const delivery = await h.deliveries.get(id);
  assert.ok(delivery, 'the verified change is kept, not lost');
  assert.equal(delivery.publishedPr, undefined);
  const record = await readJson(join(dir, 'verification.json'));
  assert.equal(record.result, 'verified');
  assert.match(record.kept?.reason ?? '', /ended before (its|the) independent review/);
  assert.ok(await fs.readFile(delivery.changesPath, 'utf8'), 'the change set is on disk');
  assert.ok(await fs.readFile(join(dir, 'change.patch'), 'utf8'), 'the patch is on disk');
  const manifest = await readJson(join(dir, 'result.json'));
  assert.match(manifest.summary, /^Kept for you to look at, not delivered: /);
  assert.equal(verifyCodingManifest(manifest).ok, false, 'never taken for a delivery');
}
