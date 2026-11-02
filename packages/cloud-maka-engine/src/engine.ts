import type { PermissionMode } from '@maka/core/permission';
import type { PreparedBackendFactory } from '@maka/runtime/session-manager';
import type { SessionEvent, ThinkingLevel } from './types.js';

export type MakaEngineKind = 'ts-in-process' | 'rust-host';

/**
 * What cloud packages need from a Maka session host. `TsInProcessEngine`
 * implements this with today's SessionManager; `RustHostEngine` is the
 * rust-preview mapping, types only.
 */
export interface MakaEngine {
  readonly kind: MakaEngineKind;
  openSessionRuntime(options: MakaSessionRuntimeOptions): MakaSessionRuntime;
}

export interface MakaSessionRuntimeOptions {
  /** Maka storage root: sessions, the run ledger, runtime events. */
  root: string;
  /** Prepared `ai-sdk` factory. Same registration path as today's SessionManager. */
  backend: PreparedBackendFactory;
  newId?: () => string;
  now?: () => number;
}

export interface MakaCreateSessionInput {
  cwd: string;
  llmConnectionId?: string;
  llmConnectionSlug: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  permissionMode: PermissionMode;
}

/** Fields the cloud call sites actually pass to `SessionManager.sendMessage`. */
export interface MakaSendInput {
  turnId: string;
  text: string;
  maxSteps?: number;
}

export interface MakaSessionRuntime {
  createSession(input: MakaCreateSessionInput): Promise<{ id: string }>;
  sendMessage(sessionId: string, input: MakaSendInput): AsyncIterable<SessionEvent>;
  stopSession(sessionId: string): Promise<void>;
  recoverInterruptedSessions(): Promise<string[]>;
  compactSession(sessionId: string): AsyncIterable<SessionEvent>;
  /**
   * Drop the in-process manager and rebuild it over the same stores.
   * Used by the history-integrity harness to simulate a server restart.
   * `stopSessionId`, when set, is stopped first (errors ignored), matching
   * that harness.
   */
  restart(stopSessionId?: string): Promise<void>;
  close(): Promise<void>;
}
