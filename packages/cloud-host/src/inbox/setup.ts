import type { Conductor } from '@maka-cloud/conductor';
import type { Gateway } from '@maka-cloud/gateway';
import type { InboxService, SupervisorParts } from '@maka-cloud/server';
import {
  createSourceFetcher,
  type SourceFetcher,
  Supervisor,
  type SupervisorHost,
  type SummaryModel,
  type VerifierModel,
} from '@maka-cloud/supervisor';
import { conductorBudget } from './budget.js';
import type { InboxConfig } from './config.js';
import { artifactEvidence } from './evidence.js';
import {
  createGatewaySummaryModel,
  createGatewayVerifierModel,
  createSummaryModel,
  createVerifierModel,
  dailyLimit,
  type ModelDeps,
  SUMMARY_DAILY_CAP_USD,
} from './models.js';
import { conductorNotifier } from './notifier.js';
import { inboxService } from './service.js';

export interface InboxContext {
  parts: SupervisorParts;
  conductor: Conductor;
}

export interface InboxSetup {
  /** The supervisor's own database. */
  dbPath: string;
  config: InboxConfig;
  env: NodeJS.ProcessEnv;
  /** Base URL of the Messages API for the summary model, when a gateway is used. */
  anthropicBaseUrl?: string;
  /**
   * The model gateway. With it, the checks and the digest summary reach the vendors through it,
   * each request reserved at its worst case first; without it they call the vendors with the
   * keys in `env`.
   */
  gateway?: Gateway;
  /** Replaces what is built from the config, for tests. */
  override?: {
    models?: readonly VerifierModel[];
    summary?: SummaryModel;
    fetcher?: SourceFetcher;
    modelDeps?: ModelDeps;
    now?: () => number;
    tickMs?: number;
    concurrency?: number;
    backoffMs?: number;
  };
}

/**
 * Starts the supervisor inside the server. It reads every conversation's feed, checks finished
 * work with a model of another vendor than the runner, keeps the inbox, and tells the human
 * through a notice in the conversation. It holds no orchestrator token.
 */
export async function startInbox(setup: InboxSetup, context: InboxContext): Promise<InboxService> {
  const { parts, conductor } = context;
  const override = setup.override ?? {};
  const host: SupervisorHost = {
    feed: parts.feed,
    publish: (event) => parts.publish(event),
    notifier: conductorNotifier(conductor),
    answers: parts.answers,
    messages: parts.messages,
    onWarning: parts.onWarning,
  };
  const gateway = setup.gateway;
  const models =
    override.models ??
    setup.config.verifierModels.map((entry) =>
      gateway
        ? createGatewayVerifierModel(entry, gateway, override.modelDeps)
        : createVerifierModel(entry, setup.env, override.modelDeps),
    );
  const summary =
    override.summary ??
    (gateway
      ? createGatewaySummaryModel(
          setup.config.summaryModel,
          gateway,
          dailyLimit(SUMMARY_DAILY_CAP_USD),
          override.modelDeps,
        )
      : createSummaryModel(
          setup.config.summaryModel,
          setup.env,
          setup.anthropicBaseUrl,
          override.modelDeps,
        ));
  const supervisor = await Supervisor.start({
    dbPath: setup.dbPath,
    host,
    summary,
    settings: { verifierDailyCapUsd: setup.config.dailyCapUsd },
    ...(override.now === undefined ? {} : { now: override.now }),
    ...(override.tickMs === undefined ? {} : { tickMs: override.tickMs }),
    verification: {
      evidence: artifactEvidence(parts),
      fetcher: override.fetcher ?? createSourceFetcher(),
      budget: conductorBudget(conductor, parts.onWarning),
      models,
      ...(override.concurrency === undefined ? {} : { concurrency: override.concurrency }),
      ...(override.backoffMs === undefined ? {} : { backoffMs: override.backoffMs }),
    },
  });
  return inboxService(supervisor);
}
