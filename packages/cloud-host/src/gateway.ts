import type { ModelGateway } from '@maka-cloud/conductor';
import {
  Gateway,
  type GatewayServer,
  type ModelPrice,
  modelTable,
  serveGateway,
  type Vendor,
  vendorBaseUrl,
} from '@maka-cloud/gateway';
import type { ModelAccessProvider } from '@maka-cloud/runners';
import type { StackConfig } from './config.js';

function vendorOfRunner(runner: string): Vendor {
  if (runner === 'claude-agent-sdk') return 'anthropic';
  if (runner === 'codex') return 'openai';
  throw new Error(`The runner "${runner}" has no model route.`);
}

/**
 * Model access for sandbox runs: a gateway token per run, for the runner's vendor only, bound to
 * the run's budget and its tree's pool. The vendor key never leaves the host. A run without a
 * budget gets no token.
 */
export function gatewayModelAccess(gateway: Gateway, sandboxUrl: string): ModelAccessProvider {
  return {
    async issue({ taskId, runner, budgetUsd, budgetRootId }) {
      if (budgetUsd === undefined) {
        throw new Error('The task has no budget, so it gets no model access.');
      }
      const vendor = vendorOfRunner(runner);
      const grant = gateway.issue({
        vendor,
        subject: taskId,
        taskId,
        budget: {
          limitUsd: budgetUsd,
          ...(budgetRootId === undefined ? {} : { poolId: budgetRootId }),
        },
      });
      return {
        apiKey: grant.token,
        baseUrl: vendorBaseUrl(sandboxUrl, vendor),
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

/** The conductor's requests through the gateway, each charged to the run ledger by the conductor's `charge`. */
export function conductorGateway(gateway: Gateway): ModelGateway {
  return {
    open(charge, subject) {
      const client = gateway.inProcess({ vendor: 'anthropic', subject, budget: charge });
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

/** The gateway with the vendor keys from `env`, listening where the config says. */
export async function startGateway(
  config: StackConfig['gateway'],
  env: NodeJS.ProcessEnv,
  onWarning: (message: string, detail?: unknown) => void,
  models: readonly ModelPrice[] = config.models,
): Promise<StackGateway> {
  const key = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const anthropic = key('ANTHROPIC_API_KEY');
  const openai = key('OPENAI_API_KEY');
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
