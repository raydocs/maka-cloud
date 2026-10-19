import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@maka/core/events';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { buildProviderOptions, getAIModel } from '@maka/runtime/model-factory';
import {
  type BackendFactoryContext,
  BackendRegistry,
  SessionManager,
} from '@maka/runtime/session-manager';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { createSessionStore } from '@maka/storage/session-store';
import {
  CONNECTION_SLUG,
  conductorConnection,
  connectionIdOf,
  MODEL_ID,
  type ModelAccess,
  type ModelCharge,
  providerStateIdentity,
} from './config.js';
import type { ConductorState, SessionKind } from './state.js';

export interface MakaHostOptions {
  /** Maka's storage root (sessions, run ledger, runtime events). */
  root: string;
  access: ModelAccess;
  state: ConductorState;
  /** The tools a session of this kind sees. Must return the same definitions every time. */
  toolsFor(kind: SessionKind): MakaTool[];
  /** Every physical model call, as soon as it completes: the conductor meters spend from it. */
  onModelCall(makaSessionId: string, attempt: ModelCallAttempt): void;
  /**
   * Called before every HTTP request to the model provider, retries included.
   * Throwing refuses the request: nothing is sent and nothing is charged.
   */
  beforeModelRequest(makaSessionId: string): void;
  /** Where the session's requests are charged when `access.gateway` is set. */
  chargeFor(makaSessionId: string): ModelCharge;
  now?: () => number;
}

/**
 * Maka in this process: a SessionManager over Maka's SQLite stores whose
 * AiSdkBackend gets only what keeps Claude history append-only (T3 findings):
 *
 * - every session has an `llmConnectionId`, and the backend is a prepared
 *   factory reporting a stable `providerStateIdentity` (path 6);
 * - the system prompt is the session's stored prompt, with no request-only
 *   contexts (path 2);
 * - no context budget policy, compaction checkpoints, projection transitions,
 *   summarizer or tool-result archive, so nothing rewrites earlier turns and
 *   no redacted_thinking is dropped by a checkpoint (paths 3, 4, 5).
 */
export class MakaHost {
  private readonly manager: SessionManager;
  private readonly runStore: ReturnType<typeof createSqliteAgentRunStore>;
  private readonly connection;
  private readonly identity: `sha256:${string}`;
  private readonly now: () => number;
  private readonly gatewayClients = new Map<string, { fetch: typeof fetch; close(): void }>();

  constructor(private readonly options: MakaHostOptions) {
    this.now = options.now ?? Date.now;
    this.connection = conductorConnection(options.access);
    this.identity = providerStateIdentity(options.access);
    this.runStore = createSqliteAgentRunStore(options.root);
    const backends = new BackendRegistry();
    backends.register('ai-sdk', {
      prepare: async () => ({
        providerStateIdentity: this.identity,
        build: (ctx: BackendFactoryContext) => this.buildBackend(ctx),
      }),
    });
    this.manager = new SessionManager({
      store: createSessionStore(options.root),
      runStore: this.runStore,
      runtimeEventStore: createWorkspaceRuntimeStore(options.root),
      backends,
      newId: () => randomUUID(),
      now: this.now,
    });
  }

  /** Creates a Maka session and stores its system prompt before its first turn. */
  async createSession(input: {
    kind: SessionKind;
    systemPrompt: string;
    thinkingLevel: ThinkingLevel;
    runId: string | null;
  }): Promise<string> {
    const session = await this.manager.createSession({
      cwd: this.options.root,
      llmConnectionId: connectionIdOf(this.options.access),
      llmConnectionSlug: CONNECTION_SLUG,
      model: MODEL_ID,
      thinkingLevel: input.thinkingLevel,
      permissionMode: 'bypass',
    });
    this.options.state.registerSession({
      makaSessionId: session.id,
      kind: input.kind,
      systemPrompt: input.systemPrompt,
      runId: input.runId,
    });
    return session.id;
  }

  send(makaSessionId: string, text: string, maxSteps: number): AsyncIterable<SessionEvent> {
    return this.manager.sendMessage(makaSessionId, { turnId: randomUUID(), text, maxSteps });
  }

  async stop(makaSessionId: string): Promise<void> {
    await this.manager.stopSession(makaSessionId);
  }

  /** Settles turns a previous process left running, so their sessions take new turns. */
  async recoverInterrupted(): Promise<string[]> {
    return this.manager.recoverInterruptedSessions();
  }

  /** Whether model requests are charged by the gateway when they settle. */
  get gatewayCharged(): boolean {
    return this.options.access.gateway !== undefined;
  }

  /** Ends the session's gateway access, cutting its requests in flight. The next request opens it again. */
  releaseModelAccess(makaSessionId: string): void {
    const client = this.gatewayClients.get(makaSessionId);
    if (!client) return;
    this.gatewayClients.delete(makaSessionId);
    client.close();
  }

  async close(): Promise<void> {
    for (const makaSessionId of [...this.gatewayClients.keys()]) {
      this.releaseModelAccess(makaSessionId);
    }
    await this.runStore.close?.();
  }

  private gatewayFetch(makaSessionId: string): typeof fetch {
    const gateway = this.options.access.gateway as NonNullable<ModelAccess['gateway']>;
    let client = this.gatewayClients.get(makaSessionId);
    if (!client) {
      client = gateway.open(this.options.chargeFor(makaSessionId), makaSessionId);
      this.gatewayClients.set(makaSessionId, client);
    }
    return client.fetch;
  }

  private buildBackend(ctx: BackendFactoryContext): AiSdkBackend {
    const session = this.options.state.session(ctx.sessionId);
    if (!session) throw new Error(`Maka session ${ctx.sessionId} is not a conductor session`);
    const { access } = this.options;
    const providerOptions = buildProviderOptions(
      this.connection,
      MODEL_ID,
      ctx.header.thinkingLevel,
    );
    return new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...ctx.header, model: MODEL_ID },
      readExecutionBoundary: () => ctx.store.readExecutionBoundary(ctx.sessionId),
      readPermissionMode: async () => (await ctx.store.readHeader(ctx.sessionId)).permissionMode,
      connection: this.connection,
      providerStateIdentity: this.identity,
      apiKey: access.apiKey,
      modelId: MODEL_ID,
      modelFactory: (modelInput) => {
        const send: typeof fetch = access.gateway
          ? (input, init) => this.gatewayFetch(ctx.sessionId)(input, init)
          : (modelInput.fetch ?? globalThis.fetch);
        return getAIModel({
          ...modelInput,
          fetch: (input, init) => {
            this.options.beforeModelRequest(ctx.sessionId);
            return send(input, init);
          },
        });
      },
      tools: this.options.toolsFor(session.kind),
      providerOptions,
      supportsVision: false,
      ...(ctx.loadTurnRuntimeEvents ? { loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents } : {}),
      recordModelCallAttempt: async (commit) => {
        this.options.onModelCall(ctx.sessionId, commit.attempt);
        await ctx.recordModelCallAttempt?.(commit);
      },
      ...(ctx.recordRunTrace ? { recordRunTrace: ctx.recordRunTrace } : {}),
      systemPrompt: () => ({ text: session.systemPrompt, contexts: [], sourceRevisions: [] }),
      newId: () => randomUUID(),
      now: this.now,
    });
  }
}
