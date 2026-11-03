import {
  consultDecisions,
  type DecisionBook,
  type DecisionCardDraft,
  type DecisionConsult,
  type DecisionEntry,
  type DecisionScope,
  type MustAskPending,
} from './decisions.js';
import type { ProposedAction } from './types.js';

/**
 * Must-ask whitelist. Defaults may be tightened per tenant, never loosened.
 * Aligns with Safety.gate and #475 speculative_blocked — does not replace them.
 */

export const MUST_ASK_CATEGORIES = [
  'delete_data',
  'delete_branch',
  'stop_service',
  'deploy',
  'spend_over_budget',
  'outbound_message',
  'product_direction',
  'rotate_secrets',
  'change_permissions',
  'db_migration',
  'force_push',
] as const;

export type MustAskCategory = (typeof MUST_ASK_CATEGORIES)[number];

/** These three always open a card, even when the ledger already has a "decided" row. */
export const ALWAYS_ASK = ['delete_data', 'rotate_secrets', 'spend_over_budget'] as const;
export type AlwaysAskCategory = (typeof ALWAYS_ASK)[number];

export function isMustAskCategory(value: string): value is MustAskCategory {
  return (MUST_ASK_CATEGORIES as readonly string[]).includes(value);
}

export function isAlwaysAsk(category: string, policy: MustAskPolicy = DEFAULT_MUST_ASK): boolean {
  return (policy.alwaysAsk as readonly string[]).includes(category);
}

export interface MustAskPolicy {
  categories: readonly MustAskCategory[];
  alwaysAsk: readonly MustAskCategory[];
  extraPatterns: ReadonlyArray<{ category: MustAskCategory; pattern: string }>;
}

export const DEFAULT_MUST_ASK: MustAskPolicy = {
  categories: MUST_ASK_CATEGORIES,
  alwaysAsk: ALWAYS_ASK,
  extraPatterns: [],
};

export interface TenantMustAskOverlay {
  extraAlwaysAsk?: MustAskCategory[];
  extraPatterns?: Array<{ category: MustAskCategory; pattern: string }>;
  /** Rejected when it names a default category. */
  disable?: MustAskCategory[];
  /** Rejected when it names a default always-ask category. */
  removeAlwaysAsk?: MustAskCategory[];
}

export function mergeMustAskPolicy(
  overlay: TenantMustAskOverlay,
  base: MustAskPolicy = DEFAULT_MUST_ASK,
): { ok: true; policy: MustAskPolicy } | { ok: false; reason: 'cannot_loosen' } {
  const defaults = new Set<string>(base.categories);
  if (overlay.disable?.some((category) => defaults.has(category))) {
    return { ok: false, reason: 'cannot_loosen' };
  }
  const always = new Set<string>(base.alwaysAsk);
  if (overlay.removeAlwaysAsk?.some((category) => always.has(category))) {
    return { ok: false, reason: 'cannot_loosen' };
  }
  const extraAlways = overlay.extraAlwaysAsk ?? [];
  const alwaysAsk = uniqueCategories([...base.alwaysAsk, ...extraAlways]);
  return {
    ok: true,
    policy: {
      categories: [...base.categories],
      alwaysAsk,
      extraPatterns: [...base.extraPatterns, ...(overlay.extraPatterns ?? [])],
    },
  };
}

const KIND_CATEGORY: Partial<Record<ProposedAction['kind'], MustAskCategory>> = {
  secrets: 'rotate_secrets',
  spend: 'spend_over_budget',
};

const BOUND_PATTERNS: ReadonlyArray<{ category: MustAskCategory; re: RegExp }> = [
  { category: 'force_push', re: /\b(force[- ]push|git push --force|--force-with-lease)\b/iu },
  {
    category: 'delete_data',
    re: /\b(drop table|delete data|rm -rf|wipe (db|data)|truncate|purge)\b/iu,
  },
  { category: 'delete_branch', re: /\b(delete branch|git branch -D|remove branch)\b/iu },
  { category: 'stop_service', re: /\b(stop service|scale to 0|take down|undeploy)\b/iu },
  { category: 'db_migration', re: /\b(migration|migrate|alembic|prisma migrate)\b/iu },
  {
    category: 'rotate_secrets',
    re: /\b(rotate (api )?key|new secret|create (an )?api key|credential)\b/iu,
  },
  {
    category: 'change_permissions',
    re: /\b(permission|iam policy|workflow dispatch|signing key|codeowners)\b/iu,
  },
  {
    category: 'product_direction',
    re: /\b(product direction|pivot|kill the feature|change the roadmap)\b/iu,
  },
  {
    category: 'outbound_message',
    re: /\b(comment|email|slack|feishu|post a message|notify the customer)\b/iu,
  },
  { category: 'deploy', re: /\b(deploy|rollout|release to prod)\b/iu },
  { category: 'spend_over_budget', re: /\b(over budget|increase budget|spend \$)\b/iu },
];

export function classifyAction(
  action: ProposedAction,
  policy: MustAskPolicy = DEFAULT_MUST_ASK,
): MustAskCategory | undefined {
  if (action.category && isMustAskCategory(action.category)) {
    if ((policy.categories as readonly string[]).includes(action.category)) return action.category;
  }
  const text = action.boundText;
  for (const row of policy.extraPatterns) {
    try {
      if (new RegExp(row.pattern, 'i').test(text)) return row.category;
    } catch {
      if (text.toLowerCase().includes(row.pattern.toLowerCase())) return row.category;
    }
  }
  if (action.kind === 'deploy') {
    return /\b(stop service|scale to 0|take down|undeploy)\b/iu.test(text)
      ? 'stop_service'
      : 'deploy';
  }
  if (action.kind === 'push_protected') {
    return /\b(force[- ]push|git push --force|--force-with-lease)\b/iu.test(text)
      ? 'force_push'
      : undefined;
  }
  const fromKind = KIND_CATEGORY[action.kind];
  if (fromKind) return fromKind;
  for (const row of BOUND_PATTERNS) {
    if (row.re.test(text)) return row.category;
  }
  return undefined;
}

export function scopeOfAction(
  action: ProposedAction,
  tenantId: string,
  repo?: string,
  category?: string,
): DecisionScope {
  const resolved = category ?? classifyAction(action) ?? action.kind;
  return {
    tenantId,
    ...(repo ? { repo } : {}),
    category: resolved,
    ...(action.object ? { object: action.object } : {}),
    ...(action.path ? { path: action.path } : {}),
    ...(action.tags && action.tags.length > 0 ? { tags: [...action.tags] } : {}),
  };
}

export type BeforeAskResult =
  | { kind: 'apply_decided'; entry: DecisionEntry; category: string }
  | { kind: 'apply_refused'; entry: DecisionEntry; category: string }
  | {
      kind: 'must_ask';
      category: MustAskCategory;
      hints?: DecisionEntry[];
      alwaysAsk: boolean;
    }
  | { kind: 'agent_may'; hints?: DecisionEntry[]; category?: string }
  | {
      kind: 'already_blocked';
      reason: 'speculative_blocked' | 'held' | 'intensity_observe' | 'review_required';
    };

export function consultBeforeAsk(input: {
  book: DecisionBook | { consult(query: DecisionScope): DecisionConsult };
  policy?: MustAskPolicy;
  action: ProposedAction;
  tenantId: string;
  repo?: string;
  worker?: { speculative?: { status?: string } };
  gate?: { allowed: boolean; reason?: string };
}): BeforeAskResult {
  const policy = input.policy ?? DEFAULT_MUST_ASK;
  if (input.gate && !input.gate.allowed && input.gate.reason) {
    if (
      input.gate.reason === 'speculative_blocked' ||
      input.gate.reason === 'held' ||
      input.gate.reason === 'intensity_observe' ||
      input.gate.reason === 'review_required'
    ) {
      return { kind: 'already_blocked', reason: input.gate.reason };
    }
  }
  if (input.worker && speculativeBlocksOutbound(input.worker, input.action)) {
    return { kind: 'already_blocked', reason: 'speculative_blocked' };
  }
  const category = classifyAction(input.action, policy);
  const scope = scopeOfAction(input.action, input.tenantId, input.repo, category);
  const found = input.book.consult(scope);
  const always = category !== undefined && isAlwaysAsk(category, policy);
  if (found.kind === 'exact' && !always) {
    return found.entry.polarity === 'refused'
      ? { kind: 'apply_refused', entry: found.entry, category: scope.category }
      : { kind: 'apply_decided', entry: found.entry, category: scope.category };
  }
  const hints =
    found.kind === 'fuzzy' ? found.hints : found.kind === 'exact' ? [found.entry] : undefined;
  if (category && (policy.categories as readonly string[]).includes(category)) {
    return {
      kind: 'must_ask',
      category,
      ...(hints && hints.length > 0 ? { hints } : {}),
      alwaysAsk: always,
    };
  }
  return {
    kind: 'agent_may',
    ...(hints && hints.length > 0 ? { hints } : {}),
    ...(category ? { category } : {}),
  };
}

/**
 * Duck-typed #475 check. Unaccepted speculative workers must not go outbound.
 * Safety.gate on that branch returns `speculative_blocked`; we do not re-hold.
 */
export function speculativeBlocksOutbound(
  worker: { speculative?: { status?: string } },
  action: ProposedAction,
): boolean {
  const status = worker.speculative?.status;
  if (status !== 'running' && status !== 'ready') return false;
  if (
    action.kind === 'merge' ||
    action.kind === 'push_protected' ||
    action.kind === 'deploy' ||
    action.kind === 'secrets' ||
    action.kind === 'other_irreversible' ||
    action.kind === 'spend'
  ) {
    return true;
  }
  return /\b(comment|open a pr|open pr|create pull|post review)\b/iu.test(action.boundText);
}

export function cardDraftFromMustAsk(pending: MustAskPending): DecisionCardDraft {
  const always = isAlwaysAsk(pending.category);
  return {
    tenantId: pending.tenantId,
    eventId: pending.eventId,
    threadId: pending.threadId ?? pending.object ?? pending.eventId,
    title: `Must ask: ${pending.category}`,
    reason: pending.boundText,
    band: 'high',
    score: {
      value: 0.9,
      urgency: always ? 0.95 : 0.8,
      risk: always ? 0.95 : 0.85,
      reason: `must_ask:${pending.category}`,
    },
  };
}

export function categoryFromApproval(kind: ProposedAction['kind'], boundText: string): string {
  return (
    classifyAction({ kind, boundText }) ??
    (kind === 'merge' ? 'merge' : kind === 'push_protected' ? 'push_protected' : kind)
  );
}

function uniqueCategories(values: readonly MustAskCategory[]): MustAskCategory[] {
  const seen = new Set<string>();
  const out: MustAskCategory[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
