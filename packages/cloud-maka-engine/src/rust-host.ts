import type { MakaEngine, MakaSessionRuntime, MakaSessionRuntimeOptions } from './engine.js';

/**
 * How a future `RustHostEngine` would reach the rust-preview Host.
 * Frames are a 4-byte unsigned big-endian length followed by one complete
 * JSON value, on stdio IPC or WebSocket — see
 * https://github.com/apache/maka/blob/rust-preview/platform/transport/README.md
 */
export interface RustHostTransportOptions {
  /**
   * Absolute path to the trusted Maka CLI (IPC startup), or a `ws:` / `wss:`
   * URL. The stub does not open either.
   */
  endpoint: string;
  channel: 'ipc' | 'websocket';
}

export const RUST_HOST_FRAMING = {
  prefix: 'u32-be-length',
  body: 'json',
  channels: ['ipc', 'websocket'],
} as const;

/**
 * `MakaEngine` methods → rust-preview `agent` service methods
 * (`packages/plugin-sdk/src/generated/methods.ts` on rust-preview).
 */
export const RUST_HOST_METHOD_MAPPING = {
  createSession: { service: 'agent', method: 'create', mode: 'mutation' },
  sendMessage: { service: 'agent', method: 'send', mode: 'mutation' },
  stopSession: { service: 'agent', method: 'stop', mode: 'mutation' },
  compactSession: { service: 'agent', method: 'compact', mode: 'mutation' },
  recoverInterruptedSessions: {
    service: 'host',
    method: null,
    note: 'Host-owned restart recovery. Clients reconnect and read history/watch; they do not resend.',
  },
  restart: {
    service: 'host',
    method: null,
    note: 'A new Client session against the same Root. The Host keeps accepted work.',
  },
  watchEvents: { service: 'agent', method: 'watch', mode: 'subscription' },
  history: { service: 'agent', method: 'history', mode: 'query' },
} as const;

/**
 * SessionEvent types the conductor actually switches on → `agent.watch`
 * delivery pages. rust-preview rows are fenced history, not the TS
 * SessionEvent union.
 */
export const RUST_HOST_EVENT_MAPPING = {
  tool_start: 'agent.watch AgentDeliveryPage (tool activity)',
  tool_result: 'agent.watch AgentDeliveryPage (tool result)',
  text_complete: 'agent.watch AgentDeliveryPage (assistant text)',
  error: 'agent.watch / agent.diagnostics',
  complete: 'agent.watch AgentDeliveryPage (execution completed)',
} as const;

/**
 * Session import on rust-preview: the Agent service plus
 * `plugins/agent/session-import` (Claude, Codex, OpenCode → Transcript).
 */
export const RUST_HOST_SESSION_IMPORT_MAPPING = {
  catalog: { service: 'agent', method: 'imports', mode: 'query' },
  directories: { service: 'agent', method: 'importDirectories', mode: 'query' },
  import: { service: 'agent', method: 'import', mode: 'mutation' },
  transcript:
    'plugins/agent/session-import Transcript; the Host publishes the new Session in one transaction',
} as const;

export type RustHostMethodMapping = typeof RUST_HOST_METHOD_MAPPING;
export type RustHostEventMapping = typeof RUST_HOST_EVENT_MAPPING;
export type RustHostSessionImportMapping = typeof RUST_HOST_SESSION_IMPORT_MAPPING;

const STUB_MESSAGE =
  'RustHostEngine is a protocol stub. It documents the rust-preview Host mapping and does not open a transport.';

/**
 * Types-only stand-in for a rust-preview Host client. Every method throws.
 * Wire this up only after the fork tracks rust-preview; see
 * `docs/fork/architecture/maka-engine.md`.
 */
export class RustHostEngine implements MakaEngine {
  readonly kind = 'rust-host' as const;

  constructor(readonly transport: RustHostTransportOptions) {}

  openSessionRuntime(_options: MakaSessionRuntimeOptions): MakaSessionRuntime {
    throw new Error(STUB_MESSAGE);
  }
}
