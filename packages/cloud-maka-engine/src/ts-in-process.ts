import { randomUUID } from 'node:crypto';
import { BackendRegistry, SessionManager } from '@maka/runtime/session-manager';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { createSessionStore } from '@maka/storage/session-store';
import type {
  MakaCreateSessionInput,
  MakaEngine,
  MakaSendInput,
  MakaSessionRuntime,
  MakaSessionRuntimeOptions,
} from './engine.js';
import type { SessionEvent } from './types.js';

/**
 * Today's Maka: SessionManager over SQLite stores in this process.
 * Construction matches maka-host.ts and the conductor-checks harness
 * before they routed through this package. No behavior change.
 */
export class TsInProcessEngine implements MakaEngine {
  readonly kind = 'ts-in-process' as const;

  openSessionRuntime(options: MakaSessionRuntimeOptions): MakaSessionRuntime {
    return new TsInProcessSessionRuntime(options);
  }
}

class TsInProcessSessionRuntime implements MakaSessionRuntime {
  private readonly sessionStore: ReturnType<typeof createSessionStore>;
  private readonly runStore: ReturnType<typeof createSqliteAgentRunStore>;
  private readonly runtimeEventStore: ReturnType<typeof createWorkspaceRuntimeStore>;
  private readonly newId: () => string;
  private readonly now: () => number;
  private manager: SessionManager;

  constructor(private readonly options: MakaSessionRuntimeOptions) {
    this.newId = options.newId ?? (() => randomUUID());
    this.now = options.now ?? Date.now;
    this.sessionStore = createSessionStore(options.root);
    this.runStore = createSqliteAgentRunStore(options.root);
    this.runtimeEventStore = createWorkspaceRuntimeStore(options.root);
    this.manager = this.createManager();
  }

  async createSession(input: MakaCreateSessionInput): Promise<{ id: string }> {
    const session = await this.manager.createSession(input);
    return { id: session.id };
  }

  sendMessage(sessionId: string, input: MakaSendInput): AsyncIterable<SessionEvent> {
    return this.manager.sendMessage(sessionId, input);
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.manager.stopSession(sessionId);
  }

  async recoverInterruptedSessions(): Promise<string[]> {
    return this.manager.recoverInterruptedSessions();
  }

  compactSession(sessionId: string): AsyncIterable<SessionEvent> {
    return this.manager.compactSession(sessionId);
  }

  async restart(stopSessionId?: string): Promise<void> {
    if (stopSessionId !== undefined) {
      await this.manager.stopSession(stopSessionId).catch(() => undefined);
    }
    this.manager = this.createManager();
  }

  async close(): Promise<void> {
    await this.runStore.close?.();
  }

  private createManager(): SessionManager {
    const backends = new BackendRegistry();
    backends.register('ai-sdk', this.options.backend);
    return new SessionManager({
      store: this.sessionStore,
      runStore: this.runStore,
      runtimeEventStore: this.runtimeEventStore,
      backends,
      newId: this.newId,
      now: this.now,
    });
  }
}
