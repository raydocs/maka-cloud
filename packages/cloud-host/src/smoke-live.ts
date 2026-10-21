import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  clearRunBudget,
  type JournalTotals,
  journalEnforcesRunBudgets,
  type RunBudget,
  RUN_LEASE_MS,
  RunBudgetHeld,
  readJournalTotals,
  renewRunBudget,
  setRunBudget,
} from '@maka-cloud/gateway';
import { InviteStore } from '@maka-cloud/server';
import {
  formatSmokeReport,
  runSmoke,
  type SmokeDeps,
  type SmokeQuestion,
  type SmokeSettings,
  type SmokeTask,
  type SmokeTotals,
  smokeGate,
} from './smoke.js';

/**
 * `SmokeDeps` over a running server: its public HTTP API as the smoke invite, its gateway journal
 * and invites file read from the data directory, and its restart command. Nothing here is reached
 * unless `smokeGate` said yes; the tests drive it against a stub server and a temporary directory.
 *
 * Errors name the route and the status, never a body, header or token.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_QUIET_MS = 800;
const STREAM_MAX_MS = 15_000;
const STREAM_MAX_BYTES = 4_000_000;
const MAX_TASK_PAGES = 20;
const RESTART_TIMEOUT_MS = 60_000;
/**
 * How long a task may take to show that its stop is confirmed. The server retries a stop that failed
 * with a backoff that grows to minutes, so the wait is minutes too; one request per task per poll
 * stays well under the control rate limit (30 a minute).
 */
const STOP_CONFIRM_POLL_MS = 5_000;
const STOP_CONFIRM_POLLS = 36;
const ENDED_STATES = ['succeeded', 'failed', 'cancelled'];

export interface LiveSmokeIo {
  fetch?: typeof fetch;
  readTotals?: (path: string, at: number) => JournalTotals;
  /** The run budget kept in the gateway's journal file; the real one by default. */
  runBudget?: {
    enforced: (journalPath: string) => boolean;
    set: (
      journalPath: string,
      inviteId: string,
      budget: RunBudget,
      runId: string,
    ) => { fenced: boolean } | undefined;
    /** False when the run no longer holds the budget. */
    renew: (journalPath: string, inviteId: string, runId: string) => boolean;
    clear: (journalPath: string, inviteId: string, runId: string) => boolean;
  };
  /** How often the run renews its hold on the budget. */
  heartbeatMs?: number;
  /** The id of this run; a fresh one by default. */
  runId?: string;
  openInvites?: (path: string) => Pick<InviteStore, 'limits' | 'setLimits' | 'resolve' | 'close'>;
  run?: (command: readonly string[]) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** How long a stream may stay quiet before what it replayed counts as everything. */
  streamQuietMs?: number;
}

interface FeedFrame {
  event: string;
  data: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function runCommand(command: readonly string[]): Promise<void> {
  const [file, ...args] = command;
  return new Promise((resolve, reject) => {
    if (file === undefined) {
      reject(new Error('the restart command is empty'));
      return;
    }
    // The command's output is dropped: it can carry anything the host prints.
    execFile(file, args, { timeout: RESTART_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      const code = (error as { code?: unknown }).code;
      reject(
        new Error(
          `the restart command failed${typeof code === 'number' || typeof code === 'string' ? ` (${String(code)})` : ''}`,
        ),
      );
    });
  });
}

export function createLiveSmokeDeps(
  settings: SmokeSettings,
  io: LiveSmokeIo = {},
): SmokeDeps & {
  cancelLeftovers(): Promise<number>;
  cancelView(taskId: string): Promise<SmokeTask | undefined>;
} {
  const doFetch = io.fetch ?? fetch;
  const readTotals = io.readTotals ?? readJournalTotals;
  const openInvites = io.openInvites ?? ((path: string) => new InviteStore(path));
  const run = io.run ?? runCommand;
  const now = io.now ?? Date.now;
  const quietMs = io.streamQuietMs ?? STREAM_QUIET_MS;
  const log = io.log ?? (() => {});
  const invitesPath = join(settings.dataDir, 'invites.db');
  const journalPath = join(settings.dataDir, 'gateway-spend.db');
  const auth = { authorization: `Bearer ${settings.token}` };
  let originalDailyUsd: number | undefined;

  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const route = path.split('?')[0] ?? path;
    let response: Response;
    try {
      response = await doFetch(`${settings.url}${path}`, {
        method,
        headers: {
          ...auth,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(`${method} ${route} could not reach the server`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`${method} ${route} answered ${response.status}`), {
        status: response.status,
      });
    }
    if (response.status === 204) return undefined;
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error(`${method} ${route} answered something that is not JSON`);
    }
  };

  /** Everything the conversation's feed replays, read until the stream goes quiet. */
  const feed = async (conversationId: string): Promise<FeedFrame[]> => {
    const route = `/v1/events?conversation=${encodeURIComponent(conversationId)}&after=0`;
    const controller = new AbortController();
    const frames: FeedFrame[] = [];
    const stop = setTimeout(() => controller.abort(), STREAM_MAX_MS);
    try {
      let response: Response;
      try {
        response = await doFetch(`${settings.url}${route}`, {
          headers: { ...auth, accept: 'text/event-stream' },
          signal: controller.signal,
        });
      } catch {
        throw new Error('GET /v1/events could not reach the server');
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`GET /v1/events answered ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let bytes = 0;
      for (;;) {
        let quiet: NodeJS.Timeout | undefined;
        const next = await Promise.race([
          reader.read(),
          new Promise<'quiet'>((resolve) => {
            quiet = setTimeout(() => resolve('quiet'), quietMs);
          }),
        ]).finally(() => clearTimeout(quiet));
        if (next === 'quiet' || next.done) break;
        bytes += next.value.byteLength;
        if (bytes > STREAM_MAX_BYTES) break;
        buffer += decoder.decode(next.value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = parseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (frame) frames.push(frame);
        }
      }
      await reader.cancel().catch(() => {});
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(stop);
      controller.abort();
    }
    return frames;
  };

  const text = (frame: FeedFrame): string | undefined =>
    typeof frame.data.text === 'string' ? frame.data.text : undefined;

  return {
    now,
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    log,

    async startConversation() {
      const body = await request('POST', '/v1/conversations', { title: 'smoke test' });
      const id = isRecord(body) ? body.conversationId : undefined;
      if (typeof id !== 'string' || id === '') throw new Error('no conversation id came back');
      return id;
    },

    async say(conversationId, message) {
      await request('POST', `/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
        text: message,
      });
    },

    async tasks(conversationId) {
      const found: SmokeTask[] = [];
      let after = 0;
      for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
        const body = await request(
          'GET',
          `/v1/conversations/${encodeURIComponent(conversationId)}/tasks?after=${after}`,
        );
        if (!isRecord(body) || !Array.isArray(body.tasks)) {
          throw new Error('the task list has an unexpected shape');
        }
        for (const raw of body.tasks) {
          const task = toTask(raw);
          if (task) found.push(task);
        }
        if (typeof body.next !== 'number') break;
        after = body.next;
      }
      return found;
    },

    async openQuestions(conversationId) {
      const frames = await feed(conversationId);
      const answered = new Set(
        frames
          .filter((frame) => frame.event === 'conductor.answered')
          .map((frame) => frame.data.questionId),
      );
      return frames
        .filter((frame) => frame.event === 'conductor.question')
        .flatMap((frame) => {
          const question = toQuestion(frame.data);
          return question && !answered.has(question.questionId) ? [question] : [];
        });
    },

    async answer(conversationId, questionId, optionId) {
      await request('POST', `/v1/conversations/${encodeURIComponent(conversationId)}/answers`, {
        questionId,
        optionId,
      });
    },

    async transcript(conversationId) {
      const frames = await feed(conversationId);
      return frames
        .filter((frame) => frame.event === 'message.posted' || frame.event === 'conductor.notice')
        .flatMap((frame) => {
          const line = text(frame);
          return line === undefined ? [] : [line];
        });
    },

    async cancel(taskId) {
      await this.cancelView(taskId);
    },

    /**
     * A cancel, and the task as the server answers it. Only this answer carries `treeStopPending`
     * (the task list is read from the log and cannot know that a stream is still being read or a
     * cancel retried), so it is what a stop is confirmed by. Cancelling a task that ended changes
     * nothing but asks again about its tree.
     */
    async cancelView(taskId) {
      const answer = await request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`);
      return isRecord(answer) ? toTask(answer.task) : undefined;
    },

    async restart() {
      await run(settings.restartCommand);
    },

    /**
     * Stops every task of the smoke invite that is still going: what an earlier run left behind.
     * A task counts as stopped only when the server's own answer to a cancel says it ended and that
     * neither its stop nor its tree's is pending: every task of the invite is asked, even one that
     * ended long ago, never skipped on the list's say-so, and a cancel that failed (whatever the answer) is sent again at the next poll. Returns how many
     * tasks were running when this started. A task not confirmed stopped, or a list that cannot be
     * read, is an error: the run must not start beside work it could not stop.
     */
    async cancelLeftovers() {
      const listed = await request('GET', '/v1/conversations');
      const conversations =
        isRecord(listed) && Array.isArray(listed.conversations) ? listed.conversations : [];
      const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const stopped = (task: SmokeTask): boolean =>
        ENDED_STATES.includes(task.state) &&
        task.stopPending !== true &&
        task.treeStopPending !== true;
      const open: Array<SmokeTask & { conversationId: string }> = [];
      for (const conversation of conversations) {
        const id = isRecord(conversation) ? conversation.conversationId : undefined;
        if (typeof id !== 'string') continue;
        for (const task of await this.tasks(id)) {
          // Every task is asked, however long ago it ended: the list cannot show a tree that is still
          // stopping, and the server's flag has no age limit.
          open.push({ ...task, conversationId: id });
        }
      }
      let cancelled = 0;
      const stuck: string[] = [];
      let lastError: string | undefined;
      for (const task of open) {
        const wasRunning = !ENDED_STATES.includes(task.state);
        // After one task could not be stopped the run fails anyway: the rest are asked once, so they
        // are stopped too, and not waited for.
        const polls = stuck.length > 0 ? 0 : STOP_CONFIRM_POLLS;
        let confirmed = false;
        for (let poll = 0; poll <= polls && !confirmed; poll += 1) {
          if (poll > 0) await sleep(STOP_CONFIRM_POLL_MS);
          try {
            const view = await this.cancelView(task.taskId);
            confirmed = view !== undefined && stopped(view);
          } catch (error) {
            // Sent again at the next poll; the cause is kept for the message. A refusal is never taken
            // for a stop: the task list, which cannot show a tree that is still stopping, is not asked.
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        if (!confirmed) stuck.push(task.taskId);
        else if (wasRunning) cancelled += 1;
      }
      if (stuck.length > 0) {
        throw new Error(
          `could not confirm the stop of ${stuck.length} task(s): ${stuck.join(', ')}${
            lastError === undefined ? '' : ` (the last error: ${lastError})`
          }`,
        );
      }
      return cancelled;
    },

    async healthy() {
      try {
        const response = await doFetch(`${settings.url}/healthz`, {
          signal: AbortSignal.timeout(5_000),
        });
        const body: unknown = await response.json();
        return response.ok && isRecord(body) && body.status === 'ok';
      } catch {
        return false;
      }
    },

    async totals(): Promise<SmokeTotals> {
      const journal = readTotals(journalPath, now());
      return {
        taskUsd: journal.taskUsd,
        inviteDayUsd: journal.accountDayUsd.get(settings.inviteId) ?? 0,
        serverDayUsd: journal.serverDayUsd,
      };
    },

    async setDailyCap(usd) {
      const invites = openInvites(invitesPath);
      try {
        if (usd === undefined) {
          if (originalDailyUsd === undefined) return;
          invites.setLimits(settings.inviteId, { dailyUsd: originalDailyUsd });
          log(`  the smoke invite's daily cap is back at $${originalDailyUsd}`);
          originalDailyUsd = undefined;
          return;
        }
        const limits = invites.limits(settings.inviteId);
        if (limits === undefined) throw new Error('the smoke invite is unknown or revoked');
        if (limits.dailyUsd === null) {
          // setLimits cannot clear a cap, so a run that lowered an unset one could not put it back.
          throw new Error(
            'the smoke invite has no daily cap of its own, so it could not be put back; set one first with "cloud-server invite limits"',
          );
        }
        if (originalDailyUsd === undefined) {
          originalDailyUsd = limits.dailyUsd;
          log(
            `  the smoke invite's daily cap was $${limits.dailyUsd}; it is put back at the end of the scenario (if this run is killed, restore it with "cloud-server invite limits")`,
          );
        }
        invites.setLimits(settings.inviteId, { dailyUsd: usd });
      } finally {
        invites.close();
      }
    },
  };
}

function parseFrame(block: string): FeedFrame | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(data.join('\n'));
    return isRecord(parsed) ? { event, data: parsed } : undefined;
  } catch {
    return undefined;
  }
}

function toTask(raw: unknown): SmokeTask | undefined {
  if (!isRecord(raw) || typeof raw.taskId !== 'string' || typeof raw.state !== 'string') {
    return undefined;
  }
  return {
    taskId: raw.taskId,
    state: raw.state,
    ...(typeof raw.parentTaskId === 'string' ? { parentTaskId: raw.parentTaskId } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.costUsd === 'number' ? { costUsd: raw.costUsd } : {}),
    ...(raw.budgetExceeded === true ? { budgetExceeded: true } : {}),
    ...(raw.stopPending === true ? { stopPending: true } : {}),
    ...(raw.treeStopPending === true ? { treeStopPending: true } : {}),
    ...(typeof raw.failureReason === 'string' ? { failureReason: raw.failureReason } : {}),
  };
}

function toQuestion(data: Record<string, unknown>): SmokeQuestion | undefined {
  const { questionId, reason, question, options, recommended, action } = data;
  if (
    typeof questionId !== 'string' ||
    typeof reason !== 'string' ||
    typeof question !== 'string' ||
    typeof recommended !== 'string' ||
    !Array.isArray(options)
  ) {
    return undefined;
  }
  const choices = options.flatMap((option) =>
    isRecord(option) && typeof option.id === 'string' && typeof option.label === 'string'
      ? [{ id: option.id, label: option.label }]
      : [],
  );
  return {
    questionId,
    reason,
    question,
    options: choices,
    recommended,
    ...(isRecord(action) && typeof action.tool === 'string'
      ? { action: { tool: action.tool } }
      : {}),
  };
}

/**
 * Why the run may not start. The caps that count are those of the invite the token belongs to,
 * because that is who the requests are booked to, so the token is resolved first and must be the
 * smoke invite's own: otherwise the caps checked here would be another invite's than the one that
 * spends. The budget is a hard cap only when that invite has a daily cap of its own that is at most
 * the budget, because the gateway refuses requests past that cap while `MAKA_CLOUD_SMOKE_MAX_USD`
 * only keeps a scenario from starting once the server has spent it.
 */
export function smokeCapProblem(settings: SmokeSettings, io: LiveSmokeIo): string | undefined {
  const openInvites = io.openInvites ?? ((path: string) => new InviteStore(path));
  let owner: string | undefined;
  let limits: ReturnType<Pick<InviteStore, 'limits'>['limits']>;
  try {
    const invites = openInvites(join(settings.dataDir, 'invites.db'));
    try {
      owner = invites.resolve(settings.token)?.inviteId;
      limits = invites.limits(settings.inviteId);
    } finally {
      invites.close();
    }
  } catch {
    return 'the invites file in MAKA_CLOUD_DATA_DIR could not be read';
  }
  if (owner === undefined) {
    return 'MAKA_CLOUD_SMOKE_TOKEN is not the token of an active invite in MAKA_CLOUD_DATA_DIR';
  }
  if (owner !== settings.inviteId) {
    return 'MAKA_CLOUD_SMOKE_TOKEN belongs to another invite than MAKA_CLOUD_SMOKE_INVITE_ID, so the caps checked would not be the ones that spend';
  }
  if (limits === undefined) {
    return 'MAKA_CLOUD_SMOKE_INVITE_ID names no invite in MAKA_CLOUD_DATA_DIR, or it was revoked';
  }
  if (limits.dailyUsd === null) {
    return 'the smoke invite has no daily cap of its own, so its spending is not limited by this budget; set one with "cloud-server invite limits --daily"';
  }
  if (limits.dailyUsd > settings.maxUsd) {
    return `the smoke invite's daily cap ($${limits.dailyUsd}) is above MAKA_CLOUD_SMOKE_MAX_USD ($${settings.maxUsd}), so the budget would not be a hard cap; lower the cap with "cloud-server invite limits --daily" or raise the budget`;
  }
  return undefined;
}

/**
 * `maka-cloud smoke`. The gate comes first: without `MAKA_CLOUD_LIVE=1` and every setting nothing
 * is read, opened or sent, and the exit code is 2.
 */
export async function smokeCommand(
  env: NodeJS.ProcessEnv,
  io: LiveSmokeIo & { print?: (line: string) => void } = {},
): Promise<number> {
  const print = io.print ?? ((line: string) => console.log(line));
  const gate = smokeGate(env);
  if (!gate.ok) {
    for (const problem of gate.problems) print(problem);
    return 2;
  }
  const { settings } = gate;
  const problem = smokeCapProblem(settings, io);
  if (problem !== undefined) {
    print(problem);
    return 2;
  }
  const budgets = io.runBudget ?? {
    enforced: journalEnforcesRunBudgets,
    set: setRunBudget,
    renew: renewRunBudget,
    clear: clearRunBudget,
  };
  const journalPath = join(settings.dataDir, 'gateway-spend.db');
  const runId = io.runId ?? randomUUID();
  // From here the gateway journal refuses the smoke invite's bookings, from any process, once what it
  // has booked since now reaches the budget, whatever the UTC day and whether or not the server
  // restarts in between. One run holds an invite's budget at a time, so two runs cannot overwrite
  // each other's cap.
  let fenced = false;
  try {
    fenced =
      budgets.set(
        journalPath,
        settings.inviteId,
        { limitUsd: settings.maxUsd, sinceMs: Date.now() },
        runId,
      )?.fenced === true;
  } catch (error) {
    print(
      error instanceof RunBudgetHeld
        ? 'another smoke run holds the run budget of this invite: wait for it to end (or about two minutes after it was killed), then run again'
        : 'the run budget could not be set in the gateway journal, so nothing was started',
    );
    return 2;
  }
  // The budget is only a cap if the journal file itself enforces it; if that cannot be seen, nothing starts.
  let enforced = false;
  try {
    enforced = budgets.enforced(journalPath);
  } catch {
    // Unreadable is as good as not enforced.
  }
  if (!enforced) {
    try {
      budgets.clear(journalPath, settings.inviteId, runId);
    } catch {
      // The budget stays and limits the invite until the next run takes it over.
    }
    print(
      'the gateway journal does not enforce the run budget, so nothing was started: check that the server and this command run the same version',
    );
    return 2;
  }
  let lost = false;
  const heartbeat = setInterval(
    () => {
      try {
        if (!budgets.renew(journalPath, settings.inviteId, runId)) lost = true;
      } catch {
        // A renewal that could not be written is tried again; the lease outlasts a few misses.
      }
    },
    io.heartbeatMs ?? RUN_LEASE_MS / 4,
  );
  heartbeat.unref();
  try {
    print(`smoke test of ${settings.url} as ${settings.inviteId}, budget $${settings.maxUsd}`);
    const deps = createLiveSmokeDeps(settings, { ...io, log: io.log ?? print });
    if (fenced) {
      // The earlier run's gateway keys and conductor sessions book nothing from now on (the
      // budget's generation moved).
      print('took over the run budget of an earlier run: its credentials are fenced');
    }
    // Whatever an earlier run left going is stopped before anything starts, every time: a run that
    // could not stop it cleared its budget on the way out, so the next run no longer sees a takeover
    // and the budget cannot be the memory of that debt.
    try {
      const cancelled = await deps.cancelLeftovers();
      if (cancelled > 0) print(`cancelled ${cancelled} task(s) an earlier run left running`);
    } catch (error) {
      // They may still hold sandboxes and change the repository the run is about to use: nothing
      // starts beside them.
      print(
        `could not stop what an earlier run left running (${error instanceof Error ? error.message : 'unknown error'}), so nothing was started: cancel those tasks, then run again`,
      );
      return 2;
    }
    const report = await runSmoke(deps, { repo: settings.repo, maxUsd: settings.maxUsd });
    for (const line of formatSmokeReport(report)) print(line);
    if (lost) {
      print(
        'the run budget was taken over by another run while this one was going, so its cap did not hold for the whole run: treat this result as not valid',
      );
      return 1;
    }
    return report.ok ? 0 : 1;
  } finally {
    clearInterval(heartbeat);
    try {
      // Only this run's own budget: another run's is never touched.
      budgets.clear(journalPath, settings.inviteId, runId);
    } catch {
      // A run that is killed leaves the budget too: the invite stays capped until the next run takes it over.
      print('the run budget could not be cleared; it stays until the next smoke run takes it over');
    }
  }
}
