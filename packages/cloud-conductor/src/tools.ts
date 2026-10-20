import { randomUUID } from 'node:crypto';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { ConductorLimits } from './config.js';
import {
  authorityReaches,
  BUILTIN_TOOL_POLICY,
  playbookToolPolicy,
  type RunAuthority,
  type ToolPolicy,
  type ToolEffect,
} from './guard.js';
import type { OrchestratorLink } from './orchestrator-link.js';
import type { Manifest, Playbook } from './playbooks.js';
import type { BudgetView, ConductorState, HeldCall, QuestionOption, QuestionRow } from './state.js';

/** A tool call the conductor refuses. The model sees `code: message` as the tool error. */
export class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ToolRefusal';
  }
}

/** The conductor turn a tool call belongs to. */
export interface ActiveTurn {
  readonly runId: string;
  readonly conversationId: string;
  readonly link: OrchestratorLink;
  readonly signal: AbortSignal;
}

export interface ToolHost {
  readonly state: ConductorState;
  readonly limits: ConductorLimits;
  readonly playbooks: readonly Playbook[];
  turnFor(ctx: MakaToolContext): ActiveTurn;
  /** Why the run must stop now, if it must; counts the refusal against the turn. */
  mustStop(turn: ActiveTurn): string | undefined;
  plan(
    turn: ActiveTurn,
    input: { playbook: Playbook; goal: string; context?: string },
    signal: AbortSignal,
  ): Promise<string>;
  /** Opens the code-built budget question for a step that does not fit. */
  askBudget(turn: ActiveTurn, needUsd: number): QuestionRow | undefined;
  /** Sends a question already written to the outbox with it. */
  postQuestion(question: QuestionRow): void;
  postNotice(turn: ActiveTurn, text: string): void;
  /** Settles the delegation behind a task view once the view shows the task ended. */
  settleTask(view: Record<string, unknown> | undefined): void;
  /**
   * Whether the model decided this turn's current tool calls on tainted context: the
   * conversation was tainted when the request they answer was sent (T15).
   */
  decidedOnTaint(turn: ActiveTurn): boolean;
  /** Whether who approved a held call may still have it run (their invite is active and owns the conversation). */
  approverAuthorized(approvedBy: string | null, conversationId: string): boolean;
}

/**
 * A tool a playbook adds. `irreversible` tools are held until the user approves the call; a tool
 * with any other effect is held the same way once the conversation is tainted (T15).
 */
export interface ConductorToolSpec<P extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  parameters: P;
  irreversible?: boolean;
  /** What the tool does outside the conductor. Required: `[]` only for a tool that does none. */
  effects: readonly ToolEffect[];
  /**
   * Whether the result can carry content from outside the user; a call with one taints the
   * conversation before it runs. Defaults to true; set false only for a result built by code.
   */
  externalResult?: boolean;
  /**
   * The lowest standing-duty authority that may call the tool (T23). A run started by a duty may
   * not call a tool that has effects and declares none. A run a user starts is not limited by it.
   */
  requiresAuthority?: RunAuthority;
  /**
   * For an irreversible tool: what the approval card must also show about a held call (what it
   * will act on), built by code from the held arguments and shown under the call itself.
   */
  approvalDetails?(args: z.infer<P>): Promise<string> | string;
  impl(
    args: z.infer<P>,
    context: { runId: string; conversationId: string; signal: AbortSignal },
  ): Promise<unknown>;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

function budgetSummary(budget: BudgetView) {
  return {
    budgetUsd: round(budget.budgetUsd),
    spentUsd: round(budget.spentUsd),
    remainingUsd: round(budget.remainingUsd),
  };
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function signalOf(turn: ActiveTurn, ctx: MakaToolContext): AbortSignal {
  return AbortSignal.any([turn.signal, ctx.abortSignal]);
}

function gate(host: ToolHost, turn: ActiveTurn): void {
  const reason = host.mustStop(turn);
  if (reason) throw new ToolRefusal('run_must_stop', `${reason} End your turn now.`);
}

function asManifest(view: Record<string, unknown> | undefined): Manifest | undefined {
  if (!view || view.state !== 'succeeded') return undefined;
  const manifest = view.manifest as Manifest | undefined;
  return manifest && Array.isArray(manifest.notDone) ? manifest : undefined;
}

/**
 * The conductor's tools. Their definitions never change, so the request's
 * `tools` array is byte-stable for the life of a session.
 */
export function conductorTools(
  host: ToolHost,
  extra: readonly ConductorToolSpec[] = [],
): MakaTool[] {
  const playbookIds = host.playbooks.map((playbook) => playbook.id) as [string, ...string[]];
  const playbookOf = (id: string | null) => host.playbooks.find((playbook) => playbook.id === id);

  const verifyView = (turn: ActiveTurn, view: Record<string, unknown> | undefined) => {
    const manifest = asManifest(view);
    if (!manifest) return view;
    const playbook = playbookOf(host.state.run(turn.runId)?.playbook ?? null);
    return playbook ? { ...view, verification: playbook.verify(manifest) } : view;
  };

  const forward = async (
    turn: ActiveTurn,
    ctx: MakaToolContext,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await turn.link.call(name, args, signalOf(turn, ctx));
    if (result.isError) throw new ToolRefusal('orchestrator_error', result.text);
    host.settleTask(result.structured);
    return verifyView(turn, result.structured);
  };

  const startPlaybook: MakaTool<{ playbook: string; goal: string; context?: string }> = {
    name: 'start_playbook',
    description:
      'Pick the playbook for this run and get a plan for it. Call it once per run, before delegating.',
    parameters: z.object({
      playbook: z.enum(playbookIds).describe('The playbook that fits the goal'),
      goal: z.string().min(1).max(20_000).describe("The user's goal in your words"),
      context: z
        .string()
        .max(20_000)
        .optional()
        .describe('What the planner needs from the conversation'),
    }),
    impl: async (args, ctx) => {
      const turn = host.turnFor(ctx);
      gate(host, turn);
      const playbook = playbookOf(args.playbook);
      if (!playbook) throw new ToolRefusal('unknown_playbook', `No playbook "${args.playbook}".`);
      if (!host.state.setPlaybook(turn.runId, playbook.id)) {
        throw new ToolRefusal(
          'playbook_already_started',
          `This run already uses the ${host.state.run(turn.runId)?.playbook} playbook.`,
        );
      }
      const plan = await host.plan(
        turn,
        { playbook, goal: args.goal, ...(args.context ? { context: args.context } : {}) },
        signalOf(turn, ctx),
      );
      return {
        playbook: playbook.id,
        allowedRunners: playbook.allowedRunners,
        steps: playbook.steps,
        plan,
        budget: budgetSummary(host.state.budget(turn.runId)),
      };
    },
  };

  const delegateTask: MakaTool<{
    runner: string;
    brief: string;
    title?: string;
    mode?: 'async' | 'wait';
    timeoutMs?: number;
    budgetUsd: number;
  }> = {
    name: 'delegate_task',
    description:
      'Start a child task on a runner with a self-contained brief. budgetUsd is reserved from the run budget and caps what the task and everything it delegates may spend: the task is cancelled when its spend reaches it. mode "async" (default) returns the task at once; "wait" blocks until it ends or timeoutMs passes.',
    parameters: z.object({
      runner: z.string().min(1).describe('A runner the playbook allows'),
      brief: z.string().min(1).max(200_000).describe('What the runner must do, self-contained'),
      title: z.string().max(200).optional(),
      mode: z.enum(['async', 'wait']).optional(),
      timeoutMs: z.number().int().min(0).max(600_000).optional(),
      budgetUsd: z
        .number()
        .positive()
        .max(host.limits.maxDelegationUsd)
        .describe('Dollars this task may spend'),
    }),
    impl: async (args, ctx) => {
      const turn = host.turnFor(ctx);
      gate(host, turn);
      const playbook = playbookOf(host.state.run(turn.runId)?.playbook ?? null);
      if (!playbook) throw new ToolRefusal('no_playbook', 'Call start_playbook first.');
      if (!playbook.allowedRunners.includes(args.runner)) {
        throw new ToolRefusal(
          'runner_not_allowed',
          `The ${playbook.id} playbook delegates only to: ${playbook.allowedRunners.join(', ')}.`,
        );
      }
      // Check, reserve and store the delegation in one synchronous transaction,
      // before any await. From here on a stop finds the task by this key, even
      // if the response that names it never arrives.
      const key = `dlg_${randomUUID().replaceAll('-', '')}`;
      const reserved = host.state.reserveDelegation(turn.runId, args.budgetUsd, key);
      if (!reserved.ok) {
        if (reserved.reason === 'question_open') {
          throw new ToolRefusal(
            'run_must_stop',
            'A question is waiting for the user. End your turn now.',
          );
        }
        const question = host.askBudget(turn, args.budgetUsd);
        throw new ToolRefusal(
          'budget_exceeded',
          `This delegation needs ${money(args.budgetUsd)} but the run has ${money(reserved.budget.remainingUsd)} left.${question ? ' The user has been asked whether to raise the budget.' : ''} End your turn now.`,
        );
      }
      const { mode, timeoutMs, ...forwarded } = args;
      const signal = signalOf(turn, ctx);
      // From here the orchestrator answers with task views (T15 `ownTaint`).
      host.state.taint(turn.conversationId, 'tool:delegate_task');
      // Always async, so the task id comes back (and is stored) at once; a
      // "wait" is a separate task_wait the stop can interrupt with the id known.
      // If this call throws (abort, broken connection) the task may exist: the
      // reservation stays spent until a cancel by key settles it.
      const result = await turn.link.call(
        'delegate_task',
        { ...forwarded, mode: 'async', idempotencyKey: key },
        signal,
      );
      if (result.isError) {
        // Refused by the orchestrator: no task exists, the money comes back.
        host.state.settleDelegation(key, 0);
        throw new ToolRefusal('orchestrator_error', result.text);
      }
      const taskId = result.structured?.taskId;
      if (typeof taskId !== 'string') {
        throw new ToolRefusal('orchestrator_error', 'The orchestrator returned no task id.');
      }
      host.state.bindTask(key, taskId);
      let view = result.structured;
      if (mode === 'wait') {
        const waited = await turn.link.call(
          'task_wait',
          { taskId, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
          signal,
        );
        if (waited.isError) throw new ToolRefusal('orchestrator_error', waited.text);
        view = waited.structured;
      }
      host.settleTask(view);
      return {
        task: verifyView(turn, view),
        budget: budgetSummary(host.state.budget(turn.runId)),
      };
    },
  };

  const taskId = z.string().min(1).describe('Id returned by delegate_task');
  const waitMs = z.number().int().min(0).max(600_000).optional();

  const taskStatus: MakaTool<{ taskId: string }> = {
    name: 'task_status',
    description:
      'Current state of a task, with its result manifest and verification once it succeeded.',
    parameters: z.object({ taskId }),
    impl: async (args, ctx) => {
      const turn = host.turnFor(ctx);
      gate(host, turn);
      return forward(turn, ctx, 'task_status', args);
    },
  };

  const taskWait: MakaTool<{ taskId: string; timeoutMs?: number }> = {
    name: 'task_wait',
    description:
      'Block until the task ends or the timeout passes (default 60000 ms, at most 600000). A timeout does not cancel the task.',
    parameters: z.object({ taskId, timeoutMs: waitMs }),
    impl: async (args, ctx) => {
      const turn = host.turnFor(ctx);
      gate(host, turn);
      return forward(turn, ctx, 'task_wait', args);
    },
  };

  const taskCancel: MakaTool<{ taskId: string }> = {
    name: 'task_cancel',
    description: 'Cancel a task and everything it delegated.',
    parameters: z.object({ taskId }),
    impl: async (args, ctx) => {
      // Cancelling is always allowed: it only stops spending.
      const turn = host.turnFor(ctx);
      return forward(turn, ctx, 'task_cancel', args);
    },
  };

  const askUser: MakaTool<{
    reason: 'taste' | 'budget_overrun' | 'irreversible';
    question: string;
    options?: QuestionOption[];
    recommended?: string;
    estimateUsd?: number;
    actionRef?: string;
  }> = {
    name: 'ask_user',
    description:
      'Ask the user one question and end your turn. Only for taste (2-4 options and a recommendation), budget_overrun (estimateUsd: what the remaining work needs) or irreversible (actionRef of a held action).',
    parameters: z.object({
      reason: z.enum(['taste', 'budget_overrun', 'irreversible']),
      question: z.string().min(1).max(1000),
      options: z
        .array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(200) }))
        .max(4)
        .optional()
        .describe('taste only: 2 to 4 options'),
      recommended: z
        .string()
        .optional()
        .describe('The id of the option you recommend; for irreversible, "approve" or "reject"'),
      estimateUsd: z.number().positive().optional().describe('budget_overrun only'),
      actionRef: z.string().optional().describe('irreversible only'),
    }),
    executionSemantics: 'exclusive_step',
    finishTurnOnSuccess: true,
    impl: async (args, ctx) => {
      const turn = host.turnFor(ctx);
      const { state } = host;
      let question = args.question;
      let note: string | null = null;
      let action: HeldCall | null = null;
      let options: QuestionOption[];
      let recommended: string;
      let raiseToUsd: number | null = null;
      let actionRef: string | null = null;
      let check: () => { code: string; message: string } | undefined;
      switch (args.reason) {
        case 'taste': {
          options = args.options ?? [];
          const ids = new Set(options.map((option) => option.id));
          if (options.length < 2 || ids.size !== options.length) {
            throw new ToolRefusal(
              'invalid_options',
              'A taste question needs 2 to 4 distinct options.',
            );
          }
          if (!args.recommended || !ids.has(args.recommended)) {
            throw new ToolRefusal(
              'invalid_recommendation',
              'recommended must be one of the option ids.',
            );
          }
          recommended = args.recommended;
          check = () =>
            state.countQuestions(turn.runId, 'taste') >= host.limits.maxTasteQuestionsPerRun
              ? {
                  code: 'taste_limit',
                  message: `This run already asked ${host.limits.maxTasteQuestionsPerRun} taste questions. Pick the reasonable option, say which, and continue.`,
                }
              : undefined;
          break;
        }
        case 'budget_overrun': {
          const estimate = args.estimateUsd;
          if (estimate === undefined) {
            throw new ToolRefusal('invalid_request', 'budget_overrun needs estimateUsd.');
          }
          // A standing duty's budget is a hard limit: there is no card to raise it.
          if (state.run(turn.runId)?.hardBudget) {
            throw new ToolRefusal(
              'budget_fixed',
              'The budget of this standing duty cannot be raised. Finish within it, or report what you could not do and end your turn.',
            );
          }
          const now = state.budget(turn.runId);
          raiseToUsd = Math.ceil((now.spentUsd + estimate * 1.2) * 100) / 100;
          options = [
            { id: 'raise', label: `Raise the budget to ${money(raiseToUsd)}` },
            { id: 'stop', label: 'Stop here' },
          ];
          recommended = 'raise';
          check = () => {
            const budget = state.budget(turn.runId);
            return estimate <= budget.remainingUsd
              ? {
                  code: 'within_budget',
                  message: `The estimate ${money(estimate)} fits the ${money(budget.remainingUsd)} left. Continue without asking.`,
                }
              : undefined;
          };
          break;
        }
        case 'irreversible': {
          const ref = args.actionRef;
          if (!ref)
            throw new ToolRefusal(
              'invalid_request',
              'irreversible needs the actionRef of a held action.',
            );
          actionRef = ref;
          options = [
            { id: 'approve', label: 'Go ahead' },
            { id: 'reject', label: "Don't do it" },
          ];
          if (args.recommended !== 'approve' && args.recommended !== 'reject') {
            throw new ToolRefusal(
              'invalid_recommendation',
              'recommended must be "approve" or "reject".',
            );
          }
          recommended = args.recommended;
          // The card shows the held call as it will run, built here; the
          // model's words are only a note under it.
          const held = state.heldCall(ref);
          if (held && held.runId === turn.runId) {
            action = { tool: held.tool, args: held.args };
            const spec = extra.find((tool) => tool.name === held.tool);
            const details = spec?.approvalDetails
              ? await spec.approvalDetails(held.args as never)
              : held.tool === 'delegate_task'
                ? DELEGATION_DETAILS
                : undefined;
            // A built-in is held only for taint; a playbook tool also when it is irreversible.
            const builtin = BUILTIN_TOOL_POLICY[held.tool] !== undefined;
            const cause: HoldCause =
              builtin || (spec && !alwaysHeld(spec)) ? 'tainted' : 'irreversible';
            question = details
              ? `${approvalQuestion(action, cause)}\n\n${details}`
              : approvalQuestion(action, cause);
            note = args.question;
          }
          check = () => {
            const held = state.heldState(ref);
            return held && held.runId === turn.runId && held.state === 'held'
              ? undefined
              : {
                  code: 'no_held_action',
                  message:
                    'Ask about an irreversible action only with the actionRef a tool held for approval.',
                };
          };
          break;
        }
      }
      const opened = state.openQuestionIf(
        turn.runId,
        {
          reason: args.reason,
          question,
          note,
          action,
          options: [
            ...options.filter((option) => option.id === recommended),
            ...options.filter((option) => option.id !== recommended),
          ],
          recommended,
          raiseToUsd,
          actionRef,
        },
        check,
      );
      if (!opened.ok) throw new ToolRefusal(opened.code, opened.message);
      host.postQuestion(opened.question);
      return {
        questionId: opened.question.questionId,
        posted: true,
        next: 'End your turn now. The answer arrives as the next user message.',
      };
    },
  };

  const notify: MakaTool<{ text: string }> = {
    name: 'notify',
    description: 'Post a short progress note to the user without stopping.',
    parameters: z.object({ text: z.string().min(1).max(2000) }),
    impl: async (args, ctx) => {
      const turn = host.turnFor(ctx);
      gate(host, turn);
      if (!host.state.takeNotice(turn.runId, host.limits.maxNoticesPerRun)) {
        throw new ToolRefusal('notice_limit', 'This run has posted all the notes it may.');
      }
      host.postNotice(turn, args.text);
      return { posted: true };
    },
  };

  const extraTools = extra.map((spec) => playbookTool(host, spec));

  return [
    ...[startPlaybook, delegateTask, taskStatus, taskWait, taskCancel, askUser, notify].map(
      (tool) => withBuiltinPolicy(host, tool as MakaTool),
    ),
    ...extraTools,
  ];
}

/**
 * A built-in tool under its T15 policy. One with effects is held for the user's approval while
 * the conversation is tainted, decided before this call's own result can taint it. One whose
 * result can carry outside content taints the conversation before it runs, so neither its result
 * nor its error reaches the model before the taint is stored. A built-in with no policy is
 * refused when the tools are built.
 */
function withBuiltinPolicy(host: ToolHost, tool: MakaTool): MakaTool {
  const policy = BUILTIN_TOOL_POLICY[tool.name];
  if (!policy) throw new Error(`Built-in conductor tool ${tool.name} has no guard policy.`);
  const guarded = policy.effects.length > 0;
  if (!guarded && !policy.externalResult) return tool;
  return {
    ...tool,
    ...(guarded
      ? {
          description: `${tool.description} ${TAINT_HOLD_NOTE}`,
          parameters: (tool.parameters as z.ZodObject).extend({ actionRef: ACTION_REF }),
        }
      : {}),
    impl: async (raw: Record<string, unknown>, ctx: MakaToolContext) => {
      const turn = host.turnFor(ctx);
      let args = raw;
      if (guarded) {
        gate(host, turn);
        requireAuthority(host, turn, tool.name, policy, true);
        const { actionRef, ...rest } = raw as Record<string, unknown> & { actionRef?: string };
        holdUnlessApproved(host, turn, tool.name, rest, actionRef, false);
        args = rest;
      }
      if (policy.externalResult && !policy.ownTaint) {
        host.state.taint(turn.conversationId, `tool:${tool.name}`);
      }
      return tool.impl(args, ctx);
    },
  };
}

/**
 * A standing duty's authority is checked first and is final: a refused call is not held, no
 * approval can be given for it, and the answer to the model names no way around it. A tool with
 * effects that declared no `requiresAuthority` is out of reach of every duty.
 */
function requireAuthority(
  host: ToolHost,
  turn: ActiveTurn,
  tool: string,
  policy: ToolPolicy,
  guarded: boolean,
): void {
  const authority = host.state.run(turn.runId)?.authority ?? null;
  if (authority === null) return;
  const needed = policy.requiresAuthority;
  const allowed = needed === undefined ? !guarded : authorityReaches(authority, needed);
  if (!allowed) {
    throw new ToolRefusal(
      'not_authorized',
      `This standing duty has ${authority} authority, which does not allow ${tool}.`,
    );
  }
}

const ACTION_REF = z
  .string()
  .optional()
  .describe('The approved actionRef, after the user approved');

const TAINT_HOLD_NOTE =
  "Once the conversation has read outside content (task results, fetched pages, other people's messages), a call is held for the user's approval.";

/**
 * The approval gate of a guarded call: returns when it may run. A call with an actionRef runs
 * only on an approval of that exact call, used once. Without one, an always-held call, or any
 * guarded call the model decided on tainted context, is held and refused with its actionRef.
 * Tainted context is what the request the call answers carried, so calls made in one response
 * are judged alike, whatever order they run in. Synchronous, so nothing can change between the
 * check and the hold.
 */
function holdUnlessApproved(
  host: ToolHost,
  turn: ActiveTurn,
  tool: string,
  args: Record<string, unknown>,
  actionRef: string | undefined,
  always: boolean,
): void {
  if (actionRef !== undefined) {
    if (
      !host.state.consumeApproval(turn.runId, tool, actionRef, args, (approvedBy) =>
        host.approverAuthorized(approvedBy, turn.conversationId),
      )
    ) {
      throw new ToolRefusal('not_approved', `Action ${actionRef} is not approved for this call.`);
    }
    return;
  }
  if (always) {
    const ref = host.state.hold(turn.runId, tool, args);
    throw new ToolRefusal(
      'needs_approval',
      `This action cannot be undone. Ask the user with ask_user (reason "irreversible", actionRef "${ref}") and end your turn.`,
    );
  }
  if (host.decidedOnTaint(turn)) {
    const ref = host.state.hold(turn.runId, tool, args);
    throw new ToolRefusal(
      'needs_approval',
      `This conversation has read content from outside the user, so this action needs the user's approval. Ask the user with ask_user (reason "irreversible", actionRef "${ref}") and end your turn.`,
    );
  }
}

/** Under a held delegation: what the brief can do once it runs. */
const DELEGATION_DETAILS =
  'The runner works with full permissions and internet access, so it can send anything the brief asks for. Approve only a brief you would send yourself.';

const MAX_ARG_CHARS = 200;
const MAX_CALL_CHARS = 1500;

/** Why a call is held: it cannot be undone, or it has effects and the conversation is tainted. */
export type HoldCause = 'irreversible' | 'tainted';

/**
 * The approval question for a held call: the tool and every argument it will
 * run with, from the held row. Long values are cut, and the cut is marked.
 */
export function approvalQuestion(call: HeldCall, cause: HoldCause = 'irreversible'): string {
  const parts = Object.keys(call.args)
    .sort()
    .map((name) => {
      const value = JSON.stringify(call.args[name]) ?? 'undefined';
      return `${name}: ${value.length > MAX_ARG_CHARS ? `${value.slice(0, MAX_ARG_CHARS)}… (cut)` : value}`;
    });
  let shown = parts.join(', ');
  if (shown.length > MAX_CALL_CHARS) shown = `${shown.slice(0, MAX_CALL_CHARS)}… (cut)`;
  return cause === 'irreversible'
    ? `Allow ${call.tool}(${shown})? It cannot be undone.`
    : `Allow ${call.tool}(${shown})? This conversation has read content you did not write (such as web pages, repository files or other people's messages), so this action needs your approval.`;
}

/** Whether every call of the tool is held, tainted or not. */
function alwaysHeld(spec: ConductorToolSpec): boolean {
  return spec.irreversible === true || spec.effects.includes('irreversible');
}

/**
 * A playbook tool. An irreversible one never runs on the first call: the call
 * is held and the model must ask the user with its actionRef; after an
 * approval, the same call with that actionRef runs once. A tool with any other
 * effect is held the same way while the conversation is tainted (T15), checked
 * in code right before the call, with no await in between.
 */
function playbookTool(host: ToolHost, spec: ConductorToolSpec): MakaTool {
  const policy = playbookToolPolicy(spec);
  const always = alwaysHeld(spec);
  const guarded = always || policy.effects.length > 0;
  const parameters = guarded ? spec.parameters.extend({ actionRef: ACTION_REF }) : spec.parameters;
  return {
    name: spec.name,
    description: always
      ? `${spec.description} Irreversible: the first call is held for the user's approval.`
      : guarded
        ? `${spec.description} ${TAINT_HOLD_NOTE}`
        : spec.description,
    parameters,
    impl: async (raw: Record<string, unknown>, ctx: MakaToolContext) => {
      const turn = host.turnFor(ctx);
      gate(host, turn);
      requireAuthority(host, turn, spec.name, policy, guarded);
      const { actionRef, ...args } = raw as Record<string, unknown> & { actionRef?: string };
      if (guarded) holdUnlessApproved(host, turn, spec.name, args, actionRef, always);
      if (policy.externalResult) host.state.taint(turn.conversationId, `tool:${spec.name}`);
      return spec.impl(args as never, {
        runId: turn.runId,
        conversationId: turn.conversationId,
        signal: signalOf(turn, ctx),
      });
    },
  };
}
