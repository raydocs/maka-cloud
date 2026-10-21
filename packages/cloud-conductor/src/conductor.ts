import { join } from 'node:path';
import type { SessionEvent } from '@maka/core/events';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { isModeId, type ModeId, type ModesConfig } from '@maka-cloud/modes';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import {
  type ConductorLimits,
  DEFAULT_LIMITS,
  type ModelAccess,
  type ModelCharge,
  type ModelPrices,
  OPUS_5_5_PRICES,
} from './config.js';
import { isRunAuthority, playbookToolPolicy, type RunAuthority } from './guard.js';
import { MakaHost } from './maka-host.js';
import { type ConductorAccess, OrchestratorLink } from './orchestrator-link.js';
import type {
  ConductorOutbox,
  OutboxAnswered,
  OutboxMessage,
  OutboxNotice,
  OutboxQuestion,
} from './outbox.js';
import { DEFAULT_PLAYBOOKS, type Playbook } from './playbooks.js';
import { callCostUsd } from './pricing.js';
import { conductorSystemPrompt, PLANNER_SYSTEM_PROMPT, plannerInput } from './prompts.js';
import {
  ConductorState,
  type DelegationRow,
  OPEN_RUN_STATES,
  type OutboxRow,
  type QuestionRow,
  type RunRow,
} from './state.js';
import {
  type ActiveTurn,
  type ConductorToolSpec,
  conductorTools,
  type ToolHost,
  ToolRefusal,
} from './tools.js';

export interface ConductorOptions {
  /** Directory for the conductor's database and Maka's storage. One process owns it. */
  root: string;
  access: ModelAccess;
  outbox: ConductorOutbox;
  /**
   * The orchestrator access of a conversation when no message has brought it
   * in this process: used to retry cancels a shutdown or crash left undone.
   */
  orchestratorAccess?: (conversationId: string) => ConductorAccess | undefined;
  /**
   * The orchestrator keeps its tasks across a restart (it resumes them, or ends them itself when
   * their runner cannot). With it, neither a shutdown nor a crash cancels the tasks the conductor
   * delegated: they stay reserved against their run's budget, and the conductor asks about them
   * until each has ended, then settles it. A delegation whose task the conductor never learned of
   * (the response was lost) is still cancelled by its key. A user's stop and the operator's pause
   * cancel as before. Default false: every task not known to have ended is cancelled.
   */
  tasksSurviveRestart?: boolean;
  /**
   * Cleans a task's own words (its title, summary or failure reason) before the conductor puts
   * them in a message of its own, as when it tells the user a task ended that a restart left
   * without a turn. Without it those messages carry no task words at all.
   */
  scrubTaskText?: (text: string) => string;
  /**
   * Whether a text carries a key or token. An approval binds its card word for word (T15), so a
   * card that carries one is not asked: the owner cannot be shown it and it cannot be edited.
   * The host sets it from the server's scrubber; without it no card is checked.
   */
  carriesSecret?: (text: string) => boolean;
  playbooks?: readonly Playbook[];
  /**
   * The modes (T25): how hard the conductor and its planner think, what a delegation may cost,
   * and which mode a task runs in. Without it there are no modes: nothing is added to a brief.
   */
  modes?: ModesConfig;
  /**
   * Appended once to each new durable user turn, never to the system prompt or old history. It
   * taints the conversation (T15) unless it says `external: false`; a non-empty string always does.
   */
  turnContext?: (conversationId: string) => string | TurnContext;
  /** Tools playbooks add; `irreversible` ones are held for approval. */
  tools?: readonly ConductorToolSpec[];
  limits?: Partial<ConductorLimits>;
  prices?: ModelPrices;
  now?: () => number;
  /** Reports what must not stop the conductor: an outbox that threw, a cancel that failed. */
  onWarning?: (message: string, detail?: unknown) => void;
  /**
   * Whether the one who approved an irreversible call (`UserAnswer.caller`;
   * null when the answer carried none) may still have it run. Asked right
   * before the approved call runs, in the transaction that uses the approval.
   * Without it every approval stands.
   */
  approverAuthorized?: (approvedBy: string | null, conversationId: string) => boolean;
  /** Test seams. */
  hooks?: {
    /** After a turn is registered and before its message is sent. */
    beforeSend?(turn: { runId: string; conversationId: string }): Promise<void>;
    /** Hands over the turn's timeout, so a test can fire it at a chosen point. */
    turnTimer?(fire: () => void): void;
    /** When a conversation's outbox is found empty, before its sender is released. */
    outboxDrained?(conversationId: string): void;
    /** After a pass that asked about a conversation's followed tasks. */
    followed?(conversationId: string): void;
  };
}

/** Text added to a turn, and whether it can carry content from outside the user (T15). */
export interface TurnContext {
  text: string;
  external: boolean;
}

export interface UserMessage {
  conversationId: string;
  messageId: string;
  text: string;
  /**
   * The text comes from outside the user (an issue or comment someone else wrote): the
   * conversation is tainted before the message is admitted, and stays tainted (T15).
   */
  external?: boolean;
  /**
   * The mode the user picked (T25). It applies when this message starts a run, and then it is
   * the run's mode: the model cannot choose another. Anything but a mode id starts no run.
   */
  mode?: string;
  /**
   * Set only by a standing duty (T23): the run this message starts has this authority and this
   * hard budget, which it cannot raise or ask to raise. It applies when the message starts a run;
   * a message that joins a run already open changes nothing about it.
   */
  run?: { dutyId: string; authority: RunAuthority; budgetUsd: number };
}

export interface UserAnswer {
  conversationId: string;
  questionId: string;
  optionId: string;
  /** Optional words the user added to the chosen option; passed to the model with it. */
  text?: string;
  /** Who answered, as the server names them (an invite id). Recorded with an approval. */
  caller?: string;
}

export const MAX_ANSWER_TEXT_LENGTH = 4000;

/**
 * Answers are idempotent per question: the same option again is accepted as a
 * duplicate and changes nothing; a different option is a conflict.
 */
export type AnswerOutcome =
  | { accepted: true; duplicate: boolean }
  | {
      accepted: false;
      reason: 'not_found' | 'not_open' | 'unknown_option' | 'conflict' | 'closed' | 'text_too_long';
    };

export interface ConductorStats {
  /** Runs holding a slot. */
  runningTurns: number;
  /** Turns waiting for a slot. */
  waitingForSlot: number;
  /** Inputs queued behind a running turn. */
  queued: number;
  planners: number;
  timers: number;
  openClients: number;
  /** Conversations whose outbox events are being sent. */
  outboxSending: number;
  /** Conversations waiting to retry an outbox event that failed. */
  outboxRetrying: number;
  /** Conversations waiting to ask again about tasks whose stop is not confirmed. */
  stopChecks: number;
}

/**
 * `gated`: a model request was refused before it was sent (budget spent or
 * blocked, a question open, the run ended); the turn ends without a failure.
 */
type StopReason = 'user' | 'timeout' | 'shutdown' | 'refusals' | 'gated';

interface Turn extends ActiveTurn {
  readonly makaSessionId: string;
  readonly controller: AbortController;
  refusals: number;
  stopReason?: StopReason;
  /** Settles once Maka has been told to stop. */
  stopping?: Promise<void>;
  /** Planner sessions running for this turn. */
  readonly planners: Set<string>;
  /** Text since the last tool call: the delivery. */
  finalText: string[];
  errors: string[];
  /** The model adapter's machine-readable kind for the last error (`rate_limit`, `auth`, ...); unset when the error was thrown. */
  errorKind?: string;
  /** Whether the turn called any tool: a failed run that did is never retried by a duty. */
  sawTool: boolean;
  completeReason?: string;
  /**
   * Whether the conversation was tainted when this turn's last conductor model request was sent:
   * the context the model decided its tool calls on (T15). Unset before the first request.
   */
  contextTainted?: boolean;
}

type Job =
  | { kind: 'turn'; runId: string; text: string }
  | { kind: 'cancel_tasks'; runId: string }
  /** Retries the conversation's cancels that have not succeeded yet. */
  | { kind: 'cancel_pending'; runId?: undefined }
  /** Asks the orchestrator how the conversation's followed tasks are doing. */
  | { kind: 'follow_tasks'; runId?: undefined };

interface Lane {
  readonly conversationId: string;
  access?: ConductorAccess;
  queue: Job[];
  pump?: Promise<void>;
  current?: Turn;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * Turns one user message into a playbook run on a Maka session, delegating
 * through the T2 orchestrator. Implements the cloud server's
 * `ConversationHandler` (`onUserMessage`).
 *
 * Every run holds a slot, an abort controller, a timer and an orchestrator
 * client; one `finally` gives all of them back, whichever way the turn ends.
 */
export class Conductor {
  readonly state: ConductorState;
  private readonly host: MakaHost;
  private readonly outbox: ConductorOutbox;
  private readonly playbooks: readonly Playbook[];
  private readonly modes: ModesConfig | undefined;
  private readonly limits: ConductorLimits;
  private readonly prices: ModelPrices;
  private readonly now: () => number;
  private readonly warn: (message: string, detail?: unknown) => void;
  private readonly hooks: NonNullable<ConductorOptions['hooks']>;
  private readonly turnContext: ConductorOptions['turnContext'];
  private readonly lanes = new Map<string, Lane>();
  private readonly turns = new Map<string, Turn>();
  private readonly plannerTurns = new Map<string, Turn>();
  /** Model requests the gateway reserved and has not settled yet, by its request key. */
  private readonly requestHolds = new Map<string, { runId: string; reservation: number }>();
  private readonly tokens = new Map<string, string>();
  private readonly counters = { openClients: 0, timers: 0, planners: 0 };
  private readonly closing = new AbortController();
  private readonly orchestratorAccess: ConductorOptions['orchestratorAccess'];
  private readonly approverAuthorized: ConductorOptions['approverAuthorized'];
  private readonly sending = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly stopChecks = new Map<string, NodeJS.Timeout>();
  private readonly followTimers = new Map<string, NodeJS.Timeout>();
  /** How long the conversation's followed tasks were last left alone; doubles up to a cap. */
  private readonly followDelays = new Map<string, number>();
  private readonly tasksSurviveRestart: boolean;
  private readonly scrubTaskText: ((text: string) => string) | undefined;
  private readonly carriesSecret: ((text: string) => boolean) | undefined;
  private slotsInUse = 0;
  private readonly slotWaiters: Array<{ grant: () => void; refuse: (error: Error) => void }> = [];
  private closed: Promise<void> | undefined;

  private constructor(options: ConductorOptions) {
    // A tool without a valid T15 policy is refused before anything is opened.
    for (const spec of options.tools ?? []) playbookToolPolicy(spec);
    this.now = options.now ?? Date.now;
    this.state = new ConductorState(join(options.root, 'conductor.db'), this.now);
    this.outbox = options.outbox;
    this.playbooks = options.playbooks ?? DEFAULT_PLAYBOOKS;
    this.modes = options.modes;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.prices = options.prices ?? OPUS_5_5_PRICES;
    this.warn = options.onWarning ?? (() => undefined);
    this.hooks = options.hooks ?? {};
    this.turnContext = options.turnContext;
    this.orchestratorAccess = options.orchestratorAccess;
    this.tasksSurviveRestart = options.tasksSurviveRestart === true;
    this.scrubTaskText = options.scrubTaskText;
    this.carriesSecret = options.carriesSecret;
    this.approverAuthorized = options.approverAuthorized;
    const tools = conductorTools(this.toolHost(), options.tools);
    this.host = new MakaHost({
      root: join(options.root, 'maka'),
      access: options.access,
      state: this.state,
      toolsFor: (kind) => (kind === 'conductor' ? tools : []),
      onModelCall: (makaSessionId, attempt) => this.meter(makaSessionId, attempt),
      beforeModelRequest: (makaSessionId) => this.gateModelRequest(makaSessionId),
      chargeFor: (makaSessionId) => this.modelCharge(makaSessionId),
      now: this.now,
    });
  }

  /**
   * Opens the conductor over its root. Runs a previous process left active are
   * ended as interrupted and their users are told; runs waiting for an answer
   * keep waiting. No turn runs yet, so every task not known to have ended is
   * cancelled: those a shutdown could not cancel, and all of them after a
   * crash. Outbox events not acked yet are sent again.
   */
  static async create(options: ConductorOptions): Promise<Conductor> {
    // Fail closed: no gateway means no worst-case reservation before a request, so no start.
    if (!options.access.gateway && options.access.unmeteredTestAccess !== true) {
      throw new Error('The conductor needs the model gateway to call a model.');
    }
    const conductor = new Conductor(options);
    try {
      for (const run of conductor.state.runsInState('active')) {
        conductor.state.endRun(
          run.runId,
          'interrupted',
          'restart',
          'This run was interrupted by a restart. Send the request again to start over.',
        );
      }
      // A task the orchestrator keeps is followed, not cancelled. One the conductor never learned
      // of cannot be followed (it has no id), so its key is cancelled either way.
      conductor.state.markCancelPending(
        conductor.state
          .unsettledDelegations()
          .filter((delegation) => !conductor.tasksSurviveRestart || delegation.taskId === null)
          .map((delegation) => delegation.key),
      );
      conductor.state.settleOpenModelRequests();
      await conductor.host.recoverInterrupted();
    } catch (error) {
      await conductor.host.close().catch(() => undefined);
      conductor.state.close();
      throw error;
    }
    for (const conversationId of conductor.state.conversationsWithPendingCancels()) {
      const access = conductor.orchestratorAccess?.(conversationId);
      // Taking the access queues the retry.
      if (access) conductor.lane(conversationId, access);
    }
    if (conductor.tasksSurviveRestart) {
      for (const conversationId of conductor.state.conversationsWithFollowedTasks()) {
        conductor.followLater(conversationId, 0);
      }
    }
    for (const conversationId of conductor.state.outboxConversations()) {
      conductor.sendOutbox(conversationId);
    }
    return conductor;
  }

  /** Admits a user message once and queues its turn. Returns before the run finishes. */
  async onUserMessage(message: UserMessage, access: ConductorAccess): Promise<void> {
    if (this.closing.signal.aborted) throw new Error('The conductor is closed');
    const lane = this.lane(message.conversationId, access);
    if (lane.queue.length >= this.limits.maxQueuedPerConversation) {
      this.state.enqueueNotice(
        { conversationId: message.conversationId },
        'Too many messages are waiting. Wait for the current run to answer, then send this again.',
      );
      this.sendOutbox(message.conversationId);
      return;
    }
    const limits = message.run;
    if (
      limits !== undefined &&
      !(
        typeof limits.dutyId === 'string' &&
        limits.dutyId !== '' &&
        isRunAuthority(limits.authority) &&
        Number.isFinite(limits.budgetUsd) &&
        limits.budgetUsd > 0
      )
    ) {
      // Fail closed: limits that cannot be read start no run, instead of a run with the defaults.
      this.warn('A message carried run limits that are not valid; it was not run', {
        messageId: message.messageId,
      });
      this.state.enqueueNotice(
        { conversationId: message.conversationId },
        'This request could not be started because its limits were not valid.',
      );
      this.sendOutbox(message.conversationId);
      return;
    }
    if (message.mode !== undefined && !isModeId(message.mode)) {
      // Fail closed, like limits: a pick that cannot be read starts no run with another mode.
      this.warn('A message carried a mode that is not valid; it was not run', {
        messageId: message.messageId,
      });
      this.state.enqueueNotice(
        { conversationId: message.conversationId },
        'This request could not be started because its mode was not valid.',
      );
      this.sendOutbox(message.conversationId);
      return;
    }
    const picked = this.modes && limits === undefined ? message.mode : undefined;
    if (message.external) this.state.taint(message.conversationId, 'message');
    const admitted = this.state.admitMessage(
      message.conversationId,
      message.messageId,
      // The user's pick brings the budget that mode starts with; a duty's budget is its own.
      picked && this.modes
        ? this.modes.modes[picked as ModeId].budget.defaultRunUsd
        : this.limits.defaultRunBudgetUsd,
      limits === undefined
        ? undefined
        : { dutyId: limits.dutyId, authority: limits.authority, budgetUsd: limits.budgetUsd },
      picked as ModeId | undefined,
    );
    if (admitted.duplicate) return;
    this.enqueue(lane, { kind: 'turn', runId: admitted.run.runId, text: message.text });
  }

  /**
   * Applies an answer to an open question once. A budget raise or an approval
   * is applied by code before the answer reaches the model; "stop" ends the run.
   */
  async onAnswer(answer: UserAnswer, access: ConductorAccess): Promise<AnswerOutcome> {
    if (this.closing.signal.aborted) throw new Error('The conductor is closed');
    if (answer.text !== undefined && answer.text.length > MAX_ANSWER_TEXT_LENGTH) {
      return { accepted: false, reason: 'text_too_long' };
    }
    const lane = this.lane(answer.conversationId, access);
    const result = this.state.answer(
      answer.conversationId,
      answer.questionId,
      answer.optionId,
      answer.text,
      answer.caller,
    );
    if (!result.accepted) return result;
    if (result.duplicate) return { accepted: true, duplicate: true };
    const { question, option, run } = result;
    // The answered event was written with the answer; send it.
    this.sendOutbox(question.conversationId);
    if (!OPEN_RUN_STATES.includes(run.state)) return { accepted: false, reason: 'closed' };
    if (question.reason === 'budget_overrun' && option.id === 'stop') {
      this.stopRun(lane, run.runId, 'user_stop');
      return { accepted: true, duplicate: false };
    }
    const followUp =
      question.reason === 'irreversible' && option.id === 'approve'
        ? ` Call the tool again with the same arguments and actionRef "${question.actionRef}".`
        : question.reason === 'irreversible'
          ? ' Do not perform that action.'
          : question.reason === 'budget_overrun'
            ? ` The run budget is now ${money(this.state.budget(run.runId).budgetUsd)}.`
            : '';
    this.enqueue(lane, {
      kind: 'turn',
      runId: run.runId,
      text: `Answer to question ${question.questionId} ("${question.question}"): ${option.label}.${followUp}${
        answer.text ? `\n\nThe user added: ${JSON.stringify(answer.text)}` : ''
      }`,
    });
    return { accepted: true, duplicate: false };
  }

  /**
   * The conversation a running conductor or planner turn works for, so its model spend can be
   * charged to whoever owns it. Undefined for a session with no turn running.
   */
  conversationOfSession(makaSessionId: string): string | undefined {
    const turn = this.turns.get(makaSessionId) ?? this.plannerTurns.get(makaSessionId);
    return turn === undefined ? undefined : this.state.run(turn.runId)?.conversationId;
  }

  /** Stops the conversation's open run: its turn, queued inputs and tasks. */
  async stop(conversationId: string): Promise<boolean> {
    const run = this.state.openRun(conversationId);
    if (!run) return false;
    return this.stopRun(this.lane(conversationId), run.runId, 'user_stop');
  }

  /**
   * Stops every open run, in every conversation, the way a user's stop does: its turn, queued
   * inputs and tasks (cancelled through the orchestrator), and tells the user why. For the
   * operator's pause switch. A conversation the orchestrator gives no access to has its tasks
   * marked as owed a cancel, which is retried when it next has access. Cancels still owed from an
   * earlier stop are retried too, whether or not any run is open. Returns how many runs it stopped.
   */
  async stopAll(reason: string, notice: string): Promise<number> {
    if (this.closing.signal.aborted) return 0;
    // Tasks kept across a restart have no open run to be stopped through: they are owed a cancel.
    if (this.tasksSurviveRestart) {
      this.state.markCancelPending(
        this.state.unsettledDelegations().map((delegation) => delegation.key),
      );
    }
    let stopped = 0;
    for (const run of OPEN_RUN_STATES.flatMap((state) => this.state.runsInState(state))) {
      const access = this.orchestratorAccess?.(run.conversationId);
      const lane = this.lane(run.conversationId, access);
      if (!lane.access) {
        this.state.markCancelPending(
          this.state.unsettledDelegations({ runId: run.runId }).map((delegation) => delegation.key),
        );
      }
      if (this.stopRun(lane, run.runId, reason, notice)) {
        stopped += 1;
        this.sendOutbox(run.conversationId);
      }
    }
    // A stop that could not reach the orchestrator left its tasks running and its runs closed, so
    // the scan above never sees them again: every call asks for what is still owed.
    for (const conversationId of this.state.conversationsWithPendingCancels()) {
      const access = this.orchestratorAccess?.(conversationId);
      // Taking the access queues the retry.
      if (access) this.lane(conversationId, access);
    }
    return stopped;
  }

  /**
   * Reserves spend against a conversation's run budget for a caller in the same
   * process (the supervisor's verification). See ConductorState.reserveExternal.
   */
  reserveSpend(key: string, conversationId: string, taskId: string | undefined, maxUsd: number) {
    return this.state.reserveExternal(key, conversationId, taskId, maxUsd);
  }

  /**
   * Settles a reservation made with reserveSpend at what was actually spent.
   * Above the reservation the full amount is charged, `overrunUsd` says by how
   * much, and the run spends nothing more until the user answers a budget question.
   */
  settleSpend(key: string, actualUsd: number) {
    return this.state.settleExternal(key, actualUsd);
  }

  /** Posts a notice to the conversation's feed for a caller in the same process. Durable once this returns. */
  async postNotice(notice: Omit<OutboxNotice, 'eventId'>): Promise<void> {
    this.state.enqueueNotice(
      notice.runId === undefined
        ? { conversationId: notice.conversationId }
        : { conversationId: notice.conversationId, runId: notice.runId },
      notice.text,
    );
    this.sendOutbox(notice.conversationId);
  }

  stats(): ConductorStats {
    let queued = 0;
    for (const lane of this.lanes.values()) queued += lane.queue.length;
    return {
      runningTurns: this.slotsInUse,
      waitingForSlot: this.slotWaiters.length,
      queued,
      planners: this.counters.planners,
      timers: this.counters.timers,
      openClients: this.counters.openClients,
      outboxSending: this.sending.size,
      outboxRetrying: this.retryTimers.size,
      stopChecks: this.stopChecks.size,
    };
  }

  /**
   * Resolves once no conversation has work queued or running and no outbox
   * event is being sent. An event waiting to be retried does not count.
   */
  async idle(): Promise<void> {
    for (;;) {
      const pumps = [...this.lanes.values()].flatMap((lane) => (lane.pump ? [lane.pump] : []));
      const work = [...pumps, ...this.sending.values()];
      if (work.length === 0) return;
      await Promise.all(work);
    }
  }

  /**
   * Stops every turn and waits for each to give back what it holds. Then,
   * while the orchestrator can still be reached, cancels every task not known
   * to have ended, those of runs waiting for an answer included; a cancel that
   * fails is kept and retried on the next start. Then closes the stores.
   */
  close(): Promise<void> {
    this.closed ??= (async () => {
      this.closing.abort();
      for (const waiter of this.slotWaiters.splice(0))
        waiter.refuse(new Error('The conductor is closed'));
      for (const lane of this.lanes.values()) {
        lane.queue = [];
        if (lane.current) this.requestStop(lane.current, 'shutdown');
      }
      await this.idle();
      try {
        await this.cancelEverything();
      } catch (error) {
        this.warn('Cancelling tasks at shutdown failed', error);
      }
      for (const timer of this.retryTimers.values()) clearTimeout(timer);
      this.retryTimers.clear();
      for (const timer of this.followTimers.values()) clearTimeout(timer);
      this.followTimers.clear();
      for (const timer of this.stopChecks.values()) clearTimeout(timer);
      this.stopChecks.clear();
      await this.idle();
      try {
        await this.host.close();
      } finally {
        this.state.close();
      }
    })();
    return this.closed;
  }

  // Lanes and slots

  private lane(conversationId: string, access?: ConductorAccess): Lane {
    let lane = this.lanes.get(conversationId);
    if (!lane) {
      lane = { conversationId, queue: [] };
      this.lanes.set(conversationId, lane);
    }
    if (access) {
      lane.access = access;
      // With access for this conversation, retry the cancels it is owed first.
      if (
        !this.closing.signal.aborted &&
        this.state.hasPendingCancels(conversationId) &&
        !lane.queue.some((job) => job.kind === 'cancel_pending')
      ) {
        this.enqueue(lane, { kind: 'cancel_pending' });
      }
    }
    return lane;
  }

  private enqueue(lane: Lane, job: Job): void {
    lane.queue.push(job);
    this.startPump(lane);
  }

  private startPump(lane: Lane): void {
    if (lane.pump) return;
    lane.pump = this.pump(lane).finally(() => {
      lane.pump = undefined;
      // A job queued after the pump's last look still runs.
      if (lane.queue.length > 0 && !this.closing.signal.aborted) this.startPump(lane);
    });
  }

  private async pump(lane: Lane): Promise<void> {
    for (let job = lane.queue.shift(); job; job = lane.queue.shift()) {
      try {
        if (job.kind === 'turn') await this.executeTurn(lane, job);
        else if (job.kind === 'follow_tasks') await this.followTasks(lane);
        else await this.cancelTasks(lane, job.runId);
      } catch (error) {
        this.warn('A conductor job failed', error);
      }
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.closing.signal.aborted) return Promise.reject(new Error('The conductor is closed'));
    if (this.slotsInUse < this.limits.maxConcurrentRuns) {
      this.slotsInUse += 1;
      return Promise.resolve();
    }
    return new Promise((grant, refuse) => this.slotWaiters.push({ grant, refuse }));
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    // The slot passes straight to the next waiter, so the count never dips below the limit.
    if (next) next.grant();
    else this.slotsInUse -= 1;
  }

  // Turns

  private async executeTurn(lane: Lane, job: Extract<Job, { kind: 'turn' }>): Promise<void> {
    const before = this.state.run(job.runId);
    if (!before || !OPEN_RUN_STATES.includes(before.state)) return;
    try {
      await this.acquireSlot();
    } catch {
      return;
    }
    const link = new OrchestratorLink(
      lane.conversationId,
      lane.access as ConductorAccess,
      this.tokens,
      this.counters,
    );
    let turn: Turn | undefined;
    let setupError: unknown;
    let timer: NodeJS.Timeout | undefined;
    try {
      const makaSessionId = await this.ensureSession(lane.conversationId, job.runId);
      const controller = new AbortController();
      turn = {
        runId: job.runId,
        conversationId: lane.conversationId,
        makaSessionId,
        link,
        controller,
        signal: controller.signal,
        refusals: 0,
        planners: new Set(),
        finalText: [],
        errors: [],
        sawTool: false,
      };
      const active: Turn = turn;
      lane.current = active;
      this.turns.set(makaSessionId, active);
      const fire = () => this.requestStop(active, 'timeout');
      timer = setTimeout(fire, this.limits.turnTimeoutMs);
      this.counters.timers += 1;
      this.hooks.turnTimer?.(fire);
      await this.hooks.beforeSend?.({ runId: job.runId, conversationId: lane.conversationId });
      // Checked after the turn is registered: a stop that ran before this saw
      // no turn and ended the run, so this sees it; one that runs after sees the turn.
      if (this.closing.signal.aborted) this.requestStop(active, 'shutdown');
      const run = this.state.run(job.runId) as RunRow;
      if (!OPEN_RUN_STATES.includes(run.state) && !active.stopReason)
        this.requestStop(active, 'user');
      const budget = this.state.budget(job.runId);
      if (!active.stopReason && (budget.remainingUsd <= 0 || budget.blockedReason !== null)) {
        // Spent or blocked before this input arrived (a dismissed budget question): ask again, send nothing.
        this.askBudget(active, 0);
      } else if (!active.stopReason) {
        const raw = this.turnContext?.(lane.conversationId);
        const context = typeof raw === 'string' ? raw : (raw?.text ?? '');
        // Memory holds past task summaries and facts that may come from outside the user: the
        // taint is stored before any request carries it (T15). Fail closed: only an explicit
        // `external: false` leaves the conversation clean.
        if (typeof raw === 'string' ? raw !== '' : raw !== undefined && raw.external !== false) {
          this.state.taint(lane.conversationId, 'memory');
        }
        const text = this.turnText(job.runId, job.text) + (context ? `\n\n${context}` : '');
        for await (const event of this.host.send(
          makaSessionId,
          text,
          this.limits.maxStepsPerTurn,
        )) {
          this.onEvent(active, event);
        }
      }
    } catch (error) {
      if (turn) {
        turn.errors.push(errorMessage(error));
        delete turn.errorKind;
      } else setupError = error;
    } finally {
      if (timer) {
        clearTimeout(timer);
        this.counters.timers -= 1;
      }
      if (turn) {
        this.turns.delete(turn.makaSessionId);
        if (lane.current === turn) lane.current = undefined;
        await turn.stopping;
        this.host.releaseModelAccess(turn.makaSessionId);
      }
      try {
        const queued = lane.queue.some((next) => next.kind === 'turn' && next.runId === job.runId);
        await this.settle(job.runId, turn, setupError, link, queued);
      } catch (error) {
        this.warn('Settling a run failed', error);
      }
      await link
        .close()
        .catch((error: unknown) => this.warn('Closing the orchestrator client failed', error));
      this.releaseSlot();
    }
  }

  /**
   * The mode a run's conductor and planner think in: the user's pick, else `standard`. The
   * conductor's model is one for the whole conversation (its preserved thinking is checked against
   * it), so a mode sets effort only, and a conversation's conductor session keeps the effort of the
   * run that opened it; each planner session is the run's own.
   */
  private effortOf(runId: string | null, role: 'conductor' | 'plannerEffort'): ThinkingLevel {
    const fallback = role === 'conductor' ? 'medium' : 'high';
    if (!this.modes) return fallback;
    const mode = (runId === null ? undefined : this.state.run(runId)?.mode) ?? 'standard';
    return this.modes.modes[mode].conductor[role === 'conductor' ? 'effort' : 'plannerEffort'];
  }

  private async ensureSession(conversationId: string, runId: string): Promise<string> {
    const existing = this.state.conversationSession(conversationId);
    if (existing) return existing;
    const makaSessionId = await this.host.createSession({
      kind: 'conductor',
      systemPrompt: conductorSystemPrompt(this.playbooks, this.modes !== undefined),
      thinkingLevel: this.effortOf(runId, 'conductor'),
      runId: null,
    });
    this.state.bindConversation(conversationId, makaSessionId);
    return makaSessionId;
  }

  private turnText(runId: string, text: string): string {
    const budget = this.state.budget(runId);
    return `[${new Date(this.now()).toISOString()}] Run budget: ${money(Math.max(0, budget.remainingUsd))} left of ${money(budget.budgetUsd)}.\n\n${text}`;
  }

  private onEvent(turn: Turn, event: SessionEvent): void {
    switch (event.type) {
      case 'tool_start':
        turn.sawTool = true;
        turn.finalText = [];
        break;
      case 'tool_result':
        turn.finalText = [];
        break;
      case 'text_complete':
        if (!event.interrupted && event.text.trim()) turn.finalText.push(event.text);
        break;
      case 'error':
        if (!event.recoverable) {
          turn.errors.push(event.message);
          if (event.reason === undefined) delete turn.errorKind;
          else turn.errorKind = event.reason;
        }
        break;
      case 'complete':
        turn.completeReason = event.stopReason;
        break;
      default:
        break;
    }
  }

  /** Decides how the run continues once its turn is over. */
  private async settle(
    runId: string,
    turn: Turn | undefined,
    setupError: unknown,
    link: OrchestratorLink,
    queued: boolean,
  ): Promise<void> {
    const run = this.state.run(runId);
    if (!run) return;
    if (turn?.stopReason === 'shutdown') {
      this.state.endRun(runId, 'interrupted', 'shutdown');
      // Stop what it started while the orchestrator can still be reached, unless the orchestrator
      // keeps its tasks across the restart: then the next start follows them.
      if (!this.tasksSurviveRestart) await this.cancelRunTasks(runId, link);
      return;
    }
    if (!OPEN_RUN_STATES.includes(run.state)) {
      // Ended while the turn ran (user stop): stop what it started.
      await this.cancelRunTasks(runId, link);
      return;
    }
    const failure = this.failureOf(turn, setupError, runId);
    if (failure) {
      this.state.endRun(runId, 'failed', failure.reason, failure.text);
      this.sendOutbox(run.conversationId);
      await this.cancelRunTasks(runId, link);
      return;
    }
    const text = turn?.finalText.join('\n\n').trim();
    const ends =
      !(queued && (turn?.stopReason !== 'refusals' || this.state.openQuestion(runId))) &&
      !this.state.openQuestion(runId) &&
      turn?.stopReason !== 'refusals';
    if (text && ends) {
      // The final message: the run is done once the outbox has delivered it.
      if (this.state.deliverRun(runId, text)) {
        this.sendOutbox(run.conversationId);
        await this.cancelRunTasks(runId, link);
      }
      return;
    }
    if (text) {
      this.state.enqueueOutbox('message', run.conversationId, {
        conversationId: run.conversationId,
        runId,
        text,
      });
      this.sendOutbox(run.conversationId);
    }
    if (queued && (turn?.stopReason !== 'refusals' || this.state.openQuestion(runId))) {
      // A message sent during this turn continues the run; it was written
      // without seeing a question this turn asked, so it stands in for the answer.
      this.state.dismissQuestion(runId);
      this.state.setRunState(runId, 'active');
      return;
    }
    if (this.state.openQuestion(runId)) {
      this.state.setRunState(runId, 'waiting');
      return;
    }
    if (turn?.stopReason === 'refusals') {
      this.state.endRun(
        runId,
        'failed',
        'stopped',
        'The run was stopped because it kept calling tools after it had to stop.',
      );
      this.sendOutbox(run.conversationId);
      await this.cancelRunTasks(runId, link);
      return;
    }
    if (this.state.endRun(runId, 'done', 'delivered')) await this.cancelRunTasks(runId, link);
  }

  private failureOf(
    turn: Turn | undefined,
    setupError: unknown,
    runId: string,
  ): { reason: string; text: string } | undefined {
    if (setupError !== undefined) {
      return {
        reason: 'setup_failed',
        text: `The run could not start: ${errorMessage(setupError)}`,
      };
    }
    if (!turn) return { reason: 'setup_failed', text: 'The run could not start.' };
    // A refused request ends the turn; the budget question or the stop says why.
    if (turn.stopReason === 'gated') return undefined;
    if (turn.stopReason === 'timeout') {
      return {
        reason: 'timeout',
        text: `The run took longer than ${Math.round(this.limits.turnTimeoutMs / 60_000)} minutes and was stopped.`,
      };
    }
    if (turn.stopReason === 'refusals') return undefined;
    const error = turn.errors.at(-1);
    if (error !== undefined || turn.completeReason === 'error') {
      const message = error ?? 'the model call failed';
      return /context|too long|too many tokens/i.test(message)
        ? {
            reason: 'context_full',
            text: 'This conversation is too long to continue. Start a new conversation for the next request.',
          }
        : {
            reason: this.retryable(turn, runId) ? 'model_transient' : 'model_error',
            text: `The run failed: ${message}`,
          };
    }
    if (turn.completeReason === 'step_limit' || turn.completeReason === 'max_tokens') {
      return {
        reason: turn.completeReason,
        text: `The run stopped early (${turn.completeReason}).`,
      };
    }
    return undefined;
  }

  /**
   * Whether a failed run ended on a capacity or network error and did nothing else yet: its last
   * error was classified by the model adapter as one that goes away on its own, and the run called
   * no tool and started no task, so running it again repeats nothing. Anything else, and anything
   * unclassified, is `model_error` and fails closed.
   */
  private retryable(turn: Turn, runId: string): boolean {
    return (
      turn.errorKind !== undefined &&
      TRANSIENT_MODEL_ERRORS.has(turn.errorKind) &&
      !turn.sawTool &&
      this.state.tasksOf(runId).length === 0
    );
  }

  private requestStop(turn: Turn, reason: StopReason): void {
    if (turn.stopReason) return;
    turn.stopReason = reason;
    turn.controller.abort();
    const sessions = [turn.makaSessionId, ...turn.planners];
    turn.stopping = Promise.all(
      sessions.map((sessionId) =>
        this.host
          .stop(sessionId)
          .catch((error: unknown) => this.warn('Stopping a Maka turn failed', error)),
      ),
    ).then(() => undefined);
  }

  private stopRun(lane: Lane, runId: string, reason: string, notice?: string): boolean {
    if (!this.state.endRun(runId, 'cancelled', reason, notice)) return false;
    lane.queue = lane.queue.filter((job) => job.runId !== runId);
    if (lane.current?.runId === runId) this.requestStop(lane.current, 'user');
    else this.enqueue(lane, { kind: 'cancel_tasks', runId });
    return true;
  }

  /** A run's tasks, or (without a run) the cancels the conversation is still owed. */
  private async cancelTasks(lane: Lane, runId: string | undefined): Promise<void> {
    const delegations =
      runId === undefined
        ? this.state
            .unsettledDelegations({ conversationId: lane.conversationId })
            .filter((delegation) => delegation.cancelPending)
        : this.state.unsettledDelegations({ runId });
    if (!lane.access || delegations.length === 0) return;
    const link = new OrchestratorLink(lane.conversationId, lane.access, this.tokens, this.counters);
    try {
      await this.cancelDelegations(delegations, link);
    } finally {
      await link.close().catch(() => undefined);
    }
  }

  private async cancelRunTasks(runId: string, link: OrchestratorLink): Promise<void> {
    await this.cancelDelegations(this.state.unsettledDelegations({ runId }), link);
  }

  /**
   * Cancels each delegation's task, found by its id or, when the response with
   * the id was lost, by its idempotency key. Each is marked before it is tried
   * and unmarked only once the orchestrator confirms, so a failure is retried.
   */
  private async cancelDelegations(
    delegations: readonly DelegationRow[],
    link: OrchestratorLink,
  ): Promise<void> {
    this.state.markCancelPending(delegations.map((delegation) => delegation.key));
    const failed = new Set<string>();
    for (const delegation of delegations) {
      const target =
        delegation.taskId === null
          ? { idempotencyKey: delegation.key }
          : { taskId: delegation.taskId };
      try {
        const result = await link.call('task_cancel', target);
        if (result.isError) {
          this.warn(`Cancelling delegation ${delegation.key} failed`, result.text);
          failed.add(delegation.conversationId);
          continue;
        }
        this.settleView(delegation, result.structured);
      } catch (error) {
        this.warn(`Cancelling delegation ${delegation.key} failed`, error);
        failed.add(delegation.conversationId);
      }
    }
    // The delegation stays owed and reserved; ask again after a while, with nobody having to call.
    for (const conversationId of failed) this.checkStopLater(conversationId);
    // Nothing owed any more: the check that was waiting for it has nothing to ask.
    for (const conversationId of new Set(delegations.map((d) => d.conversationId))) {
      if (this.state.hasPendingCancels(conversationId)) continue;
      const timer = this.stopChecks.get(conversationId);
      if (timer) clearTimeout(timer);
      this.stopChecks.delete(conversationId);
    }
  }

  /** At shutdown: every task not known to have ended, in every conversation that has access. */
  private async cancelEverything(): Promise<void> {
    const byConversation = new Map<string, DelegationRow[]>();
    for (const delegation of this.state.unsettledDelegations()) {
      // The orchestrator keeps these across the restart: only a cancel already owed goes ahead.
      if (this.tasksSurviveRestart && !delegation.cancelPending) continue;
      const list = byConversation.get(delegation.conversationId) ?? [];
      list.push(delegation);
      byConversation.set(delegation.conversationId, list);
    }
    await Promise.all(
      [...byConversation].map(async ([conversationId, delegations]) => {
        const access =
          this.lanes.get(conversationId)?.access ?? this.orchestratorAccess?.(conversationId);
        if (!access) {
          this.state.markCancelPending(delegations.map((delegation) => delegation.key));
          return;
        }
        const link = new OrchestratorLink(conversationId, access, this.tokens, this.counters);
        try {
          await this.cancelDelegations(delegations, link);
        } finally {
          await link.close().catch(() => undefined);
        }
      }),
    );
  }

  /**
   * Settles a delegation from a task view once the task has ended and its run
   * is known to have stopped: at what its tree reported spending, or at the
   * whole reservation when no runner in it reports spend. A cancel by key that
   * found no task settles at 0. An ended task whose run may still be going
   * keeps its reservation, and is asked about again until its stop is confirmed.
   */
  private settleView(
    delegation: DelegationRow,
    view: Record<string, unknown> | undefined,
    closing?: string,
  ): void {
    if (!view) return;
    if (view.created === false) {
      this.state.settleDelegation(delegation.key, 0);
      return;
    }
    if (typeof view.taskId === 'string' && delegation.taskId === null) {
      this.state.bindTask(delegation.key, view.taskId);
    }
    if (!['succeeded', 'failed', 'cancelled'].includes(String(view.state))) return;
    // The reservation covers the whole tree: hold it while any task in it may still run.
    if (view.stopPending === true || view.treeStopPending === true) {
      this.state.markCancelPending([delegation.key]);
      this.checkStopLater(delegation.conversationId);
      return;
    }
    const actual = typeof view.costUsd === 'number' ? view.costUsd : delegation.reservedUsd;
    this.state.settleDelegation(delegation.key, actual, closing);
  }

  /**
   * What the user is told when a task ends that the conductor followed across a restart: the run
   * that started it was cut off, so no turn is left to say it. Fixed wording around the task's own
   * words, with no model call. Absent when the run did not end for a restart or a shutdown.
   */
  private closingOfFollowed(
    delegation: DelegationRow,
    view: Record<string, unknown> | undefined,
  ): string | undefined {
    const run = this.state.run(delegation.runId);
    if (run?.state !== 'interrupted' || !['restart', 'shutdown'].includes(run.endReason ?? '')) {
      return undefined;
    }
    const ended = String(view?.state);
    if (!['succeeded', 'failed', 'cancelled'].includes(ended)) return undefined;
    const manifest = view?.manifest as { summary?: unknown } | undefined;
    const words = (value: unknown): string =>
      typeof value === 'string' && this.scrubTaskText ? this.scrubTaskText(value).trim() : '';
    const detail = words(manifest?.summary) || words(view?.failureReason);
    const name = words(view?.title).slice(0, 120);
    const text = `The server restarted while this ran. The task${name ? ` "${name}"` : ''} ${ended}${detail ? `: ${detail}` : '.'}`;
    return text.length > 800 ? `${text.slice(0, 799)}…` : text;
  }

  /**
   * Asks the orchestrator about each task of the conversation that was delegated before a restart
   * and is not settled: one that has ended is settled at what its tree spent. A task that cannot
   * be asked about is asked about again later; its reservation stays.
   */
  private async followTasks(lane: Lane): Promise<void> {
    const delegations = this.state
      .unsettledDelegations({ conversationId: lane.conversationId })
      .filter((delegation) => !delegation.cancelPending && delegation.taskId !== null);
    if (!lane.access || delegations.length === 0) return;
    const link = new OrchestratorLink(lane.conversationId, lane.access, this.tokens, this.counters);
    try {
      for (const delegation of delegations) {
        if (this.closing.signal.aborted) return;
        try {
          const result = await link.call('task_status', { taskId: delegation.taskId });
          if (result.isError) {
            this.warn(`Asking about delegation ${delegation.key} failed`, result.text);
            continue;
          }
          // A turn may have settled it while this waited.
          const current = this.state.delegation(delegation.key);
          if (current && current.state !== 'settled') {
            this.settleView(
              current,
              result.structured,
              this.closingOfFollowed(current, result.structured),
            );
          }
        } catch (error) {
          this.warn(`Asking about delegation ${delegation.key} failed`, error);
        }
      }
    } finally {
      await link.close().catch(() => undefined);
    }
    this.sendOutbox(lane.conversationId);
    if (!this.closing.signal.aborted) {
      this.hooks.followed?.(lane.conversationId);
      if (this.state.hasFollowedTasks(lane.conversationId)) {
        this.followLater(lane.conversationId, this.nextFollowDelay(lane.conversationId));
      } else {
        this.followDelays.delete(lane.conversationId);
      }
    }
  }

  /**
   * Asks again soon after a restart, when a task is most likely to end, and less often the longer
   * it runs: one second, doubling to ten (never past the stop-check interval).
   */
  private nextFollowDelay(conversationId: string): number {
    const cap = Math.min(this.limits.stopCheckMs, FOLLOW_MAX_MS);
    const previous = this.followDelays.get(conversationId);
    const next = Math.min(previous === undefined ? FOLLOW_FIRST_MS : previous * 2, cap);
    this.followDelays.set(conversationId, next);
    return next;
  }

  /** Asks about the conversation's followed tasks after `delayMs` (default: the stop-check interval). */
  private followLater(conversationId: string, delayMs = this.limits.stopCheckMs): void {
    if (this.closing.signal.aborted || this.followTimers.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.followTimers.delete(conversationId);
      if (this.closing.signal.aborted) return;
      const access =
        this.lanes.get(conversationId)?.access ?? this.orchestratorAccess?.(conversationId);
      if (!access) {
        this.followLater(conversationId);
        return;
      }
      const lane = this.lane(conversationId, access);
      if (!lane.queue.some((job) => job.kind === 'follow_tasks'))
        this.enqueue(lane, { kind: 'follow_tasks' });
    }, delayMs);
    timer.unref();
    this.followTimers.set(conversationId, timer);
  }

  /** Asks the orchestrator again, after a while, about the conversation's tasks that are owed a cancel. */
  private checkStopLater(conversationId: string): void {
    if (this.closing.signal.aborted || this.stopChecks.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.stopChecks.delete(conversationId);
      if (this.closing.signal.aborted) return;
      const access =
        this.lanes.get(conversationId)?.access ?? this.orchestratorAccess?.(conversationId);
      // Taking the access queues the retry.
      if (access) this.lane(conversationId, access);
    }, this.limits.stopCheckMs);
    timer.unref();
    this.stopChecks.set(conversationId, timer);
  }

  // Budget

  private meter(makaSessionId: string, attempt: ModelCallAttempt): void {
    const turn = this.turns.get(makaSessionId) ?? this.plannerTurns.get(makaSessionId);
    const runId = turn?.runId ?? this.state.session(makaSessionId)?.runId;
    if (!runId) return;
    // Through the gateway the request was charged when it settled: count it once.
    const budget = this.host.gatewayCharged
      ? this.state.budget(runId)
      : this.state.addModelSpend(runId, callCostUsd(attempt, this.prices), attempt.attemptId);
    if (turn && (budget.remainingUsd <= 0 || budget.blockedReason !== null)) {
      this.askBudget(turn, 0);
    }
  }

  /**
   * Called before every model request of a conductor or planner session, the
   * retries of one included. A run that spent its budget, whose spend is
   * blocked, that has a question open or that ended sends no paid request: the
   * turn stops here and, when money is the reason, the user is asked.
   */
  private gateModelRequest(makaSessionId: string): void {
    const turn = this.turns.get(makaSessionId) ?? this.plannerTurns.get(makaSessionId);
    if (!turn) throw new Error('No conductor turn is running for this session.');
    let refusal: string | undefined;
    if (turn.stopReason) refusal = 'the run is stopping';
    else {
      const run = this.state.run(turn.runId);
      const budget = this.state.budget(turn.runId);
      if (!run || !OPEN_RUN_STATES.includes(run.state)) refusal = 'the run has ended';
      else if (this.state.openQuestion(turn.runId)) refusal = 'a question is waiting for the user';
      else if (budget.remainingUsd <= 0 || budget.blockedReason !== null) {
        refusal = 'the run budget is spent';
        this.askBudget(turn, 0);
      }
    }
    if (!refusal) {
      // Read as the request goes out, after every result in it was stored with its taint.
      if (this.turns.get(makaSessionId) === turn) {
        turn.contextTainted = this.state.taintOf(turn.conversationId) !== undefined;
      }
      return;
    }
    this.requestStop(turn, 'gated');
    throw new Error(`Model request not sent: ${refusal}.`);
  }

  /**
   * Where the gateway charges a session's model requests: the run ledger, at the request's
   * worst-case cost before it is sent, replaced by what it cost once it ends. A request the run
   * cannot cover is not sent: the turn stops and the user is asked to raise the budget.
   */
  private modelCharge(makaSessionId: string): ModelCharge {
    return {
      reserve: (key, usd) => {
        const turn = this.turns.get(makaSessionId) ?? this.plannerTurns.get(makaSessionId);
        if (!turn) return { ok: false, reason: 'no conductor turn is running' };
        const reserved = this.state.tryReserve(turn.runId, usd, `request:${key}`);
        if (reserved.ok) {
          this.requestHolds.set(key, { runId: turn.runId, reservation: reserved.reservation });
          return { ok: true };
        }
        if (reserved.reason === 'question_open') {
          this.requestStop(turn, 'gated');
          return { ok: false, reason: 'a question is waiting for the user' };
        }
        const remaining = Math.max(0, reserved.budget.remainingUsd);
        this.askBudget(turn, reserved.budget.blockedReason === null ? usd - remaining : 0);
        this.requestStop(turn, 'gated');
        return {
          ok: false,
          budget: true,
          reason: `the run budget has ${money(remaining)} left, and this request could cost up to ${money(usd)}`,
        };
      },
      settle: (key, usd) => {
        const hold = this.requestHolds.get(key);
        if (!hold) return;
        this.requestHolds.delete(key);
        let budget: ReturnType<ConductorState['budget']>;
        try {
          budget = this.state.settleModelRequest(hold.runId, hold.reservation, usd, key);
        } catch (error) {
          // The reservation stands; a restart charges it in full.
          this.warn('Settling a model request failed', error);
          return;
        }
        const turn = this.turns.get(makaSessionId) ?? this.plannerTurns.get(makaSessionId);
        if (
          turn &&
          turn.runId === hold.runId &&
          (budget.remainingUsd <= 0 || budget.blockedReason !== null)
        ) {
          this.askBudget(turn, 0);
        }
      },
    };
  }

  /**
   * Opens the code-built budget question. `needUsd` 0 means the spend ran out,
   * or was blocked because something spent more than was reserved for it.
   */
  private askBudget(turn: ActiveTurn, needUsd: number): QuestionRow | undefined {
    const budget = this.state.budget(turn.runId);
    // A standing duty's budget is a hard limit: there is no card to raise it, the run ends.
    if (this.state.run(turn.runId)?.hardBudget) {
      this.stopRun(
        this.lane(turn.conversationId),
        turn.runId,
        'budget_limit',
        `This run reached its budget of ${money(budget.budgetUsd)} and was stopped. A standing duty cannot raise its own budget.`,
      );
      this.sendOutbox(turn.conversationId);
      return undefined;
    }
    const target =
      needUsd > 0
        ? (budget.spentUsd + needUsd) * 1.2
        : Math.max(
            budget.budgetUsd * 1.5,
            budget.budgetUsd + this.limits.defaultRunBudgetUsd,
            budget.spentUsd * 1.2,
          );
    const raiseToUsd = Math.ceil(target * 100) / 100;
    const opened = this.state.openQuestionIf(
      turn.runId,
      {
        reason: 'budget_overrun',
        question:
          needUsd > 0
            ? `The next step needs ${money(needUsd)}, but this run has ${money(Math.max(0, budget.remainingUsd))} of its ${money(budget.budgetUsd)} budget left. Raise the budget?`
            : budget.blockedReason !== null
              ? `${budget.blockedReason} Spending is paused. Raise the budget to ${money(raiseToUsd)} and keep going?`
              : `This run has used its ${money(budget.budgetUsd)} budget. Raise it to keep going?`,
        options: [
          { id: 'raise', label: `Raise the budget to ${money(raiseToUsd)}` },
          { id: 'stop', label: 'Stop here' },
        ],
        recommended: 'raise',
        raiseToUsd,
        actionRef: null,
      },
      () => undefined,
    );
    if (!opened.ok) return undefined;
    this.sendOutbox(opened.question.conversationId);
    return opened.question;
  }

  // Tool host

  private toolHost(): ToolHost {
    return {
      state: this.state,
      limits: this.limits,
      playbooks: this.playbooks,
      ...(this.modes ? { modes: this.modes } : {}),
      turnFor: (ctx: MakaToolContext) => {
        const turn = this.turns.get(ctx.sessionId);
        if (!turn) throw new ToolRefusal('no_run', 'This session has no running conductor turn.');
        return turn;
      },
      mustStop: (active) => this.mustStop(active as Turn),
      plan: (active, input, signal) => this.plan(active as Turn, input, signal),
      askBudget: (active, needUsd) => this.askBudget(active, needUsd),
      postQuestion: (question) => this.sendOutbox(question.conversationId),
      postNotice: (active, text) => {
        this.state.enqueueNotice(active, text);
        this.sendOutbox(active.conversationId);
      },
      settleTask: (view) => {
        const taskId = view?.taskId;
        if (typeof taskId !== 'string') return;
        const delegation = this.state.delegationOfTask(taskId);
        if (delegation && delegation.state !== 'settled') this.settleView(delegation, view);
      },
      // Fail closed: a call with no request on record counts as decided on tainted context.
      decidedOnTaint: (active) => (active as Turn).contextTainted ?? true,
      approverAuthorized: (approvedBy, conversationId) =>
        this.approverAuthorized ? this.approverAuthorized(approvedBy, conversationId) : true,
      carriesSecret: (text) => this.carriesSecret?.(text) ?? false,
    };
  }

  private mustStop(turn: Turn): string | undefined {
    let reason: string | undefined;
    if (turn.stopReason) reason = 'The run is stopping.';
    else {
      const run = this.state.run(turn.runId);
      if (!run || !OPEN_RUN_STATES.includes(run.state)) reason = 'The run has ended.';
      else if (this.state.openQuestion(turn.runId)) reason = 'A question is waiting for the user.';
      else if (this.state.budget(turn.runId).remainingUsd <= 0) reason = 'The run budget is spent.';
    }
    if (reason) {
      turn.refusals += 1;
      if (turn.refusals >= this.limits.maxRefusalsBeforeStop) this.requestStop(turn, 'refusals');
    }
    return reason;
  }

  /** One planning call on its own Maka session at high effort; the plan is the tool result. */
  private async plan(
    turn: Turn,
    input: { playbook: Playbook; goal: string; context?: string },
    signal: AbortSignal,
  ): Promise<string> {
    const makaSessionId = await this.host.createSession({
      kind: 'planner',
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      thinkingLevel: this.effortOf(turn.runId, 'plannerEffort'),
      runId: turn.runId,
    });
    this.counters.planners += 1;
    turn.planners.add(makaSessionId);
    this.plannerTurns.set(makaSessionId, turn);
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= this.host
        .stop(makaSessionId)
        .catch((error: unknown) => this.warn('Stopping the planner failed', error));
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, this.limits.plannerTimeoutMs);
    this.counters.timers += 1;
    signal.addEventListener('abort', stop, { once: true });
    const texts: string[] = [];
    const errors: string[] = [];
    let completeReason: string | undefined;
    try {
      if (signal.aborted) stop();
      else {
        const text = plannerInput({
          ...input,
          remainingUsd: Math.max(0, this.state.budget(turn.runId).remainingUsd),
        });
        for await (const event of this.host.send(makaSessionId, text, 1)) {
          if (event.type === 'text_complete' && !event.interrupted) texts.push(event.text);
          else if (event.type === 'error' && !event.recoverable) errors.push(event.message);
          else if (event.type === 'complete') completeReason = event.stopReason;
        }
      }
    } catch (error) {
      errors.push(errorMessage(error));
    } finally {
      clearTimeout(timer);
      this.counters.timers -= 1;
      signal.removeEventListener('abort', stop);
      await stopping;
      this.host.releaseModelAccess(makaSessionId);
      turn.planners.delete(makaSessionId);
      this.plannerTurns.delete(makaSessionId);
      this.counters.planners -= 1;
    }
    if (signal.aborted)
      throw new ToolRefusal('run_must_stop', 'The run is stopping. End your turn now.');
    if (timedOut)
      throw new ToolRefusal('planner_timeout', 'Planning took too long. Plan the steps yourself.');
    if (errors.length > 0 || completeReason === 'error') {
      throw new ToolRefusal(
        'planner_failed',
        `Planning failed (${errors.at(-1) ?? 'model error'}). Plan the steps yourself.`,
      );
    }
    const plan = texts.join('\n\n').trim();
    if (!plan)
      throw new ToolRefusal(
        'planner_failed',
        'The planner returned no plan. Plan the steps yourself.',
      );
    return plan;
  }

  // Outbox. Events are rows in the conductor's database, written with the
  // change they report. Each conversation sends its rows in order, one at a
  // time; a row is acked when the outbox call resolves, and a failed one is
  // retried with backoff, holding up only its own conversation.

  private sendOutbox(conversationId: string): void {
    if (this.closed || this.sending.has(conversationId) || this.retryTimers.has(conversationId))
      return;
    const sending = this.drainOutbox(conversationId).finally(() => {
      this.sending.delete(conversationId);
      // A row written after the drain found the queue empty, but while this
      // sender was still registered, did not start a sender of its own.
      if (this.state.db.isOpen && this.state.nextOutbox(conversationId)) {
        this.sendOutbox(conversationId);
      }
    });
    this.sending.set(conversationId, sending);
  }

  private async drainOutbox(conversationId: string): Promise<void> {
    for (;;) {
      if (!this.state.db.isOpen) return;
      const row = this.state.nextOutbox(conversationId);
      if (!row) {
        this.hooks.outboxDrained?.(conversationId);
        return;
      }
      try {
        await this.deliver(row);
      } catch (error) {
        this.warn('The outbox failed; the event will be sent again', error);
        if (!this.state.db.isOpen) return;
        const attempts = this.state.outboxFailed(row.eventId);
        if (this.closed) return;
        const delay = Math.min(
          this.limits.outboxRetryMs * 2 ** Math.min(attempts - 1, 16),
          this.limits.outboxMaxRetryMs,
        );
        const timer = setTimeout(() => {
          this.retryTimers.delete(conversationId);
          this.sendOutbox(conversationId);
        }, delay);
        timer.unref();
        this.retryTimers.set(conversationId, timer);
        return;
      }
      if (!this.state.db.isOpen) return;
      this.state.ackOutbox(row.eventId);
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    switch (row.kind) {
      case 'message':
        return this.outbox.message(row.payload as unknown as OutboxMessage);
      case 'question':
        return this.outbox.question(row.payload as unknown as OutboxQuestion);
      case 'notice':
        return this.outbox.notice(row.payload as unknown as OutboxNotice);
      case 'answered':
        return this.outbox.answered?.(row.payload as unknown as OutboxAnswered);
    }
  }
}

/** The first and the longest wait between two looks at a task kept across a restart. */
const FOLLOW_FIRST_MS = 1_000;
const FOLLOW_MAX_MS = 10_000;

/** The adapter's error kinds that pass by themselves; `auth`, billing, a rejected request and `unknown` are not among them. */
const TRANSIENT_MODEL_ERRORS: ReadonlySet<string> = new Set([
  'network',
  'provider_capacity',
  'provider_unavailable',
  'rate_limit',
  'stream_truncated',
  'timeout',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
