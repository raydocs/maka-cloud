import { createHash } from 'node:crypto';
import type { LlmConnection } from '@maka/core/llm-connections';

export const MODEL_ID = 'claude-opus-5-5';

/** Dollars per million tokens. */
export interface ModelPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Anthropic list prices for Claude Opus 5.5 (cache write at the 5-minute rate).
 * A stand-in until the model gateway's per-key usage ledger (T17) is the source.
 */
export const OPUS_5_5_PRICES: ModelPrices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export interface ModelAccess {
  /** API key for the Anthropic Messages API or the model gateway in front of it. Never stored. */
  apiKey: string;
  /** Messages API base URL, for example the gateway's. Defaults to Anthropic's. */
  baseUrl?: string;
  /** Stable id of this connection; every Maka session is created with it (T3 path 6). */
  connectionId?: string;
  /**
   * The model gateway in this process. With it, every model request is reserved in the run ledger
   * at its worst-case cost before it is sent and settled there at what it cost; the reported
   * usage is not charged again. Without it, requests go to `baseUrl` and spend is metered from
   * the reported usage after each call.
   */
  gateway?: ModelGateway;
}

/** Where the gateway charges one request. Both calls are synchronous: nothing spends between the check and the hold. */
export interface ModelCharge {
  reserve(key: string, usd: number): { ok: true } | { ok: false; reason: string; budget?: boolean };
  settle(key: string, usd: number): void;
}

export interface ModelGateway {
  /** A `fetch` whose requests are charged to `charge`. `close` cuts its requests in flight. */
  open(charge: ModelCharge, subject: string): { fetch: typeof fetch; close(): void };
}

export interface ConductorLimits {
  /** Dollar budget of a run unless raised by the user. */
  defaultRunBudgetUsd: number;
  /** Largest `budgetUsd` a single delegation may reserve. */
  maxDelegationUsd: number;
  /** Runs executing at once across all conversations. */
  maxConcurrentRuns: number;
  /** Inputs waiting behind a running turn in one conversation. */
  maxQueuedPerConversation: number;
  /** Wall-clock limit of one conductor turn. */
  turnTimeoutMs: number;
  /** Wall-clock limit of one planner call. */
  plannerTimeoutMs: number;
  /** Provider steps in one conductor turn. */
  maxStepsPerTurn: number;
  /** Tool calls refused because the run must stop before the turn is stopped by force. */
  maxRefusalsBeforeStop: number;
  /** `taste` questions per run. */
  maxTasteQuestionsPerRun: number;
  /** `notify` calls per run. */
  maxNoticesPerRun: number;
  /** First wait before an outbox event that failed to send is sent again; it doubles per failure. */
  outboxRetryMs: number;
  /** Longest wait between two sends of one outbox event. */
  outboxMaxRetryMs: number;
  /**
   * How long to wait before asking again about a task that ended while its run
   * was not known to have stopped. Its reservation is held until it has.
   */
  stopCheckMs: number;
}

export const DEFAULT_LIMITS: ConductorLimits = {
  defaultRunBudgetUsd: 5,
  maxDelegationUsd: 100,
  maxConcurrentRuns: 4,
  maxQueuedPerConversation: 5,
  turnTimeoutMs: 2 * 60 * 60 * 1000,
  plannerTimeoutMs: 10 * 60 * 1000,
  maxStepsPerTurn: 200,
  maxRefusalsBeforeStop: 2,
  maxTasteQuestionsPerRun: 2,
  maxNoticesPerRun: 20,
  outboxRetryMs: 1000,
  outboxMaxRetryMs: 60_000,
  stopCheckMs: 60_000,
};

export const CONNECTION_SLUG = 'conductor-anthropic';
const DEFAULT_CONNECTION_ID = 'maka-cloud-conductor-anthropic';

export function connectionIdOf(access: ModelAccess): string {
  return access.connectionId ?? DEFAULT_CONNECTION_ID;
}

/**
 * An API-key Anthropic connection. Maka's model metadata stops at
 * claude-opus-5, so the connection declares Opus 5.5's thinking levels itself.
 * No `compactionThreshold`: proactive compaction stays off (T3).
 */
export function conductorConnection(access: ModelAccess): LlmConnection {
  return {
    slug: CONNECTION_SLUG,
    name: 'Anthropic (conductor)',
    providerType: 'anthropic',
    ...(access.baseUrl ? { baseUrl: access.baseUrl } : {}),
    defaultModel: MODEL_ID,
    models: [{ id: MODEL_ID, contextWindow: 1_000_000 }],
    modelOverrides: {
      [MODEL_ID]: { thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * The route identity prior-turn thinking is admitted against. It depends only
 * on the connection id and model, so it stays the same across restarts.
 */
export function providerStateIdentity(access: ModelAccess): `sha256:${string}` {
  const digest = createHash('sha256')
    .update(`${connectionIdOf(access)}\0${MODEL_ID}`)
    .digest('hex');
  return `sha256:${digest}`;
}
