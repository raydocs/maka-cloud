import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@maka/core/events';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { buildDefaultContextBudgetPolicy } from '@maka/runtime/context-budget-policy';
import { buildLlmHistorySummarizer } from '@maka/runtime/history-compact-summarizer';
import { buildProviderOptions, getAIModel } from '@maka/runtime/model-factory';
import {
  BackendRegistry,
  SessionManager,
  type BackendFactoryContext,
} from '@maka/runtime/session-manager';
import { createToolResultArchiveCapability } from '@maka/runtime/tool-result-archive-capability';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { createSessionStore } from '@maka/storage/session-store';

export const MODEL_ID = 'claude-opus-5-5';
export const CONNECTION_SLUG = 'anthropic-check';
export const CONNECTION_ID = 'connection-anthropic-check';
/** Stands in for the host's per-route identity; stable across restarts, as in production. */
const PROVIDER_STATE_IDENTITY = `sha256:${'5'.repeat(64)}` as const;

export interface HarnessSettings {
  /**
   * `default` passes `buildDefaultContextBudgetPolicy()` exactly as
   * `runtime-host` does (`execution-model-composition.ts:407`); `off` omits
   * the policy, which turns tool-result pruning and history compaction off.
   */
  readonly contextBudget: 'default' | 'off';
  /** The user's proactive compaction target; undefined leaves proactive compaction inert. */
  readonly compactionThreshold?: number;
  /** How many tool-result archive writes fail before writes start succeeding. */
  readonly archiveWriteFailures?: number;
  readonly thinkingLevel?: ThinkingLevel;
  /**
   * Create the session without an `llmConnectionId`. Hosts always set one;
   * without it the invocation route has unknown provenance
   * (`runtime-invocation-route.ts`), which decides prior-turn thinking replay.
   */
  readonly omitConnectionId?: boolean;
}

export interface HarnessInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly tools: readonly MakaTool[];
  readonly settings: HarnessSettings;
  /** Defaults to a fresh temp directory, removed on close. */
  readonly root?: string;
}

export interface TurnOutcome {
  readonly events: SessionEvent[];
  readonly errors: string[];
  readonly stopReason?: string;
}

export interface Harness {
  readonly root: string;
  readonly sessionId: string;
  readonly archiveWrites: { attempted: number; failed: number };
  send(turnId: string, text: string): Promise<TurnOutcome>;
  compact(): Promise<TurnOutcome>;
  /** Drop the manager and backend and rebuild both over the same stores, like a server restart. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export function checkConnection(baseUrl: string, settings: HarnessSettings): LlmConnection {
  return {
    slug: CONNECTION_SLUG,
    name: 'Anthropic (history check)',
    providerType: 'anthropic',
    baseUrl,
    defaultModel: MODEL_ID,
    models: [{ id: MODEL_ID, contextWindow: 1_000_000 }],
    // Maka's model metadata stops at claude-opus-5 (packages/core/src/model-metadata.ts),
    // so the connection declares the thinking levels itself, as a user would.
    modelOverrides: {
      [MODEL_ID]: {
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        ...(settings.compactionThreshold !== undefined
          ? { compactionThreshold: settings.compactionThreshold }
          : {}),
      },
    },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * A SessionManager over real SQLite stores whose AiSdkBackend is wired with
 * the same seams `runtime-host` gives it (`execution-model-composition.ts`),
 * pointed at a local Anthropic endpoint.
 */
export async function startHarness(input: HarnessInput): Promise<Harness> {
  const ownsRoot = input.root === undefined;
  const root = input.root ?? (await mkdtemp(join(tmpdir(), 'maka-cloud-history-check-')));
  const connection = checkConnection(input.baseUrl, input.settings);
  const archiveWrites = { attempted: 0, failed: 0 };
  let ids = 0;
  const newId = () => `hc-${++ids}`;
  let clock = Date.UTC(2026, 9, 18);
  const now = () => (clock += 1);

  const sessionStore = createSessionStore(root);
  const runStore = createSqliteAgentRunStore(root);
  const runtimeEventStore = createWorkspaceRuntimeStore(root);

  const buildBackend = (ctx: BackendFactoryContext): AiSdkBackend => {
    const providerOptions = buildProviderOptions(connection, MODEL_ID, ctx.header.thinkingLevel);
    const resolveModel = () =>
      getAIModel({ sessionId: ctx.sessionId, connection, apiKey: input.apiKey, modelId: MODEL_ID });
    const archived = new Map<string, string>();
    const toolResultArchive = createToolResultArchiveCapability({
      archiveToolResult: (event) => {
        archiveWrites.attempted += 1;
        if (archiveWrites.failed < (input.settings.archiveWriteFailures ?? 0)) {
          archiveWrites.failed += 1;
          throw new Error('injected archive write failure');
        }
        const artifactId = `archive-${archived.size + 1}`;
        archived.set(artifactId, event.serializedResult);
        return { artifactId };
      },
      readArchivedToolResultResource: () => ({ ok: false, reason: 'read_failed' }),
    });
    return new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...ctx.header, model: MODEL_ID },
      readExecutionBoundary: () => ctx.store.readExecutionBoundary(ctx.sessionId),
      readPermissionMode: async () => (await ctx.store.readHeader(ctx.sessionId)).permissionMode,
      connection,
      providerStateIdentity: PROVIDER_STATE_IDENTITY,
      apiKey: input.apiKey,
      modelId: MODEL_ID,
      modelFactory: (modelInput) => getAIModel(modelInput),
      tools: [...input.tools],
      providerOptions,
      ...(input.settings.contextBudget === 'default'
        ? {
            contextBudget: buildDefaultContextBudgetPolicy({
              name: 'runtime-host-default-history-budget',
              modelId: MODEL_ID,
            }),
          }
        : {}),
      supportsVision: true,
      toolResultArchive,
      summarizeHistoryCompact: buildLlmHistorySummarizer({ resolveModel, providerOptions }),
      historyCompactRoute: 'text_summary',
      ...(ctx.loadHistoryCompactCheckpoint
        ? { loadHistoryCompactCheckpoint: ctx.loadHistoryCompactCheckpoint }
        : {}),
      ...(ctx.recordHistoryCompactCheckpoint
        ? { recordHistoryCompactCheckpoint: ctx.recordHistoryCompactCheckpoint }
        : {}),
      ...(ctx.loadModelProjectionTransitions
        ? { loadModelProjectionTransitions: ctx.loadModelProjectionTransitions }
        : {}),
      ...(ctx.recordModelProjectionTransition
        ? { recordModelProjectionTransition: ctx.recordModelProjectionTransition }
        : {}),
      ...(ctx.loadTurnRuntimeEvents ? { loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents } : {}),
      ...(ctx.allowMidTurnHistoryCompaction !== undefined
        ? { allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction }
        : {}),
      ...(ctx.recordModelCallAttempt ? { recordModelCallAttempt: ctx.recordModelCallAttempt } : {}),
      ...(ctx.recordRunTrace ? { recordRunTrace: ctx.recordRunTrace } : {}),
      // runtime-host's prompt: an "Active model" line, then a per-turn
      // `runtime.environment` context sent after the history and not persisted.
      systemPrompt: (context) => ({
        text: `Active model: ${MODEL_ID}\n\nYou are a research assistant. Use the tools when asked.`,
        contexts: [
          {
            name: 'runtime.environment',
            text: [
              'Runtime Host environment for this turn:',
              JSON.stringify({
                cwd: context.cwd,
                platform: 'linux',
                sampledAt: new Date(context.turnStartedAt ?? 0).toISOString(),
                timeZone: 'UTC',
              }),
            ].join('\n'),
          },
        ],
        sourceRevisions: [],
      }),
      newId,
      now,
    });
  };

  const createManager = () => {
    const backends = new BackendRegistry();
    // Registered as a prepared factory so every invocation carries the route
    // identity, which prior-turn thinking replay is admitted against.
    backends.register('ai-sdk', {
      prepare: async () => ({
        providerStateIdentity: PROVIDER_STATE_IDENTITY,
        build: buildBackend,
      }),
    });
    return new SessionManager({
      store: sessionStore,
      runStore,
      runtimeEventStore,
      backends,
      newId,
      now,
    });
  };

  let manager = createManager();
  const session = await manager.createSession({
    cwd: root,
    ...(input.settings.omitConnectionId ? {} : { llmConnectionId: CONNECTION_ID }),
    llmConnectionSlug: CONNECTION_SLUG,
    model: MODEL_ID,
    thinkingLevel: input.settings.thinkingLevel ?? 'high',
    permissionMode: 'bypass',
  });

  const drain = async (stream: AsyncIterable<SessionEvent>): Promise<TurnOutcome> => {
    const events: SessionEvent[] = [];
    const errors: string[] = [];
    let stopReason: string | undefined;
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'error') errors.push(event.message);
      if (event.type === 'complete') stopReason = event.stopReason;
    }
    return { events, errors, ...(stopReason ? { stopReason } : {}) };
  };

  const stopManager = async () => {
    await manager.stopSession(session.id).catch(() => undefined);
  };

  return {
    root,
    sessionId: session.id,
    archiveWrites,
    send: (turnId, text) => drain(manager.sendMessage(session.id, { turnId, text })),
    compact: () => drain(manager.compactSession(session.id)),
    restart: async () => {
      await stopManager();
      manager = createManager();
    },
    close: async () => {
      await stopManager();
      await runStore.close?.();
      if (ownsRoot) await rm(root, { recursive: true, force: true });
    },
  };
}
