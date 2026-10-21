import type { ModelGateway } from '@maka-cloud/conductor';
import {
  type CapEvent,
  deepSeekSearch,
  Gateway,
  type GatewayServer,
  type ModelPrice,
  modelTable,
  type SpendAccounts,
  type SpendJournal,
  searchUrl,
  serveGateway,
  type Vendor,
  vendorBaseUrl,
} from '@maka-cloud/gateway';
import type { ModelAccessProvider } from '@maka-cloud/runners';
import type { StackConfig } from './config.js';

/** Whose spend a request is, and where to tell them if a limit stops it. */
export interface Owner {
  inviteId: string;
  conversationId?: string;
}

function vendorOfRunner(runner: string): Vendor {
  if (runner === 'claude-agent-sdk') return 'anthropic';
  if (runner === 'codex') return 'openai';
  throw new Error(`The runner "${runner}" has no model route.`);
}

/**
 * Model access for sandbox runs: a gateway token per run, for the runner's vendor only, bound to
 * the run's budget and its tree's pool, and charged to the invite that owns the task. The vendor
 * key never leaves the host. A run without a budget or an owning invite gets no token. When the
 * gateway has web search, the token also pays for searches.
 */
export function gatewayModelAccess(
  gateway: Gateway,
  sandboxUrl: string,
  ownerOfTask: (taskId: string) => Owner | undefined,
): ModelAccessProvider {
  return {
    async issue({ taskId, runner, budgetUsd, budgetRootId, turnBudgetUsd, attempt }) {
      if (budgetUsd === undefined) {
        throw new Error('The task has no budget, so it gets no model access.');
      }
      const owner = ownerOfTask(taskId);
      if (owner === undefined) {
        throw new Error('The task has no owning invite, so it gets no model access.');
      }
      const vendor = vendorOfRunner(runner);
      const grant = gateway.issue({
        vendor,
        subject: taskId,
        taskId,
        account: { inviteId: owner.inviteId },
        ...(owner.conversationId === undefined ? {} : { conversationId: owner.conversationId }),
        ...(attempt === undefined ? {} : { attempt }),
        // A run is held to its turn's limit when that is the smaller, inside the pool of what its
        // whole tree has left.
        budget:
          turnBudgetUsd !== undefined && turnBudgetUsd < budgetUsd && budgetRootId !== undefined
            ? { limitUsd: turnBudgetUsd, poolId: budgetRootId, poolLimitUsd: budgetUsd }
            : {
                limitUsd:
                  turnBudgetUsd === undefined ? budgetUsd : Math.min(turnBudgetUsd, budgetUsd),
                ...(budgetRootId === undefined ? {} : { poolId: budgetRootId }),
              },
      });
      return {
        apiKey: grant.token,
        baseUrl: vendorBaseUrl(sandboxUrl, vendor),
        ...(gateway.canSearch ? { searchUrl: searchUrl(sandboxUrl) } : {}),
        revoke: () => grant.revoke(),
        meter: {
          spentUsd: () => grant.spend().spentUsd,
          subscribe: (listener) => grant.onSpend(listener),
        },
      };
    },
    revokeForTask: (taskId) => gateway.revokeForTask(taskId),
  };
}

/**
 * The conductor's requests through the gateway, each charged to the run ledger by the conductor's
 * `charge` and to the invite that owns the session's conversation. A session with no owning invite
 * can send nothing.
 */
export function conductorGateway(
  gateway: Gateway,
  ownerOfSession: (makaSessionId: string) => Owner | undefined,
): ModelGateway {
  return {
    open(charge, subject) {
      const owner = ownerOfSession(subject);
      if (owner === undefined) {
        return {
          fetch: () => Promise.reject(new Error('The conversation has no owning invite')),
          close: () => undefined,
        };
      }
      const client = gateway.inProcess({
        vendor: 'anthropic',
        subject,
        budget: charge,
        account: { inviteId: owner.inviteId },
        ...(owner.conversationId === undefined ? {} : { conversationId: owner.conversationId }),
      });
      return { fetch: client.fetch, close: () => client.revoke() };
    },
  };
}

/**
 * The gateway's prices: the configured ones, plus the price of each check model the
 * configuration and the built-in table do not already price.
 */
export function gatewayPrices(
  configured: readonly ModelPrice[],
  checks: readonly {
    vendor: Vendor;
    model: string;
    inputPerMTokUsd: number;
    outputPerMTokUsd: number;
    maxOutputTokens: number;
  }[],
): ModelPrice[] {
  const known = modelTable(configured);
  const added = checks
    .filter((entry) => !known.has(`${entry.vendor}:${entry.model}`))
    .map((entry) => ({
      vendor: entry.vendor,
      model: entry.model,
      inputPerMTokUsd: entry.inputPerMTokUsd,
      outputPerMTokUsd: entry.outputPerMTokUsd,
      maxOutputTokens: entry.maxOutputTokens,
    }));
  return [...configured, ...added];
}

export interface StackGateway {
  gateway: Gateway;
  server: GatewayServer;
  /** The gateway as sandboxes reach it. */
  sandboxUrl: string;
  close(): Promise<void>;
}

/**
 * The gateway with the vendor keys from `env`, and web search when `DEEPSEEK_API_KEY` is set,
 * listening where the config says. With `journal`, the spend of every task's grants is written
 * down as it happens. With `accounts`, every grant must name the invite it is charged to.
 */
export async function startGateway(
  config: StackConfig['gateway'],
  env: NodeJS.ProcessEnv,
  onWarning: (message: string, detail?: unknown) => void,
  models: readonly ModelPrice[] = config.models,
  journal?: SpendJournal,
  accounts?: SpendAccounts,
  onCap?: (event: CapEvent) => void,
): Promise<StackGateway> {
  const key = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const anthropic = key('ANTHROPIC_API_KEY');
  const openai = key('OPENAI_API_KEY');
  const search = key('DEEPSEEK_API_KEY');
  const gateway = new Gateway({
    upstreams: {
      ...(anthropic === undefined
        ? {}
        : {
            anthropic: {
              apiKey: anthropic,
              ...(config.anthropicBaseUrl === undefined
                ? {}
                : { baseUrl: config.anthropicBaseUrl }),
            },
          }),
      ...(openai === undefined
        ? {}
        : {
            openai: {
              apiKey: openai,
              ...(config.openAiBaseUrl === undefined ? {} : { baseUrl: config.openAiBaseUrl }),
            },
          }),
    },
    models,
    ...(search === undefined
      ? {}
      : {
          search: {
            provider: deepSeekSearch({
              apiKey: search,
              ...(config.searchBaseUrl === undefined ? {} : { baseUrl: config.searchBaseUrl }),
            }),
          },
        }),
    ...(journal === undefined ? {} : { journal }),
    ...(accounts === undefined ? {} : { accounts }),
    ...(onCap === undefined ? {} : { onCap }),
    onWarning: (message, detail) => onWarning(`model gateway: ${message}`, detail),
  });
  const server = await serveGateway(gateway, { host: config.host, port: config.port });
  return {
    gateway,
    server,
    sandboxUrl: config.publicUrl ?? server.url,
    close: async () => {
      gateway.close();
      await server.close();
    },
  };
}
