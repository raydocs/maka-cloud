import type { Conductor } from '@maka-cloud/conductor';
import type { BudgetPort, Gateway } from '@maka-cloud/gateway';
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
  type AccountOf,
  createGatewaySummaryModel,
  createGatewayVerifierModel,
  type ModelDeps,
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
  /**
   * The model gateway. The checks and the digest summary reach the vendors only through it, each
   * request reserved at its worst case first. Without it the inbox does not start, unless a test
   * injects every model it would build.
   */
  gateway?: Gateway;
  /**
   * The digest summary's limit of `SUMMARY_DAILY_CAP_USD` per day, kept where a restart reads it
   * back. Without it the inbox does not build the summary model.
   */
  summaryBudget?: BudgetPort;
  /**
   * Whose caps a check's spend counts against: the invite that owns the checked task's
   * conversation. Without it the inbox builds no check model.
   */
  accountOf?: AccountOf;
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
  // Never a vendor key as a fallback: a model the inbox builds goes through the gateway.
  if (
    gateway === undefined &&
    (override.summary === undefined ||
      (override.models === undefined && setup.config.verifierModels.length > 0))
  ) {
    throw new Error('The inbox needs the model gateway to call a model.');
  }
  if (override.summary === undefined && setup.summaryBudget === undefined) {
    throw new Error('The digest summary needs a daily limit that survives a restart.');
  }
  if (
    override.models === undefined &&
    setup.config.verifierModels.length > 0 &&
    setup.accountOf === undefined
  ) {
    throw new Error('The checks need to know whose spend they are.');
  }
  const accountOf = setup.accountOf ?? (() => undefined);
  const models =
    override.models ??
    setup.config.verifierModels.map((entry) =>
      createGatewayVerifierModel(entry, gateway as Gateway, accountOf, override.modelDeps),
    );
  const summary =
    override.summary ??
    createGatewaySummaryModel(
      setup.config.summaryModel,
      gateway as Gateway,
      setup.summaryBudget as BudgetPort,
      override.modelDeps,
    );
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
