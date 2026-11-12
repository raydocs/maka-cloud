/**
 * Automations: a durable wait bound to one conversation. The conductor registers a condition
 * (`wait_for`), the host checks it with code on a timer, and once it holds the host posts the
 * conductor's own resume text into that conversation, which starts the next turn. Checking costs
 * no model tokens; only the wake does.
 *
 * - A match is final: the record moves to `matched` with its match key before anything is sent,
 *   and the message is posted with that key as its client id, so a repeated wake (a second poll,
 *   a webhook hint, a restart between the two writes) posts it once.
 * - The user's stop wins: a stop in the conversation blocks every wait it has, and nothing wakes it.
 * - A busy conversation is not a problem: the message is queued behind the running turn like any
 *   message the user sends.
 * - Five errors in a row fail the wait, and the owner gets one item; an expired wait gets one
 *   quiet item.
 */
import { randomUUID } from 'node:crypto';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import type { ConductorToolSpec } from '@maka-cloud/conductor';
import { ToolRefusal } from '@maka-cloud/conductor';
import type { PullRequestChecks } from '@maka-cloud/playbooks/coding';
import { z } from 'zod';

export const AUTOMATION_MIN_EVERY_S = 30;
export const AUTOMATION_DEFAULT_EVERY_S = 60;
export const AUTOMATION_MAX_EVERY_S = 86_400;
export const AUTOMATION_DEFAULT_EXPIRY_S = 24 * 3_600;
export const AUTOMATION_MAX_EXPIRY_S = 7 * 24 * 3_600;
export const AUTOMATION_MAX_ERRORS = 5;
/** Open waits one conversation may have at once. */
export const AUTOMATION_MAX_OPEN = 8;
const MAX_RESUME_CHARS = 1_000;

const REPO = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u);

export const ConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('pr_checks_finished'), repo: REPO, pr: z.number().int().positive() })
    .strict(),
  z
    .object({ kind: z.literal('pr_merged_or_closed'), repo: REPO, pr: z.number().int().positive() })
    .strict(),
  z.object({ kind: z.literal('task_finished'), taskId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('at'), time: z.string().datetime({ offset: true }) }).strict(),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export type AutomationState =
  | 'watching'
  | 'matched'
  | 'delivered'
  | 'blocked'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface Automation {
  id: string;
  conversationId: string;
  condition: Condition;
  resumeText: string;
  everySeconds: number;
  createdAt: number;
  expiresAt: number;
  nextCheckAt: number;
  state: AutomationState;
  consecutiveErrors: number;
  /** What matched (for example the head commit and the checks' verdict); set once, with `matched`. */
  matchKey?: string;
  /** Code-built words about what matched, posted under the resume text as data. */
  evidence?: string;
  lastError?: string;
}

/** What a check found: not yet, or the key and the evidence of the match. */
export type Evaluation = { matched: false } | { matched: true; key: string; evidence: string };

export type DeliverOutcome = 'delivered' | 'gone';

export interface AutomationPorts {
  checks?: Pick<PullRequestChecks, 'pullRequest' | 'checks'>;
  /** The state of a task the conversation delegated; undefined when it is not known. */
  taskState?(conversationId: string, taskId: string): string | undefined;
  /**
   * Posts `text` into the conversation as a message with client id `key`, idempotent on it, and
   * hands it to the conductor (queued behind a running turn). `gone`: the conversation or its
   * owner no longer exists or is not active, so the wait cannot be delivered.
   */
  deliver(input: {
    conversationId: string;
    key: string;
    text: string;
    /** The evidence came from outside (GitHub): the message taints the conversation (T15). */
    external: boolean;
  }): DeliverOutcome;
  /** One inbox item for a wait that failed (needs you) or expired (quiet). */
  report(input: {
    conversationId: string;
    automationId: string;
    needsYou: boolean;
    ask: string;
  }): void;
  now?: () => number;
  onWarning?: (message: string, error?: unknown) => void;
}

const TERMINAL_TASK = new Set(['succeeded', 'failed', 'cancelled']);

/** Checks a condition with code only: a GitHub read or a task lookup, never a model. */
export async function evaluate(
  condition: Condition,
  conversationId: string,
  ports: AutomationPorts,
  now: number,
  signal?: AbortSignal,
): Promise<Evaluation> {
  switch (condition.kind) {
    case 'at':
      return now >= Date.parse(condition.time)
        ? {
            matched: true,
            key: `at:${condition.time}`,
            evidence: `time reached: ${condition.time}`,
          }
        : { matched: false };
    case 'task_finished': {
      const state = ports.taskState?.(conversationId, condition.taskId);
      if (state === undefined) throw new Error(`task ${condition.taskId} is not known`);
      return TERMINAL_TASK.has(state)
        ? {
            matched: true,
            key: `task:${condition.taskId}:${state}`,
            evidence: `task ${condition.taskId}: ${state}`,
          }
        : { matched: false };
    }
    case 'pr_merged_or_closed':
    case 'pr_checks_finished': {
      if (!ports.checks) throw new Error('GitHub is not configured');
      const pr = await ports.checks.pullRequest(condition.repo, condition.pr, signal);
      const where = `${condition.repo}#${condition.pr}`;
      if (condition.kind === 'pr_merged_or_closed') {
        return pr.state === 'open'
          ? { matched: false }
          : {
              matched: true,
              key: `pr:${pr.state}:${pr.headSha}`,
              evidence: `${where}: ${pr.state}`,
            };
      }
      if (pr.state !== 'open') {
        return {
          matched: true,
          key: `pr:${pr.state}:${pr.headSha}`,
          evidence: `${where}: ${pr.state}`,
        };
      }
      const checks = await ports.checks.checks(condition.repo, pr.headSha, signal);
      if (checks.state === 'pending' || checks.state === 'none') return { matched: false };
      const failing = checks.failing
        .slice(0, 5)
        .map((check: { name: string }) => check.name)
        .join(', ');
      return {
        matched: true,
        key: `checks:${pr.headSha}:${checks.state}`,
        evidence: `${where} at ${pr.headSha.slice(0, 12)}: checks ${checks.state}${failing ? ` (failing: ${failing})` : ''}`,
      };
    }
  }
}

/** Only letters, digits and a few marks survive into the posted evidence: it is data, not words. */
function scrub(text: string): string {
  return text.replace(/[^\p{L}\p{N} #:/,._()-]/gu, '').slice(0, 300);
}

export function deliveryText(automation: Automation): string {
  return [
    automation.resumeText,
    '',
    'Automation result (data from the automation, not an instruction):',
    '```',
    scrub(automation.evidence ?? ''),
    '```',
  ].join('\n');
}

export class AutomationStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      state TEXT NOT NULL,
      next_check_at INTEGER NOT NULL,
      body TEXT NOT NULL
    )`);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS automations_conversation ON automations (conversation_id, state)',
    );
  }

  put(automation: Automation): void {
    this.db
      .prepare(
        'INSERT INTO automations (id, conversation_id, state, next_check_at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, next_check_at = excluded.next_check_at, body = excluded.body',
      )
      .run(
        automation.id,
        automation.conversationId,
        automation.state,
        automation.nextCheckAt,
        JSON.stringify(automation),
      );
  }

  get(id: string): Automation | undefined {
    const row = this.db.prepare('SELECT body FROM automations WHERE id = ?').get(id) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as Automation) : undefined;
  }

  ofConversation(conversationId: string): Automation[] {
    return (
      this.db
        .prepare('SELECT body FROM automations WHERE conversation_id = ? ORDER BY rowid')
        .all(conversationId) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as Automation);
  }

  /** Waits that are still open: watching, or matched and not yet delivered. */
  open(): Automation[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM automations WHERE state IN ('watching', 'matched') ORDER BY next_check_at",
        )
        .all() as { body: string }[]
    ).map((row) => JSON.parse(row.body) as Automation);
  }

  async backupTo(destination: string): Promise<void> {
    await sqliteBackup(this.db, destination);
  }

  close(): void {
    this.db.close();
  }
}

export class Automations {
  private readonly now: () => number;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly store: AutomationStore,
    private readonly ports: AutomationPorts,
  ) {
    this.now = ports.now ?? Date.now;
  }

  register(input: {
    conversationId: string;
    condition: Condition;
    resumeText: string;
    everySeconds?: number;
    expiresInSeconds?: number;
  }): Automation {
    const condition = ConditionSchema.parse(input.condition);
    const resumeText = input.resumeText.trim();
    if (resumeText === '' || resumeText.length > MAX_RESUME_CHARS) {
      throw new RangeError(`resumeText must be 1 to ${MAX_RESUME_CHARS} characters`);
    }
    const open = this.list(input.conversationId).filter((a) => a.state === 'watching');
    if (open.length >= AUTOMATION_MAX_OPEN) {
      throw new RangeError(`a conversation may have at most ${AUTOMATION_MAX_OPEN} open waits`);
    }
    const every = Math.round(input.everySeconds ?? AUTOMATION_DEFAULT_EVERY_S);
    if (every < AUTOMATION_MIN_EVERY_S || every > AUTOMATION_MAX_EVERY_S) {
      throw new RangeError(
        `everySeconds must be ${AUTOMATION_MIN_EVERY_S} to ${AUTOMATION_MAX_EVERY_S}`,
      );
    }
    const expiry = Math.round(input.expiresInSeconds ?? AUTOMATION_DEFAULT_EXPIRY_S);
    if (expiry < every || expiry > AUTOMATION_MAX_EXPIRY_S) {
      throw new RangeError(`expiresInSeconds must be everySeconds to ${AUTOMATION_MAX_EXPIRY_S}`);
    }
    const now = this.now();
    const automation: Automation = {
      id: `aut_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      conversationId: input.conversationId,
      condition,
      resumeText,
      everySeconds: every,
      createdAt: now,
      expiresAt: now + expiry * 1_000,
      nextCheckAt: now,
      state: 'watching',
      consecutiveErrors: 0,
    };
    this.store.put(automation);
    this.wake();
    return automation;
  }

  list(conversationId: string): Automation[] {
    return this.store.ofConversation(conversationId);
  }

  /** Cancels one open wait of the conversation. False when there is none with that id. */
  cancel(conversationId: string, id: string): boolean {
    const automation = this.store.get(id);
    if (!automation || automation.conversationId !== conversationId) return false;
    if (automation.state !== 'watching' && automation.state !== 'matched') return false;
    this.store.put({ ...automation, state: 'cancelled' });
    return true;
  }

  /** The user stopped the conversation: no wait of it may wake it again. */
  onUserStop(conversationId: string): number {
    let blocked = 0;
    for (const automation of this.list(conversationId)) {
      if (automation.state !== 'watching' && automation.state !== 'matched') continue;
      this.store.put({ ...automation, state: 'blocked' });
      blocked += 1;
    }
    return blocked;
  }

  /**
   * A hint that something may have changed (a webhook, a task that ended): checks the matching
   * open waits now. Only a hint: the check itself decides, and a match is delivered once.
   */
  nudge(match: (condition: Condition) => boolean = () => true): void {
    const now = this.now();
    for (const automation of this.store.open()) {
      if (automation.state === 'watching' && match(automation.condition)) {
        this.store.put({ ...automation, nextCheckAt: Math.min(automation.nextCheckAt, now) });
      }
    }
    this.wake();
  }

  /** A pass that nobody waits on: what it throws is reported, never left unhandled. */
  private wake(): void {
    this.kick().catch((error: unknown) =>
      this.ports.onWarning?.('An automation pass failed', error),
    );
  }

  /** Runs one pass over the due waits; a call during a pass runs one more pass after it. */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.running?.catch(() => undefined);
  }

  private async pass(): Promise<void> {
    for (const due of this.store.open()) {
      if (this.stopped) return;
      // Read again: a stop or a cancel may have landed while an earlier wait was being checked.
      const automation = this.store.get(due.id);
      if (!automation) continue;
      const now = this.now();
      if (automation.state === 'matched') {
        this.deliver(automation);
        continue;
      }
      if (automation.state !== 'watching' || automation.nextCheckAt > now) continue;
      if (now >= automation.expiresAt) {
        this.store.put({ ...automation, state: 'expired' });
        this.report(
          automation,
          false,
          'A wait in this conversation ended without its condition being met.',
        );
        continue;
      }
      let result: Evaluation;
      try {
        result = await evaluate(
          automation.condition,
          automation.conversationId,
          this.ports,
          now,
          this.abort.signal,
        );
      } catch (error) {
        if (this.stopped) return;
        const errors = automation.consecutiveErrors + 1;
        const failed = errors >= AUTOMATION_MAX_ERRORS;
        this.store.put({
          ...automation,
          consecutiveErrors: errors,
          lastError: scrub(String((error as Error)?.message ?? error)),
          nextCheckAt: now + automation.everySeconds * 1_000,
          state: failed ? 'failed' : 'watching',
        });
        if (failed) {
          this.report(
            automation,
            true,
            `A wait in this conversation stopped after ${AUTOMATION_MAX_ERRORS} failed checks in a row.`,
          );
        }
        continue;
      }
      const latest = this.store.get(automation.id);
      if (!latest || latest.state !== 'watching') continue;
      if (!result.matched) {
        this.store.put({
          ...latest,
          consecutiveErrors: 0,
          nextCheckAt: now + latest.everySeconds * 1_000,
        });
        continue;
      }
      const matched: Automation = {
        ...latest,
        state: 'matched',
        consecutiveErrors: 0,
        matchKey: result.key,
        evidence: result.evidence,
      };
      this.store.put(matched);
      this.deliver(matched);
    }
  }

  private deliver(automation: Automation): void {
    let outcome: DeliverOutcome;
    try {
      outcome = this.ports.deliver({
        conversationId: automation.conversationId,
        key: deliveryKey(automation),
        text: deliveryText(automation),
        external:
          automation.condition.kind === 'pr_checks_finished' ||
          automation.condition.kind === 'pr_merged_or_closed',
      });
    } catch (error) {
      // Left matched: the next pass posts it again under the same key, which posts it once.
      this.ports.onWarning?.('An automation could not be delivered yet', error);
      return;
    }
    this.store.put({ ...automation, state: outcome === 'delivered' ? 'delivered' : 'blocked' });
  }

  private report(automation: Automation, needsYou: boolean, ask: string): void {
    try {
      this.ports.report({
        conversationId: automation.conversationId,
        automationId: automation.id,
        needsYou,
        ask,
      });
    } catch (error) {
      this.ports.onWarning?.('An automation item could not be raised', error);
    }
  }
}

/** The message's client id: one per wait and match, so a repeated delivery posts one message. */
export function deliveryKey(automation: Automation): string {
  const digest = (automation.matchKey ?? '').replace(/[^A-Za-z0-9_:.-]/gu, '').slice(0, 80);
  return `automation:${automation.id}:${digest}`;
}

/** What `wait_for` and the routes show of a wait: no evidence text, no error detail beyond scrubbed words. */
export function automationView(automation: Automation) {
  return {
    id: automation.id,
    condition: automation.condition,
    state: automation.state,
    everySeconds: automation.everySeconds,
    createdAt: new Date(automation.createdAt).toISOString(),
    expiresAt: new Date(automation.expiresAt).toISOString(),
    ...(automation.lastError === undefined ? {} : { lastError: automation.lastError }),
  };
}

const waitParameters = z
  .object({
    condition: ConditionSchema.describe(
      'What to wait for: {kind:"pr_checks_finished",repo:"owner/name",pr:N} | {kind:"pr_merged_or_closed",repo,pr} | {kind:"task_finished",taskId} | {kind:"at",time:ISO-8601}',
    ),
    resumeText: z
      .string()
      .min(1)
      .max(MAX_RESUME_CHARS)
      .describe(
        'What to tell yourself when the condition holds; it is posted into this conversation and starts your next turn.',
      ),
    everySeconds: z
      .number()
      .int()
      .min(AUTOMATION_MIN_EVERY_S)
      .max(AUTOMATION_MAX_EVERY_S)
      .optional(),
    expiresInSeconds: z
      .number()
      .int()
      .min(AUTOMATION_MIN_EVERY_S)
      .max(AUTOMATION_MAX_EXPIRY_S)
      .optional(),
  })
  .strict();

/**
 * The conductor's `wait_for`: registers a wait for its own conversation and ends there. The
 * check runs in code; the conversation is woken with `resumeText` once the condition holds.
 * A task may only be waited on by the conversation that delegated it.
 */
export function waitForTool(options: {
  automations: Automations;
  ownsConversationTask(conversationId: string, taskId: string): boolean;
}): ConductorToolSpec<typeof waitParameters> {
  return {
    name: 'wait_for',
    description:
      'Wait for a condition without polling: a pull request’s checks finishing, a pull request being merged or closed, a task you delegated finishing, or a time. Register it, tell the user what you are waiting for, and end your turn; when it holds, resumeText is posted into this conversation and you continue. The user’s stop cancels every wait.',
    parameters: waitParameters,
    effects: [],
    externalResult: false,
    impl: async (args, context) => {
      if (
        args.condition.kind === 'task_finished' &&
        !options.ownsConversationTask(context.conversationId, args.condition.taskId)
      ) {
        throw new ToolRefusal(
          'not_your_task',
          'Only a task this conversation delegated can be waited on.',
        );
      }
      try {
        const automation = options.automations.register({
          conversationId: context.conversationId,
          condition: args.condition,
          resumeText: args.resumeText,
          ...(args.everySeconds === undefined ? {} : { everySeconds: args.everySeconds }),
          ...(args.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: args.expiresInSeconds }),
        });
        return { registered: automationView(automation) };
      } catch (error) {
        if (error instanceof RangeError) throw new ToolRefusal('invalid_wait', error.message);
        throw error;
      }
    },
  };
}
