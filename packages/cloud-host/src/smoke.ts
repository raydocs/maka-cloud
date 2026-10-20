import { OPEN_PULL_REQUEST_TOOL } from '@maka-cloud/playbooks/coding';

/**
 * The live smoke test of a running server, written against `SmokeDeps` so that everything it does
 * to the outside (the server's HTTP API, its data files, a restart) is one seam. The tests run it
 * against fakes; `maka-cloud smoke` runs it against the real server, and only when
 * `MAKA_CLOUD_LIVE=1` and the owner's budget are set (see `smokeGate`).
 */

export interface SmokeTask {
  taskId: string;
  parentTaskId?: string;
  title?: string;
  state: string;
  costUsd?: number;
  budgetExceeded?: boolean;
  stopPending?: boolean;
  treeStopPending?: boolean;
  failureReason?: string;
}

export interface SmokeQuestion {
  questionId: string;
  reason: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  recommended: string;
  action?: { tool: string };
}

export interface SmokeTotals {
  /** The gateway journal: per task, what settled plus what is held. */
  taskUsd: ReadonlyMap<string, number>;
  /** What the smoke invite's account spent today, and what the whole server did. */
  inviteDayUsd: number;
  serverDayUsd: number;
}

export interface SmokeDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  startConversation(): Promise<string>;
  say(conversationId: string, text: string): Promise<void>;
  tasks(conversationId: string): Promise<SmokeTask[]>;
  /** Questions the conversation asked that nobody answered. */
  openQuestions(conversationId: string): Promise<SmokeQuestion[]>;
  answer(conversationId: string, questionId: string, optionId: string): Promise<void>;
  /** Every message and notice of the conversation, in order. */
  transcript(conversationId: string): Promise<string[]>;
  cancel(taskId: string): Promise<void>;
  /** Restarts the server process and resolves once it was asked to; `healthy` tells when it is back. */
  restart(): Promise<void>;
  healthy(): Promise<boolean>;
  totals(): Promise<SmokeTotals>;
  /** Caps the smoke invite's spending per day at `usd`; `undefined` puts back what it was. */
  setDailyCap(usd: number | undefined): Promise<void>;
  log(line: string): void;
}

export interface SmokeOptions {
  /** The scratch repository the coding task works on, `owner/name`. */
  repo: string;
  /** The owner's approved budget for the whole run: no scenario starts once the server has spent this today. */
  maxUsd: number;
  researchPrompt?: string;
  codingPrompt?: string;
  /** How long a scenario waits for what it expects. */
  scenarioTimeoutMs?: number;
  pollMs?: number;
  /** How long after a stop the spend must stay still. */
  settleMs?: number;
  /** How long a restarted server has to come back. */
  restartTimeoutMs?: number;
}

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface LedgerRow {
  conversationId: string;
  orchestratorUsd: number;
  gatewayUsd: number;
  ok: boolean;
}

export interface SmokeReport {
  ok: boolean;
  results: SmokeResult[];
  ledger: LedgerRow[];
}

export const DEFAULT_RESEARCH_PROMPT =
  'Research in one short report: what are the two or three main differences between SQLite and PostgreSQL for a small single-server app? Keep it brief.';

export function defaultCodingPrompt(repo: string): string {
  return `In the repository ${repo}, add a file named SMOKE.md that says "smoke test" on one line, check that it works, and open a pull request with the change.`;
}

class SmokeFailure extends Error {}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const topLevel = (tasks: readonly SmokeTask[]): SmokeTask[] =>
  tasks.filter((task) => task.parentTaskId === undefined);
const money = (usd: number): string => `$${usd.toFixed(4)}`;

/** Gateway spend and orchestrator cost agree when they are within a cent or a tenth of the larger. */
export function ledgersAgree(orchestratorUsd: number, gatewayUsd: number): boolean {
  return (
    Math.abs(orchestratorUsd - gatewayUsd) <=
    Math.max(0.01, 0.1 * Math.max(orchestratorUsd, gatewayUsd))
  );
}

/** Runs every scenario, in order, and reports each one; a scenario that fails does not stop the rest. */
export async function runSmoke(deps: SmokeDeps, options: SmokeOptions): Promise<SmokeReport> {
  const timeoutMs = options.scenarioTimeoutMs ?? 900_000;
  const pollMs = options.pollMs ?? 3_000;
  const settleMs = options.settleMs ?? 10_000;
  const restartTimeoutMs = options.restartTimeoutMs ?? 180_000;
  const researchPrompt = options.researchPrompt ?? DEFAULT_RESEARCH_PROMPT;
  const codingPrompt = options.codingPrompt ?? defaultCodingPrompt(options.repo);
  const results: SmokeResult[] = [];
  const conversations: string[] = [];
  let budgetReached = false;

  const waitFor = async <T>(
    what: string,
    check: () => Promise<T | undefined>,
    within = timeoutMs,
  ): Promise<T> => {
    const startedAt = deps.now();
    for (;;) {
      const found = await check();
      if (found !== undefined) return found;
      if (deps.now() - startedAt >= within) throw new SmokeFailure(`timed out waiting for ${what}`);
      await deps.sleep(pollMs);
    }
  };

  /** Answers what the conversation asks, by the rules of a smoke run; reports what it did not approve. */
  const answerQuestions = async (
    conversationId: string,
    allowPullRequest: boolean,
    notes: string[],
  ): Promise<void> => {
    for (const q of await deps.openQuestions(conversationId)) {
      const ids = q.options.map((option) => option.id);
      let choice: string | undefined;
      if (q.reason === 'irreversible') {
        const isPullRequest = q.action?.tool === OPEN_PULL_REQUEST_TOOL;
        if (allowPullRequest && isPullRequest && q.question.includes(options.repo)) {
          choice = 'approve';
        } else {
          choice = 'reject';
          notes.push(`rejected ${q.action?.tool ?? 'an irreversible action'}`);
        }
      } else if (q.reason === 'budget_overrun') {
        choice = 'reject';
        notes.push('refused to go over a budget');
      } else {
        choice = ids.includes(q.recommended) ? q.recommended : ids[0];
      }
      if (choice !== undefined && ids.includes(choice)) {
        await deps.answer(conversationId, q.questionId, choice);
        deps.log(`  answered ${q.reason} question with ${choice}`);
      }
    }
  };

  const spendGuard = async (): Promise<void> => {
    const { serverDayUsd } = await deps.totals();
    if (serverDayUsd >= options.maxUsd) {
      budgetReached = true;
      throw new SmokeFailure(
        `the server has spent ${money(serverDayUsd)} today, which reaches the budget of ${money(options.maxUsd)}, so this was not started`,
      );
    }
  };

  const scenario = async (name: string, body: () => Promise<string>): Promise<void> => {
    deps.log(`scenario: ${name}`);
    try {
      if (budgetReached) throw new SmokeFailure('skipped: the budget was reached earlier');
      await spendGuard();
      const detail = await body();
      results.push({ name, ok: true, detail });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail });
    }
    const last = results.at(-1);
    deps.log(`  ${last?.ok ? 'ok' : 'FAILED'}: ${last?.detail ?? ''}`);
  };

  const begin = async (prompt: string): Promise<string> => {
    const id = await deps.startConversation();
    conversations.push(id);
    await deps.say(id, prompt);
    return id;
  };

  /** Waits until a top-level task of the conversation has ended, answering questions on the way. */
  const untilEnded = async (
    id: string,
    allowPullRequest: boolean,
    notes: string[],
  ): Promise<SmokeTask> =>
    waitFor('a task to end', async () => {
      await answerQuestions(id, allowPullRequest, notes);
      return topLevel(await deps.tasks(id)).find((task) => TERMINAL.has(task.state));
    });

  const untilRunning = (id: string, notes: string[]): Promise<SmokeTask> =>
    waitFor('a task to be running', async () => {
      await answerQuestions(id, false, notes);
      const found = topLevel(await deps.tasks(id));
      const ended = found.find((task) => TERMINAL.has(task.state));
      if (ended)
        throw new SmokeFailure(`the task ended (${ended.state}) before it could be interrupted`);
      return found.find((task) => task.state === 'running');
    });

  const stoppedFor = async (id: string, taskId: string): Promise<SmokeTask> => {
    const stopped = await waitFor('the stop to be confirmed', async () => {
      const task = (await deps.tasks(id)).find((candidate) => candidate.taskId === taskId);
      if (!task) throw new SmokeFailure('the task disappeared');
      return TERMINAL.has(task.state) && !task.stopPending && !task.treeStopPending
        ? task
        : undefined;
    });
    return stopped;
  };

  const assertSpendStill = async (taskIds: readonly string[]): Promise<void> => {
    const sum = (totals: SmokeTotals): number =>
      taskIds.reduce((total, taskId) => total + (totals.taskUsd.get(taskId) ?? 0), 0);
    const before = sum(await deps.totals());
    await deps.sleep(settleMs);
    const after = sum(await deps.totals());
    if (after > before + 1e-9) {
      throw new SmokeFailure(
        `the stopped work kept spending: ${money(before)} then ${money(after)} ${settleMs / 1000}s later`,
      );
    }
  };

  await scenario('research task', async () => {
    const notes: string[] = [];
    const id = await begin(researchPrompt);
    const task = await untilEnded(id, false, notes);
    if (task.state !== 'succeeded') {
      throw new SmokeFailure(
        `the research task ${task.state}${task.failureReason ? `: ${task.failureReason}` : ''}`,
      );
    }
    if (!(task.costUsd !== undefined && task.costUsd > 0))
      throw new SmokeFailure('the task reported no cost');
    if (task.stopPending || task.treeStopPending)
      throw new SmokeFailure('the task ended but may still be running');
    return `${task.taskId} succeeded for ${money(task.costUsd)}`;
  });

  await scenario('coding task and pull request', async () => {
    const notes: string[] = [];
    const id = await begin(codingPrompt);
    const task = await untilEnded(id, true, notes);
    if (task.state !== 'succeeded') {
      throw new SmokeFailure(
        `the coding task ${task.state}${task.failureReason ? `: ${task.failureReason}` : ''}`,
      );
    }
    const link = new RegExp(
      `https://github\\.com/${options.repo.replace('.', '\\.')}/pull/\\d+`,
      'u',
    );
    const opened = await waitFor('the pull request link', async () => {
      await answerQuestions(id, true, notes);
      return (await deps.transcript(id))
        .map((line) => link.exec(line)?.[0])
        .find((url) => url !== undefined);
    });
    return `${task.taskId} succeeded and opened ${opened}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  });

  await scenario('cancel mid-run', async () => {
    const notes: string[] = [];
    const id = await begin(researchPrompt);
    const running = await untilRunning(id, notes);
    await deps.cancel(running.taskId);
    const stopped = await stoppedFor(id, running.taskId);
    if (stopped.state !== 'cancelled')
      throw new SmokeFailure(`the task is ${stopped.state}, not cancelled`);
    const all = (await deps.tasks(id)).map((task) => task.taskId);
    await assertSpendStill(all);
    return `${running.taskId} cancelled, confirmed stopped, and its spend stayed still for ${settleMs / 1000}s`;
  });

  await scenario('budget stop', async () => {
    const before = await deps.totals();
    const cap = before.inviteDayUsd;
    let id: string;
    try {
      // No headroom left today: the next model request must be refused at the gateway.
      await deps.setDailyCap(cap);
      id = await begin(researchPrompt);
      await deps.sleep(settleMs);
      const notes: string[] = [];
      const ended = await waitFor(
        'the work to stop',
        async () => {
          const tasks = topLevel(await deps.tasks(id));
          if (tasks.some((task) => task.state === 'succeeded')) {
            throw new SmokeFailure('a task succeeded although the day’s cap was already spent');
          }
          return tasks.every((task) => TERMINAL.has(task.state)) ? tasks : undefined;
        },
        Math.min(timeoutMs, 300_000),
      );
      await answerQuestions(id, false, notes);
      const after = await deps.totals();
      if (after.inviteDayUsd > cap + 1e-6) {
        throw new SmokeFailure(
          `the invite spent ${money(after.inviteDayUsd - cap)} past its cap of ${money(cap)}`,
        );
      }
      return `with the day's cap at ${money(cap)}, ${ended.length} task(s) ended without success and the invite spent nothing more`;
    } finally {
      await deps.setDailyCap(undefined);
    }
  });

  const ledger: LedgerRow[] = [];
  await scenario('ledgers agree', async () => {
    const totals = await deps.totals();
    for (const conversationId of conversations) {
      const tasks = await deps.tasks(conversationId);
      const orchestratorUsd = topLevel(tasks).reduce((sum, task) => sum + (task.costUsd ?? 0), 0);
      const gatewayUsd = tasks.reduce(
        (sum, task) => sum + (totals.taskUsd.get(task.taskId) ?? 0),
        0,
      );
      ledger.push({
        conversationId,
        orchestratorUsd,
        gatewayUsd,
        ok: ledgersAgree(orchestratorUsd, gatewayUsd),
      });
    }
    const bad = ledger.filter((row) => !row.ok);
    if (bad.length > 0) {
      throw new SmokeFailure(
        `${bad.length} conversation(s) differ: ${bad.map((row) => `${row.conversationId} orchestrator ${money(row.orchestratorUsd)} vs gateway ${money(row.gatewayUsd)}`).join('; ')}`,
      );
    }
    return `${ledger.length} conversation(s), orchestrator and gateway within a cent or 10%`;
  });

  await scenario('restart', async () => {
    const notes: string[] = [];
    const id = await begin(researchPrompt);
    const running = await untilRunning(id, notes);
    await deps.restart();
    await waitFor(
      'the server to come back',
      async () => ((await deps.healthy().catch(() => false)) ? true : undefined),
      restartTimeoutMs,
    );
    const settled = await stoppedFor(id, running.taskId);
    await deps.say(id, 'Are you still there?');
    return `${running.taskId} is ${settled.state} after the restart, nothing is left running, and the conversation still answers`;
  });

  return { ok: results.every((result) => result.ok), results, ledger };
}

/** The report as lines to print: each scenario, then the two ledgers side by side. */
export function formatSmokeReport(report: SmokeReport): string[] {
  const lines = ['', 'Smoke test result'];
  for (const result of report.results) {
    lines.push(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}: ${result.detail}`);
  }
  if (report.ledger.length > 0) {
    lines.push('', 'Ledger (orchestrator task cost | gateway journal)');
    for (const row of report.ledger) {
      lines.push(
        `  ${row.ok ? 'ok      ' : 'MISMATCH'}  ${row.conversationId}  ${money(row.orchestratorUsd)} | ${money(row.gatewayUsd)}`,
      );
    }
  }
  lines.push('', report.ok ? 'All scenarios passed.' : 'Some scenarios failed.');
  return lines;
}

export interface SmokeSettings {
  url: string;
  token: string;
  inviteId: string;
  repo: string;
  maxUsd: number;
  dataDir: string;
  restartCommand: string[];
}

const NEEDED = [
  ['MAKA_CLOUD_SMOKE_URL', 'the server’s public API URL'],
  ['MAKA_CLOUD_SMOKE_TOKEN', 'an invite token reserved for the smoke test'],
  ['MAKA_CLOUD_SMOKE_INVITE_ID', 'that invite’s id'],
  ['MAKA_CLOUD_SMOKE_REPO', 'the scratch repository, owner/name'],
  ['MAKA_CLOUD_SMOKE_MAX_USD', 'the budget you approved for this run, in dollars'],
  ['MAKA_CLOUD_DATA_DIR', 'the server’s data directory'],
  ['MAKA_CLOUD_SMOKE_RESTART_CMD', 'a JSON array: the command that restarts the server'],
] as const;

/** Every variable `maka-cloud smoke` reads, with what it is for. */
export const SMOKE_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  [
    'MAKA_CLOUD_LIVE',
    'must be exactly 1: the smoke test spends real money and runs only on purpose',
  ],
  ...NEEDED,
];

/**
 * Decides whether a smoke run may start, from the environment alone: nothing is read, opened or
 * sent before this says yes. It says no unless `MAKA_CLOUD_LIVE` is exactly `1` and every setting
 * is present and valid, and the refusal names the settings, never their values.
 */
export function smokeGate(
  env: NodeJS.ProcessEnv,
): { ok: true; settings: SmokeSettings } | { ok: false; problems: string[] } {
  if (env.MAKA_CLOUD_LIVE !== '1') {
    return {
      ok: false,
      problems: [
        'The smoke test spends real money on a real server, so it runs only when MAKA_CLOUD_LIVE=1 is set on purpose. Nothing was done.',
      ],
    };
  }
  const problems: string[] = [];
  const get = (name: string): string => env[name]?.trim() ?? '';
  for (const [name, what] of NEEDED) {
    if (get(name) === '') problems.push(`${name} is not set: ${what}`);
  }
  const maxUsd = Number(get('MAKA_CLOUD_SMOKE_MAX_USD'));
  if (
    get('MAKA_CLOUD_SMOKE_MAX_USD') !== '' &&
    !(/^\d+(\.\d+)?$/u.test(get('MAKA_CLOUD_SMOKE_MAX_USD')) && maxUsd > 0 && maxUsd <= 1000)
  ) {
    problems.push('MAKA_CLOUD_SMOKE_MAX_USD must be a number of dollars above 0, up to 1000');
  }
  if (
    get('MAKA_CLOUD_SMOKE_REPO') !== '' &&
    !/^[\w.-]+\/[\w.-]+$/u.test(get('MAKA_CLOUD_SMOKE_REPO'))
  ) {
    problems.push('MAKA_CLOUD_SMOKE_REPO must look like owner/name');
  }
  if (
    get('MAKA_CLOUD_SMOKE_INVITE_ID') !== '' &&
    !/^inv_[0-9a-f]{12}$/u.test(get('MAKA_CLOUD_SMOKE_INVITE_ID'))
  ) {
    problems.push('MAKA_CLOUD_SMOKE_INVITE_ID must be an invite id such as inv_0123456789ab');
  }
  let restartCommand: string[] = [];
  if (get('MAKA_CLOUD_SMOKE_RESTART_CMD') !== '') {
    try {
      const parsed: unknown = JSON.parse(get('MAKA_CLOUD_SMOKE_RESTART_CMD'));
      if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        !parsed.every((part) => typeof part === 'string' && part !== '')
      ) {
        throw new Error('shape');
      }
      restartCommand = parsed as string[];
    } catch {
      problems.push(
        'MAKA_CLOUD_SMOKE_RESTART_CMD must be a JSON array of strings, such as ["systemctl","restart","maka-cloud"]',
      );
    }
  }
  if (get('MAKA_CLOUD_SMOKE_URL') !== '') {
    try {
      const url = new URL(get('MAKA_CLOUD_SMOKE_URL'));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
      if (url.username !== '' || url.password !== '') throw new Error('credentials');
    } catch {
      problems.push('MAKA_CLOUD_SMOKE_URL must be an http or https URL without credentials');
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    settings: {
      url: get('MAKA_CLOUD_SMOKE_URL').replace(/\/+$/u, ''),
      token: get('MAKA_CLOUD_SMOKE_TOKEN'),
      inviteId: get('MAKA_CLOUD_SMOKE_INVITE_ID'),
      repo: get('MAKA_CLOUD_SMOKE_REPO'),
      maxUsd,
      dataDir: get('MAKA_CLOUD_DATA_DIR'),
      restartCommand,
    },
  };
}
