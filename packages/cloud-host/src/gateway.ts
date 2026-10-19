import {
  Gateway,
  type GatewayServer,
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
    models: config.models,
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
