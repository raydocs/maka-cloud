import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { FakeRunner, type FakeRunnerOptions, RunnerRegistry } from '@maka-cloud/orchestrator';
import { type CloudServer, type CloudServerOptions, startCloudServer } from '../cloud-server.js';

export interface Harness {
  dir: string;
  options: CloudServerOptions;
  fake: FakeRunner;
  server: CloudServer;
  token: string;
  warnings: Array<{ message: string; detail?: unknown }>;
  /** Calls the public API with the harness invite unless `token` says otherwise. */
  api(path: string, init?: RequestInit & { token?: string | null }): Promise<Response>;
  /** Stops the server and starts a new one over the same files. */
  restart(overrides?: Partial<CloudServerOptions>): Promise<void>;
}

export async function startHarness(
  t: TestContext,
  overrides: Partial<CloudServerOptions> & { fake?: FakeRunnerOptions; dir?: string } = {},
): Promise<Harness> {
  const ownsDir = overrides.dir === undefined;
  const dir = overrides.dir ?? (await mkdtemp(join(tmpdir(), 'cloud-server-test-')));
  const fake = new FakeRunner(overrides.fake);
  const warnings: Harness['warnings'] = [];
  const { fake: _fake, dir: _dir, ...rest } = overrides;
  const options: CloudServerOptions = {
    dbPath: join(dir, 'server.sqlite'),
    invitesPath: join(dir, 'invites.sqlite'),
    handoffRoot: join(dir, 'handoff'),
    runners: new RunnerRegistry([fake]),
    onWarning: (message, detail) => warnings.push({ message, detail }),
    ...rest,
    // Tests post many messages; the rate limit has its own test.
    http: { messagesPerMinute: 1_000_000, ...rest.http },
  };
  const harness = { dir, options, fake, warnings } as Harness;
  harness.server = await startCloudServer(options);
  harness.token = harness.server.invites.create('test').token;
  t.after(async () => {
    await harness.server.close();
    if (ownsDir) await rm(dir, { recursive: true, force: true });
  });
  harness.api = (path, init = {}) => {
    const { token = harness.token, ...request } = init;
    return fetch(`${harness.server.url}${path}`, {
      ...request,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(request.headers as Record<string, string> | undefined),
      },
    });
  };
  harness.restart = async (next = {}) => {
    await harness.server.close();
    harness.options = { ...options, ...next };
    harness.server = await startCloudServer(harness.options);
  };
  return harness;
}

export async function postJson(h: Harness, path: string, body: unknown, token?: string | null) {
  return h.api(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(token === undefined ? {} : { token }),
  });
}

export async function newConversation(h: Harness, title?: string): Promise<string> {
  const res = await postJson(h, '/v1/conversations', title === undefined ? {} : { title });
  const body = (await res.json()) as { conversationId: string };
  return body.conversationId;
}

export interface SseEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

export interface Stream {
  events: SseEvent[];
  status: number;
  /** Resolves once `count` events arrived. */
  until(count: number, what?: string): Promise<SseEvent[]>;
  closed: Promise<void>;
  close(): void;
}

/** Opens the event stream and collects what arrives. */
export async function openStream(
  t: TestContext,
  h: Harness,
  query = '',
  headers: Record<string, string> = {},
  token: string | null = h.token,
): Promise<Stream> {
  const abort = new AbortController();
  const response = await fetch(`${h.server.url}/v1/events${query}`, {
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    signal: abort.signal,
  });
  const events: SseEvent[] = [];
  const waiters: Array<() => void> = [];
  const reading = (async () => {
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const fields = Object.fromEntries(
            frame
              .split('\n')
              .filter((line) => !line.startsWith(':') && line.includes(': '))
              .map((line) => [
                line.slice(0, line.indexOf(': ')),
                line.slice(line.indexOf(': ') + 2),
              ]),
          );
          if (fields.id === undefined) continue;
          events.push({
            id: Number(fields.id),
            event: fields.event ?? '',
            data: JSON.parse(fields.data ?? 'null') as Record<string, unknown>,
          });
          for (const wake of waiters.splice(0)) wake();
        }
      }
    } catch {
      // Aborted or closed by the server.
    }
  })();
  t.after(() => abort.abort());
  return {
    events,
    status: response.status,
    closed: reading,
    close: () => abort.abort(),
    until: async (count, what = 'events') => {
      const deadline = Date.now() + 3000;
      while (events.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${count} ${what}; got ${events.length}`);
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 20);
        });
      }
      return events.slice(0, count);
    },
  };
}

export async function eventually(
  check: () => boolean,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
