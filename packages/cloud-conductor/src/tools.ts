import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { ConductorLimits } from './config.js';
import type { OrchestratorLink } from './orchestrator-link.js';
import type { Manifest, Playbook } from './playbooks.js';
import type { BudgetView, ConductorState, QuestionOption, QuestionRow } from './state.js';

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
  askBudget(turn: ActiveTurn, needUsd: number): Promise<QuestionRow | undefined>;
  postQuestion(question: QuestionRow): Promise<void>;
  postNotice(turn: ActiveTurn, text: string): Promise<void>;
}

/** A tool a playbook adds. `irreversible` tools are held until the user approves the call. */
export interface ConductorToolSpec<P extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  parameters: P;
  irreversible?: boolean;
  /**
   * For an irreversible tool: what the approval card must show about a held call (what it will
   * act on), built by code and appended to the model's question so the user sees it as is.
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
      'Start a child task on a runner with a self-contained brief. budgetUsd is reserved from the run budget. mode "async" (default) returns the task at once; "wait" blocks until it ends or timeoutMs passes.',
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
      // Check and reserve in one synchronous transaction, before any await.
      const reserved = host.state.tryReserve(turn.runId, args.budgetUsd, 'delegate_task');
      if (!reserved.ok) {
        if (reserved.reason === 'question_open') {
          throw new ToolRefusal(
            'run_must_stop',
            'A question is waiting for the user. End your turn now.',
          );
        }
        const question = await host.askBudget(turn, args.budgetUsd);
        throw new ToolRefusal(
          'budget_exceeded',
          `This delegation needs ${money(args.budgetUsd)} but the run has ${money(reserved.budget.remainingUsd)} left.${question ? ' The user has been asked whether to raise the budget.' : ''} End your turn now.`,
        );
      }
      const { budgetUsd: _budget, ...forwarded } = args;
      // If this call throws (abort, broken connection) the task may exist, so
      // the reservation stays spent.
      const result = await turn.link.call('delegate_task', forwarded, signalOf(turn, ctx));
      if (result.isError) {
        // Refused by the orchestrator: no task exists, the money comes back.
        host.state.release(turn.runId, reserved.reservation);
        throw new ToolRefusal('orchestrator_error', result.text);
      }
      const taskId = result.structured?.taskId;
      if (typeof taskId === 'string') host.state.bindTask(taskId, turn.runId, reserved.reservation);
      return {
        task: verifyView(turn, result.structured),
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
      let options: QuestionOption[];
      let recommended: string;
      let raiseToUsd: number | null = null;
      let actionRef: string | null = null;
      let details: string | undefined;
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
          const held = state.heldAction(ref);
          const spec = held && extra.find((tool) => tool.name === held.tool);
          if (held && spec?.approvalDetails) {
            details = await spec.approvalDetails(held.args as never);
          }
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
          question: details ? `${args.question}\n\n${details}` : args.question,
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
      await host.postQuestion(opened.question);
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
      if (!host.state.takeNotice(turn.runId, host.limits.maxNoticesPerRun)) {
        throw new ToolRefusal('notice_limit', 'This run has posted all the notes it may.');
      }
      await host.postNotice(turn, args.text);
      return { posted: true };
    },
  };

  const extraTools = extra.map((spec) => playbookTool(host, spec));

  return [
    startPlaybook,
    delegateTask,
    taskStatus,
    taskWait,
    taskCancel,
    askUser,
    notify,
    ...extraTools,
  ];
}

/**
 * A playbook tool. An irreversible one never runs on the first call: the call
 * is held and the model must ask the user with its actionRef; after an
 * approval, the same call with that actionRef runs once.
 */
function playbookTool(host: ToolHost, spec: ConductorToolSpec): MakaTool {
  const parameters = spec.irreversible
    ? spec.parameters.extend({
        actionRef: z
          .string()
          .optional()
          .describe('The approved actionRef, after the user approved'),
      })
    : spec.parameters;
  return {
    name: spec.name,
    description: spec.irreversible
      ? `${spec.description} Irreversible: the first call is held for the user's approval.`
      : spec.description,
    parameters,
    impl: async (raw: Record<string, unknown>, ctx: MakaToolContext) => {
      const turn = host.turnFor(ctx);
      gate(host, turn);
      const { actionRef, ...args } = raw as Record<string, unknown> & { actionRef?: string };
      if (spec.irreversible) {
        if (actionRef === undefined) {
          const ref = host.state.hold(turn.runId, spec.name, args);
          throw new ToolRefusal(
            'needs_approval',
            `This action cannot be undone. Ask the user with ask_user (reason "irreversible", actionRef "${ref}") and end your turn.`,
          );
        }
        if (!host.state.consumeApproval(turn.runId, spec.name, actionRef, args)) {
          throw new ToolRefusal(
            'not_approved',
            `Action ${actionRef} is not approved for this call.`,
          );
        }
      }
      return spec.impl(args as never, {
        runId: turn.runId,
        conversationId: turn.conversationId,
        signal: signalOf(turn, ctx),
      });
    },
  };
}
