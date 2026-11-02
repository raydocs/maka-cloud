import {
  autonomyOf,
  markApplied,
  observeStreamSilence,
  observeTimeLimit,
  observeToolCall,
  observeTurn,
} from './autonomy.js';
import {
  appendMessage,
  buildRequest,
  recordCacheBreak,
  recordCacheUsage,
  type CacheUsage,
  type WorkerRequest,
} from './prompt-cache.js';
import type { AutonomyIncident, AutonomySettings, AutonomyState, WorkerRecord } from './types.js';
import { DEFAULT_AUTONOMY } from './types.js';

export type ProviderEvent =
  | { kind: 'ok'; text: string; usage?: CacheUsage }
  | { kind: 'time_limit'; text?: string; usage?: CacheUsage }
  | { kind: 'broken'; text: string; usage?: CacheUsage }
  | { kind: 'error'; message: string }
  | { kind: 'tool'; name: string; args: unknown; result: string; usage?: CacheUsage };

export interface SessionProvider {
  readonly endpoint: string;
  complete(
    request: WorkerRequest,
    options: { signal: AbortSignal; onEvent: () => void },
  ): Promise<ProviderEvent>;
}

export interface TurnResult {
  action: 'continue' | 'retry' | 'nudge' | 'stop';
  text: string;
  discarded: string[];
  incidents: AutonomyIncident[];
  state: AutonomyState;
  request: WorkerRequest;
  attempts: number;
  endpoint: string;
}

export interface FakeScript {
  event: ProviderEvent;
  hang?: boolean;
}

/**
 * Fake provider for tests. Completes on the same endpoint every attempt.
 * `hang: true` never resolves so the silence timer wins.
 */
export class FakeProvider implements SessionProvider {
  readonly calls: WorkerRequest[] = [];
  readonly endpoints: string[] = [];
  scripts: FakeScript[] = [];
  constructor(readonly endpoint = 'https://api.anthropic.com/v1/messages') {}

  script(...events: Array<ProviderEvent | FakeScript>): this {
    this.scripts.push(...events.map((row) => (isFakeScript(row) ? row : { event: row })));
    return this;
  }

  async complete(
    request: WorkerRequest,
    options: { signal: AbortSignal; onEvent: () => void },
  ): Promise<ProviderEvent> {
    this.calls.push(request);
    this.endpoints.push(this.endpoint);
    const script = this.scripts[this.calls.length - 1] ?? { event: { kind: 'ok', text: '' } };
    if (script.hang) {
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    options.onEvent();
    return script.event;
  }
}

export async function runWorkerTurn(input: {
  worker: Pick<WorkerRecord, 'autonomy'>;
  request: WorkerRequest;
  provider: SessionProvider;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  settings?: AutonomySettings;
  visible?: (text: string) => boolean;
}): Promise<TurnResult> {
  const settings = input.settings ?? DEFAULT_AUTONOMY;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let state = autonomyOf(input.worker);
  let request = input.request;
  const incidents: AutonomyIncident[] = [];
  const discarded: string[] = [];
  let text = '';
  let attempts = 0;
  let lastRequest = request;

  const finish = (action: TurnResult['action'], extra?: AutonomyIncident): TurnResult => {
    if (extra) incidents.push(extra);
    return {
      action,
      text,
      discarded,
      incidents,
      state,
      request: lastRequest,
      attempts,
      endpoint: input.provider.endpoint,
    };
  };

  for (;;) {
    attempts += 1;
    const cache = recordCacheBreak(state, attempts === 1 ? undefined : lastRequest, request);
    state = cache.state;
    lastRequest = request;
    const started = input.now();
    const result = await completeOrSilence(input.provider, request, settings, input.now, sleep);
    if (result.kind === 'silence') {
      discarded.push(result.partial);
      const observed = observeStreamSilence(state, input.now(), settings);
      state = observed.state;
      incidents.push(observed.incident);
      request = stripPartial(request, result.partial);
      if (state.streamRetries >= settings.timeLimitAttempts) return finish('retry');
      continue;
    }
    if (result.kind === 'time_limit') {
      if (result.text) discarded.push(result.text);
      if (result.usage) state = recordCacheUsage(state, result.usage);
      const observed = observeTimeLimit(state, input.now(), settings);
      state = observed.state;
      incidents.push(observed.incident);
      request = stripPartial(request, result.text ?? '');
      if (observed.incident.action === 'stop') return finish('stop');
      continue;
    }
    if (result.kind === 'broken') {
      discarded.push(result.text);
      if (result.usage) state = recordCacheUsage(state, result.usage);
      request = stripPartial(request, result.text);
      const incident: AutonomyIncident = {
        action: 'retry',
        rule: 'stream_silence',
        detail: 'Partial response discarded before retry.',
        at: input.now(),
      };
      state = {
        ...state,
        lastIncident: incident,
        pending: incident,
        streamRetries: state.streamRetries + 1,
      };
      incidents.push(incident);
      continue;
    }
    if (result.kind === 'error') {
      const incident: AutonomyIncident = {
        action: 'retry',
        rule: 'stream_silence',
        detail: `Provider error on ${input.provider.endpoint}; retrying the same endpoint.`,
        at: input.now(),
      };
      state = {
        ...state,
        lastIncident: incident,
        pending: incident,
        streamRetries: state.streamRetries + 1,
      };
      incidents.push(incident);
      if (attempts >= 3)
        return finish('stop', {
          ...incident,
          action: 'stop',
          detail: result.message,
          at: input.now(),
        });
      continue;
    }
    if (result.kind === 'tool') {
      if (result.usage) state = recordCacheUsage(state, result.usage);
      const observed = observeToolCall(
        state,
        { name: result.name, args: result.args, result: result.result },
        input.now(),
        settings,
      );
      state = observed.state;
      text = result.result;
      request = appendMessage(request, {
        role: 'assistant',
        content: `${result.name}(${JSON.stringify(result.args)})`,
      });
      lastRequest = request;
      if (observed.incident) {
        incidents.push(observed.incident);
        if (observed.incident.action === 'stop') return finish('stop');
        if (observed.incident.action === 'nudge') return finish('nudge');
      }
      const turn = observeTurn(state, { visible: Boolean(result.result) }, input.now(), settings);
      state = turn.state;
      if (turn.incident) {
        incidents.push(turn.incident);
        return finish(turn.incident.action);
      }
      return finish('continue');
    }
    if (result.usage) state = recordCacheUsage(state, result.usage);
    text = result.text;
    const visible = (input.visible ?? ((value: string) => value.trim().length > 0))(text);
    const turn = observeTurn(state, { visible }, input.now(), settings);
    state = turn.state;
    if (turn.incident) {
      incidents.push(turn.incident);
      return finish(turn.incident.action);
    }
    void started;
    return finish('continue');
  }
}

export function applyTurnToWorker(worker: WorkerRecord, turn: TurnResult): WorkerRecord {
  const pending = turn.incidents.at(-1);
  return {
    ...worker,
    autonomy: pending ? { ...turn.state, pending } : markApplied(turn.state),
  };
}

async function completeOrSilence(
  provider: SessionProvider,
  request: WorkerRequest,
  settings: AutonomySettings,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<ProviderEvent | { kind: 'silence'; partial: string }> {
  const ac = new AbortController();
  let lastEventAt = now();
  let partial = '';
  const work = provider
    .complete(request, {
      signal: ac.signal,
      onEvent: () => {
        lastEventAt = now();
      },
    })
    .then((event) => {
      if (event.kind === 'ok' || event.kind === 'broken' || event.kind === 'time_limit') {
        partial = event.text ?? partial;
      }
      return event;
    });
  const watch = (async () => {
    while (!ac.signal.aborted) {
      const left = settings.streamSilenceMs - (now() - lastEventAt);
      if (left <= 0) {
        ac.abort();
        return { kind: 'silence' as const, partial };
      }
      await sleep(Math.min(left, settings.streamSilenceMs));
    }
    return { kind: 'silence' as const, partial };
  })();
  try {
    const winner = await Promise.race([work, watch]);
    if (winner.kind !== 'silence') ac.abort();
    return winner;
  } catch (error) {
    if (ac.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return { kind: 'silence', partial };
    }
    throw error;
  }
}

function isFakeScript(row: ProviderEvent | FakeScript): row is FakeScript {
  return 'event' in row && 'kind' in (row as FakeScript).event;
}

function stripPartial(request: WorkerRequest, partial: string): WorkerRequest {
  if (!partial) return request;
  const last = request.messages[request.messages.length - 1];
  if (last?.role === 'assistant' && last.content === partial) {
    return { ...request, messages: request.messages.slice(0, -1) };
  }
  return request;
}

export { buildRequest };
