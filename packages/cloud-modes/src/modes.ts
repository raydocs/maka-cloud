import { z } from 'zod';

/** The version of the config this code reads. A config of another version is refused, never guessed at. */
export const MODES_CONFIG_VERSION = 1;

export const MODE_IDS = ['quick', 'standard', 'deep'] as const;
export type ModeId = (typeof MODE_IDS)[number];

export function isModeId(value: unknown): value is ModeId {
  return typeof value === 'string' && (MODE_IDS as readonly string[]).includes(value);
}

/** Reasoning effort, passed to the vendor's CLI as it is. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];

/** The agents that implement and review: the Claude Agent SDK's CLI and Codex. */
export const AGENT_VENDORS = ['claude-agent-sdk', 'codex'] as const;
export type AgentVendor = (typeof AGENT_VENDORS)[number];

export type ModelVendor = 'anthropic' | 'openai';

export function otherVendor(vendor: AgentVendor): AgentVendor {
  return vendor === 'claude-agent-sdk' ? 'codex' : 'claude-agent-sdk';
}

/** Whose API an agent's model is called on. */
export function modelVendorOf(vendor: AgentVendor): ModelVendor {
  return vendor === 'claude-agent-sdk' ? 'anthropic' : 'openai';
}

export const ROLES = ['conductor', 'implementer', 'reviewer', 'helper'] as const;
export type Role = (typeof ROLES)[number];

/** A model id as a request names it. Becomes a command line argument, so the alphabet is small. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

const ModelId = z.string().regex(MODEL_ID, 'a model id: letters, digits and . _ : -');
const EffortSchema = z.enum(EFFORTS);
const Usd = z.number().finite().positive().max(10_000);

/** What an agent runs with in one role. No model: the CLI's own default. */
const AgentRoleSchema = z.object({ model: ModelId.optional(), effort: EffortSchema }).strict();

const PerVendorSchema = z
  .object({ 'claude-agent-sdk': AgentRoleSchema, codex: AgentRoleSchema })
  .strict();

const ModeSchema = z
  .object({
    /**
     * The conductor keeps one model for a whole conversation (its preserved thinking is checked
     * against it), so a mode sets only how hard it thinks: for its own turns and for planning.
     */
    conductor: z.object({ effort: EffortSchema, plannerEffort: EffortSchema }).strict(),
    implementer: PerVendorSchema,
    /** `reviewer[v]` is how vendor `v` reviews; it is used when the other vendor implemented. */
    reviewer: PerVendorSchema,
    /** Search, summaries, titles and briefs: the cheapest model that does them well. */
    helper: z
      .object({
        vendor: z.enum(['anthropic', 'openai']),
        model: ModelId,
        effort: EffortSchema,
      })
      .strict(),
    budget: z
      .object({
        /** The smallest run budget at which this mode makes sense. */
        minRunUsd: Usd,
        /** The run budget when the user did not set one. */
        defaultRunUsd: Usd,
        /** The most one delegation may reserve. */
        maxDelegationUsd: Usd,
        /** The part of a task's budget kept for review and fix, which the implementer cannot spend. */
        reviewShare: z.number().finite().min(0.05).max(0.5),
      })
      .strict(),
  })
  .strict();

export type ModeDef = z.infer<typeof ModeSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;

const ConfigSchema = z
  .object({
    version: z.literal(MODES_CONFIG_VERSION),
    modes: z.object({ quick: ModeSchema, standard: ModeSchema, deep: ModeSchema }).strict(),
  })
  .strict();

export type ModesConfig = z.infer<typeof ConfigSchema>;

/**
 * Anthropic models are named. Codex models are left to the CLI's default until the owner sets one:
 * the gateway prices only models it is told about, so naming an OpenAI model here would be a guess.
 */
export const DEFAULT_MODES: ModesConfig = {
  version: MODES_CONFIG_VERSION,
  modes: {
    quick: {
      conductor: { effort: 'low', plannerEffort: 'medium' },
      implementer: {
        'claude-agent-sdk': { model: 'claude-sonnet-5-5', effort: 'low' },
        codex: { effort: 'low' },
      },
      reviewer: {
        'claude-agent-sdk': { model: 'claude-sonnet-5-5', effort: 'low' },
        codex: { effort: 'low' },
      },
      helper: { vendor: 'anthropic', model: 'claude-haiku-5-5', effort: 'low' },
      budget: { minRunUsd: 0.5, defaultRunUsd: 2, maxDelegationUsd: 10, reviewShare: 0.2 },
    },
    standard: {
      conductor: { effort: 'medium', plannerEffort: 'high' },
      implementer: {
        'claude-agent-sdk': { model: 'claude-sonnet-5-5', effort: 'high' },
        codex: { effort: 'medium' },
      },
      reviewer: {
        'claude-agent-sdk': { model: 'claude-opus-5-5', effort: 'medium' },
        codex: { effort: 'medium' },
      },
      helper: { vendor: 'anthropic', model: 'claude-haiku-5-5', effort: 'low' },
      budget: { minRunUsd: 2, defaultRunUsd: 5, maxDelegationUsd: 50, reviewShare: 0.2 },
    },
    deep: {
      conductor: { effort: 'high', plannerEffort: 'xhigh' },
      implementer: {
        'claude-agent-sdk': { model: 'claude-opus-5-5', effort: 'high' },
        codex: { effort: 'high' },
      },
      reviewer: {
        'claude-agent-sdk': { model: 'claude-opus-5-5', effort: 'high' },
        codex: { effort: 'high' },
      },
      helper: { vendor: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' },
      budget: { minRunUsd: 10, defaultRunUsd: 20, maxDelegationUsd: 100, reviewShare: 0.25 },
    },
  },
};

export type ParsedModes = { ok: true; config: ModesConfig } | { ok: false; problems: string[] };

function budgetProblems(config: ModesConfig): string[] {
  const problems: string[] = [];
  let previous: { id: ModeId; minRunUsd: number } | undefined;
  for (const id of MODE_IDS) {
    const { budget } = config.modes[id];
    if (budget.defaultRunUsd < budget.minRunUsd) {
      problems.push(`${id}: defaultRunUsd is below minRunUsd`);
    }
    if (budget.maxDelegationUsd < budget.defaultRunUsd) {
      problems.push(`${id}: maxDelegationUsd is below defaultRunUsd`);
    }
    // Minimums that rise with the mode are what lets a budget alone pick exactly one mode.
    if (previous && budget.minRunUsd <= previous.minRunUsd) {
      problems.push(`${id}: minRunUsd must be above ${previous.id}'s`);
    }
    previous = { id, minRunUsd: budget.minRunUsd };
  }
  return problems;
}

/** Reads a config value (already JSON-decoded). Refuses anything not exactly the schema. */
export function modesConfigFrom(value: unknown): ParsedModes {
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`,
      ),
    };
  }
  const problems = budgetProblems(parsed.data);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: parsed.data };
}

/** Reads a config from JSON text. */
export function parseModesConfig(text: string): ParsedModes {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['config: not valid JSON'] };
  }
  return modesConfigFrom(value);
}

export interface ResolvedAgent {
  vendor: AgentVendor;
  /** Absent: the CLI's own default model. */
  model?: string;
  effort: Effort;
}

/** How `vendor` works as the implementer in `mode`. */
export function implementerFor(
  config: ModesConfig,
  mode: ModeId,
  vendor: AgentVendor,
): ResolvedAgent {
  const role = config.modes[mode].implementer[vendor];
  return { vendor, effort: role.effort, ...(role.model ? { model: role.model } : {}) };
}

/**
 * Who reviews a change that `implementer` made: always the other vendor. This is the only way to
 * ask for a reviewer, so no configuration can make them the same.
 */
export function reviewerFor(
  config: ModesConfig,
  mode: ModeId,
  implementer: AgentVendor,
): ResolvedAgent {
  const vendor = otherVendor(implementer);
  const role = config.modes[mode].reviewer[vendor];
  return { vendor, effort: role.effort, ...(role.model ? { model: role.model } : {}) };
}

export interface ModeChoice {
  mode: ModeId;
  /** Why this mode: the user asked, the conductor suggested it and the budget allows it, or only the budget. */
  source: 'user' | 'conductor' | 'budget';
}

/** The dearest mode whose minimum the budget meets, not above `ceiling`; the cheapest when none is met. */
function affordable(config: ModesConfig, budgetUsd: number, ceiling: ModeId): ModeId {
  let best: ModeId = MODE_IDS[0];
  for (const id of MODE_IDS) {
    if (config.modes[id].budget.minRunUsd <= budgetUsd) best = id;
    if (id === ceiling) break;
  }
  return best;
}

/**
 * Picks the mode of a run. The user's pick always stands. Otherwise the conductor's suggestion
 * stands unless the budget is too small for it, and with no suggestion the budget alone decides
 * and never goes above `standard`: `deep` is something somebody asks for.
 */
export function chooseMode(
  config: ModesConfig,
  input: { requested?: ModeId; suggested?: ModeId; budgetUsd?: number },
): ModeChoice {
  if (input.requested) return { mode: input.requested, source: 'user' };
  const budget = input.budgetUsd ?? config.modes.standard.budget.defaultRunUsd;
  if (input.suggested) {
    return { mode: affordable(config, budget, input.suggested), source: 'conductor' };
  }
  return { mode: affordable(config, budget, 'standard'), source: 'budget' };
}

/** Why a run in `mode` should not start with `budgetUsd`, or undefined when it can. */
export function budgetProblem(
  config: ModesConfig,
  mode: ModeId,
  budgetUsd: number,
): string | undefined {
  const { minRunUsd } = config.modes[mode].budget;
  return budgetUsd < minRunUsd
    ? `a ${mode} run needs a budget of at least $${minRunUsd}, this one has $${budgetUsd}`
    : undefined;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** A task's budget as the implementer may spend it and as review and fix may. The two never add up to more than the budget. */
export function splitBudget(
  config: ModesConfig,
  mode: ModeId,
  budgetUsd: number,
): { workUsd: number; reviewUsd: number } {
  const reviewUsd = roundUsd(budgetUsd * config.modes[mode].budget.reviewShare);
  return { workUsd: roundUsd(Math.max(0, budgetUsd - reviewUsd)), reviewUsd };
}

export interface NamedModel {
  vendor: ModelVendor;
  model: string;
}

/** Every model the config names, once each, for checking that the gateway has a price for it. */
export function modelsOf(config: ModesConfig): NamedModel[] {
  const seen = new Map<string, NamedModel>();
  const add = (vendor: ModelVendor, model: string | undefined): void => {
    if (model) seen.set(`${vendor}:${model}`, { vendor, model });
  };
  for (const id of MODE_IDS) {
    const mode = config.modes[id];
    for (const vendor of AGENT_VENDORS) {
      add(modelVendorOf(vendor), mode.implementer[vendor].model);
      add(modelVendorOf(vendor), mode.reviewer[vendor].model);
    }
    add(mode.helper.vendor, mode.helper.model);
  }
  return [...seen.values()];
}

/** The agent roles that run on the CLI's default model, which the gateway cannot price by name. */
export function unnamedModels(
  config: ModesConfig,
): { mode: ModeId; role: Role; vendor: AgentVendor }[] {
  const out: { mode: ModeId; role: Role; vendor: AgentVendor }[] = [];
  for (const id of MODE_IDS) {
    for (const role of ['implementer', 'reviewer'] as const) {
      for (const vendor of AGENT_VENDORS) {
        if (!config.modes[id][role][vendor].model) out.push({ mode: id, role, vendor });
      }
    }
  }
  return out;
}
