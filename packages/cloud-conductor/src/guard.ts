/**
 * T15: what each conductor tool does outside the conductor, and whether what
 * it returns can carry content from outside the user. The tool gate in
 * `tools.ts` enforces it in code: once a conversation has read outside
 * content, a tool with any effect is held for the user's approval.
 */

/**
 * - `writes_outside_sandbox`: changes something outside the task's sandbox (a
 *   repository on GitHub, an issue, a file the user keeps);
 * - `sends`: sends anything to anyone other than the user;
 * - `spends`: spends money outside the run budget the user set;
 * - `irreversible`: cannot be undone; like `irreversible: true` on the spec, it
 *   holds every call, tainted or not.
 */
export const TOOL_EFFECTS = ['writes_outside_sandbox', 'sends', 'spends', 'irreversible'] as const;

export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/**
 * T23: what a standing-duty run may do, lowest first. A run started by a duty carries one for its
 * whole life; a run a user starts has none and is limited by the rest of the gate only.
 */
export const RUN_AUTHORITIES = ['read-only', 'open-pr', 'merge-when-green'] as const;

export type RunAuthority = (typeof RUN_AUTHORITIES)[number];

export const isRunAuthority = (value: unknown): value is RunAuthority =>
  (RUN_AUTHORITIES as readonly unknown[]).includes(value);

export const authorityReaches = (have: RunAuthority, need: RunAuthority): boolean =>
  RUN_AUTHORITIES.indexOf(have) >= RUN_AUTHORITIES.indexOf(need);

export interface ToolPolicy {
  /** Empty only for a tool that does none of the effects. */
  readonly effects: readonly ToolEffect[];
  /** Whether the result can carry content from outside the user. */
  readonly externalResult: boolean;
  /**
   * The tool stores the taint itself, right before the step that can return outside content,
   * instead of when the call starts: a call refused before that step returns only code-built text.
   */
  readonly ownTaint?: true;
  /** The lowest duty authority that may call the tool. A duty run may not call a tool with effects and none. */
  readonly requiresAuthority: RunAuthority | undefined;
}

/**
 * The built-in tools. `delegate_task` `sends`: its brief goes to a runner with
 * full permissions and network access, which can send anything anywhere, so a
 * delegation from a tainted conversation is held for the user's approval (the
 * run budget limits spending, not sending). The planner behind
 * `start_playbook` spends inside the run budget, which is not `spends`.
 * `ask_user` and `notify` reach only the user. Every tool that returns a task
 * view taints: a task view carries what a runner read and wrote (web pages,
 * repository files, other people's text). `delegate_task` taints right before
 * it calls the orchestrator, so a delegation refused for its budget does not.
 */
export const BUILTIN_TOOL_POLICY: Readonly<Record<string, ToolPolicy>> = {
  start_playbook: { effects: [], externalResult: false, requiresAuthority: undefined },
  delegate_task: {
    effects: ['sends'],
    externalResult: true,
    ownTaint: true,
    requiresAuthority: undefined,
  },
  task_status: { effects: [], externalResult: true, requiresAuthority: undefined },
  task_wait: { effects: [], externalResult: true, requiresAuthority: undefined },
  task_cancel: { effects: [], externalResult: true, requiresAuthority: undefined },
  ask_user: { effects: [], externalResult: false, requiresAuthority: undefined },
  notify: { effects: [], externalResult: false, requiresAuthority: undefined },
};

/**
 * The policy a playbook tool declares, checked at runtime too: `effects` must
 * be a list of known effects, so a tool built without one (or from plain
 * JavaScript) is refused instead of skipping the gate. A result is external
 * unless the tool says otherwise.
 */
export function playbookToolPolicy(spec: {
  name: string;
  effects?: unknown;
  externalResult?: unknown;
  requiresAuthority?: unknown;
}): ToolPolicy {
  const { effects } = spec;
  if (
    !Array.isArray(effects) ||
    effects.some((effect) => !(TOOL_EFFECTS as readonly unknown[]).includes(effect))
  ) {
    throw new Error(
      `Conductor tool ${spec.name} must declare its effects, each one of: ${TOOL_EFFECTS.join(', ')}.`,
    );
  }
  if (spec.externalResult !== undefined && typeof spec.externalResult !== 'boolean') {
    throw new Error(`Conductor tool ${spec.name}: externalResult must be a boolean.`);
  }
  if (spec.requiresAuthority !== undefined && !isRunAuthority(spec.requiresAuthority)) {
    throw new Error(
      `Conductor tool ${spec.name}: requiresAuthority must be one of: ${RUN_AUTHORITIES.join(', ')}.`,
    );
  }
  return {
    effects: [...new Set(effects as ToolEffect[])],
    externalResult: spec.externalResult !== false,
    requiresAuthority: spec.requiresAuthority,
  };
}
