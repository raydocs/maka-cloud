import { createHash, randomBytes } from 'node:crypto';
import {
  type BoundLimits,
  type Bounded,
  boundAnthropic,
  boundOpenAI,
  countBody,
  countedInputTokens,
  DEFAULT_BOUND_LIMITS,
} from './bound.js';
import { Allowance, type BudgetPort, LimitPort, type ReserveResult } from './budget.js';
import { cutEvent, plainRefusal, type Refusal, refusalResponse } from './errors.js';
import { costUsd, type ModelPrice, modelTable, type Vendor, worstCaseUsd } from './pricing.js';
import {
  DEFAULT_SEARCH_CALL_USD,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_BODY_BYTES,
  parseSearchRequest,
  type SearchOutcome,
  type SearchProvider,
} from './search.js';
import { UsageTracker } from './usage.js';

export type Route = 'messages' | 'count' | 'responses';

export interface GatewayLimits extends BoundLimits {
  /** Largest request body accepted. */
  maxBodyBytes: number;
  /** Requests one grant may have in flight. */
  maxInflightPerGrant: number;
  /** Tree pools kept while none of their grants is open; the oldest idle ones go first. */
  maxIdlePools: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  ...DEFAULT_BOUND_LIMITS,
  maxBodyBytes: 32 * 1024 * 1024,
  maxInflightPerGrant: 8,
  maxIdlePools: 10_000,
};

export interface Upstream {
  apiKey: string;
  /** Default: the vendor's API (`https://api.anthropic.com`, `https://api.openai.com/v1`). */
  baseUrl?: string;
}

export interface GatewayOptions {
  /** The vendor keys. Only the gateway holds them. */
  upstreams: Partial<Record<Vendor, Upstream>>;
  /** Replaces and extends the built-in price table, by model id. */
  models?: readonly ModelPrice[];
  limits?: Partial<GatewayLimits>;
  /** For the requests to the vendors. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Web search for grants of either vendor. Unset: `search` refuses. */
  search?: SearchOptions;
  /** A problem worth knowing. Never carries a body, a header value, a token or a key. */
  onWarning?: (message: string, detail?: Record<string, string | number>) => void;
}

export interface SearchOptions {
  provider: SearchProvider;
  /** What one call is reserved at, and settled at when the provider bills it. */
  callUsd?: number;
  /** A call still running after this is cut (and charged, since it may have been billed). */
  timeoutMs?: number;
}

export interface IssueInput {
  vendor: Vendor;
  /** Who the grant is for (a task id or a run id), for warnings. Not a secret. */
  subject: string;
  /** `revokeForTask(taskId)` revokes it. */
  taskId?: string;
  /**
   * What the grant's requests are charged to: a port over an existing ledger, or a dollar limit
   * in memory. With `poolId`, every grant of that pool also shares the pool's limit (set by the
   * first grant of the pool), so grants issued side by side cannot together exceed it.
   */
  budget: BudgetPort | { limitUsd: number; poolId?: string };
}

export interface SpendState {
  /** Dollars settled through this grant. */
  spentUsd: number;
  /** A request was refused because the budget could not cover it. */
  exhausted: boolean;
}

export interface GrantHandle {
  /** What the caller sends as its API key. */
  readonly token: string;
  /**
   * Ends the grant: new requests are refused and requests in flight are cut. Resolves once every
   * request of the grant has settled, so `spend()` after it is final. Idempotent.
   */
  revoke(): Promise<void>;
  spend(): SpendState;
  /** Called after each settled request and on a refusal for budget. Returns the unsubscribe. */
  onSpend(listener: (state: SpendState) => void): () => void;
}

export interface InProcessClient {
  /** A `fetch` for a vendor SDK's `fetch` option: its requests go through the gateway. */
  fetch: typeof fetch;
  /** As `GrantHandle.revoke`: resolves once every request of the grant has settled. */
  revoke(): Promise<void>;
  spend(): SpendState;
}

const DEFAULT_BASE: Record<Vendor, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

const TOKEN_PREFIX = 'mkg_';

/** Errors of a request that never reached the vendor, so nothing was billed. */
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const PASSED_HEADERS = ['content-type', 'request-id', 'x-request-id', 'retry-after'];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}

interface Pool {
  allowance: Allowance;
  open: number;
}

interface Flight {
  controller: AbortController;
  /** Why the gateway cut the request, when it did. */
  cut?: string;
}

class Grant {
  readonly id = randomBytes(6).toString('hex');
  revoked = false;
  spentUsd = 0;
  exhausted = false;
  readonly flights = new Set<Flight>();
  readonly listeners = new Set<(state: SpendState) => void>();
  onRevoke: (() => void) | undefined;
  /** Called once no request is in flight. */
  private idle: Array<() => void> = [];

  constructor(
    readonly vendor: Vendor,
    readonly subject: string,
    readonly taskId: string | undefined,
    readonly port: BudgetPort,
  ) {}

  state(): SpendState {
    return { spentUsd: roundUsd(this.spentUsd), exhausted: this.exhausted };
  }

  notify(): void {
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A listener that throws must not break a request.
      }
    }
  }

  /** A request left the grant; it settled first, whatever it was charged. */
  land(flight: Flight): void {
    this.flights.delete(flight);
    if (this.flights.size > 0) return;
    const idle = this.idle;
    this.idle = [];
    for (const resolve of idle) resolve();
  }

  /** Resolves once no request of the grant is in flight. */
  drained(): Promise<void> {
    if (this.flights.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  revoke(): Promise<void> {
    if (!this.revoked) {
      this.revoked = true;
      for (const flight of this.flights) {
        flight.cut ??= 'the access was revoked';
        flight.controller.abort();
      }
      this.onRevoke?.();
    }
    return this.drained();
  }
}

/**
 * The model gateway. It holds the vendor keys, issues revocable grants bound to a budget,
 * reserves the worst-case cost of every request before sending it and settles what the vendor
 * reports. `serve` (see `server.ts`) exposes it over HTTP to sandboxes; `inProcess` gives the
 * host's own callers the same pipeline without a socket.
 */
export class Gateway {
  readonly limits: GatewayLimits;
  private readonly table: Map<string, ModelPrice>;
  private readonly send: typeof fetch;
  private readonly warn: NonNullable<GatewayOptions['onWarning']>;
  private readonly byToken = new Map<string, Grant>();
  private readonly grants = new Set<Grant>();
  private readonly pools = new Map<string, Pool>();
  private closed = false;

  constructor(private readonly options: GatewayOptions) {
    this.limits = { ...DEFAULT_GATEWAY_LIMITS, ...options.limits };
    this.table = modelTable(options.models);
    this.send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.warn = options.onWarning ?? (() => undefined);
  }

  /** Issues a grant whose token a sandbox sends as its API key. */
  issue(input: IssueInput): GrantHandle {
    const grant = this.grant(input);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const hash = hashOf(token);
    this.byToken.set(hash, grant);
    const onRevoke = grant.onRevoke;
    grant.onRevoke = () => {
      this.byToken.delete(hash);
      onRevoke?.();
    };
    return {
      token,
      revoke: () => grant.revoke(),
      spend: () => grant.state(),
      onSpend: (listener) => {
        grant.listeners.add(listener);
        return () => grant.listeners.delete(listener);
      },
    };
  }

  /** A grant for a caller in this process: its `fetch` runs the same pipeline as the HTTP route. */
  inProcess(input: Omit<IssueInput, 'taskId'>): InProcessClient {
    const grant = this.grant(input);
    const call = async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(target, init);
      const route = routeOf(input.vendor, new URL(request.url).pathname);
      if (request.method !== 'POST' || route === undefined) {
        return refusalResponse(input.vendor, 'not_found', 'the gateway does not serve this path');
      }
      const body = new Uint8Array(await request.arrayBuffer());
      return this.handle(grant, route, request.headers, body, request.signal);
    };
    return {
      fetch: call as typeof fetch,
      revoke: () => grant.revoke(),
      spend: () => grant.state(),
    };
  }

  /** Revokes every grant issued for the task; resolves once their requests have settled. */
  async revokeForTask(taskId: string): Promise<void> {
    const revoked: Promise<void>[] = [];
    for (const grant of [...this.grants]) if (grant.taskId === taskId) revoked.push(grant.revoke());
    await Promise.all(revoked);
  }

  /** The grant a token belongs to, for the HTTP route. */
  authenticate(token: string | undefined): { vendor: Vendor; grant: unknown } | undefined {
    if (!token?.startsWith(TOKEN_PREFIX)) return undefined;
    const grant = this.byToken.get(hashOf(token));
    return grant && !grant.revoked ? { vendor: grant.vendor, grant } : undefined;
  }

  /** Whether `search` has a provider. */
  get canSearch(): boolean {
    return this.options.search !== undefined;
  }

  /** Grants open, for tests and stats. */
  get openGrants(): number {
    return this.grants.size;
  }

  /** Requests in flight across all grants. */
  get inFlight(): number {
    let sum = 0;
    for (const grant of this.grants) sum += grant.flights.size;
    return sum;
  }

  /** Revokes every grant and refuses new ones. */
  close(): void {
    this.closed = true;
    for (const grant of [...this.grants]) grant.revoke();
  }

  /** Runs one request of `grant` (from `authenticate`) through the pipeline. */
  async handle(
    grantRef: unknown,
    route: Route,
    headers: Headers,
    raw: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Response> {
    const grant = grantRef as Grant;
    const vendor = grant.vendor;
    if (grant.revoked) return refusalResponse(vendor, 'unauthenticated', 'the access was revoked');
    if (grant.flights.size >= this.limits.maxInflightPerGrant) {
      return refusalResponse(vendor, 'busy', 'too many requests at once');
    }
    if (raw.byteLength > this.limits.maxBodyBytes) {
      return refusalResponse(vendor, 'too_large', 'the request body is too large');
    }
    const flight: Flight = { controller: new AbortController() };
    grant.flights.add(flight);
    const onAbort = (): void => flight.controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) flight.controller.abort();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', onAbort);
      grant.land(flight);
    };
    try {
      const response = await this.process(grant, route, headers, raw, flight, release);
      return response;
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * One web search of `grant` (from `authenticate`), whatever its vendor. The call's price is
   * reserved before it is sent, and settled at that price when the provider bills it (or may
   * have), else at nothing. The answer is plain JSON, `{results: [{title, url, snippet,
   * published?}]}`, and names no provider. The results are web text: data, never instructions.
   */
  async search(grantRef: unknown, raw: Uint8Array, signal?: AbortSignal): Promise<Response> {
    const grant = grantRef as Grant;
    if (grant.revoked) return plainRefusal('unauthenticated', 'the access was revoked');
    const options = this.options.search;
    if (!options) return plainRefusal('unavailable', 'web search is not available');
    if (grant.flights.size >= this.limits.maxInflightPerGrant) {
      return plainRefusal('busy', 'too many requests at once');
    }
    if (raw.byteLength > MAX_SEARCH_BODY_BYTES) {
      return plainRefusal('too_large', 'the request body is too large');
    }
    let parsed: ReturnType<typeof parseSearchRequest>;
    try {
      parsed = parseSearchRequest(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      return plainRefusal('invalid_request', 'the request body is not JSON');
    }
    if (typeof parsed === 'string') return plainRefusal('invalid_request', parsed);

    const flight: Flight = { controller: new AbortController() };
    grant.flights.add(flight);
    const onAbort = (): void => flight.controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) flight.controller.abort();
    const timer = setTimeout(() => {
      flight.cut ??= 'the search took too long';
      flight.controller.abort();
    }, options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
    const callUsd = options.callUsd ?? DEFAULT_SEARCH_CALL_USD;
    const key = `${grant.id}:${randomBytes(8).toString('hex')}`;
    try {
      const reserved = this.reserve(grant, key, callUsd);
      if (!reserved.ok) {
        return plainRefusal(reserved.budget ? 'budget' : 'invalid_request', reserved.reason);
      }
      if (flight.controller.signal.aborted) {
        this.settle(grant, key, 0);
        return plainRefusal('unavailable', flight.cut ?? 'the search was cancelled');
      }
      let outcome: SearchOutcome;
      try {
        outcome = await options.provider.search(parsed, flight.controller.signal);
      } catch {
        outcome = { ok: false, billed: 'unknown', retryable: true };
      }
      const billed = outcome.ok ? outcome.billed : outcome.billed === 'unknown';
      this.settle(grant, key, billed ? callUsd : 0);
      if (outcome.ok) {
        return new Response(JSON.stringify({ results: outcome.hits }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (flight.cut !== undefined) return plainRefusal('unavailable', flight.cut);
      if (!outcome.retryable) {
        return plainRefusal('invalid_request', 'the search service refused the query');
      }
      this.warn('A web search failed', { subject: grant.subject });
      return plainRefusal('unavailable', 'the search service could not answer; try again');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      grant.land(flight);
    }
  }

  // -- the pipeline ------------------------------------------------------------------------------

  private async process(
    grant: Grant,
    route: Route,
    headers: Headers,
    raw: Uint8Array,
    flight: Flight,
    release: () => void,
  ): Promise<Response> {
    const vendor = grant.vendor;
    const refuse = (refusal: Refusal, message: string): Response => {
      release();
      return refusalResponse(vendor, refusal, message);
    };
    const upstream = this.options.upstreams[vendor];
    if (!upstream) return refuse('unavailable', 'no model access is configured for this route');
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return refuse('invalid_request', 'the request body is not JSON');
    }
    if (!isObject(json)) return refuse('invalid_request', 'the request body is not a JSON object');

    if (route === 'count') return this.forwardCount(upstream, json, headers, flight, release);

    const bounded =
      vendor === 'anthropic'
        ? boundAnthropic(raw, json, this.table, this.limits)
        : boundOpenAI(raw, json, this.table, this.limits);
    if (!bounded.ok) return refuse('invalid_request', bounded.reason);

    const key = `${grant.id}:${randomBytes(8).toString('hex')}`;
    let reservedUsd: number | undefined;
    let budgetRefusal: string | undefined;
    const usd = worstCaseUsd(bounded.price, bounded);
    const reserved = this.reserve(grant, key, usd);
    if (reserved.ok) reservedUsd = usd;
    else if (reserved.budget && vendor === 'anthropic') budgetRefusal = reserved.reason;
    else return refuse(reserved.budget ? 'budget' : 'invalid_request', reserved.reason);
    if (reservedUsd === undefined) {
      // The byte bound does not fit: count the request, and reserve the count.
      const counted = await this.count(upstream, json, headers, flight.controller.signal);
      if (flight.controller.signal.aborted) {
        return refuse('unavailable', flight.cut ?? 'the request was cancelled');
      }
      if (!counted.ok) {
        if (counted.transient)
          return refuse('unavailable', 'the request could not be counted; try again');
        return refuse('budget', budgetRefusal ?? 'the request could not be counted');
      }
      const usd = worstCaseUsd(bounded.price, {
        ...bounded,
        inputTokens: countedInputTokens(counted.tokens, this.limits),
      });
      const reserved = this.reserve(grant, key, usd);
      if (!reserved.ok) {
        return refuse(reserved.budget ? 'budget' : 'invalid_request', reserved.reason);
      }
      reservedUsd = usd;
    }

    if (flight.controller.signal.aborted) {
      // Cut before anything was sent: nothing to charge.
      this.settle(grant, key, 0);
      return refuse('unavailable', flight.cut ?? 'the request was cancelled');
    }
    let response: Response;
    try {
      response = await this.send(this.url(vendor, upstream, route), {
        method: 'POST',
        headers: this.upstreamHeaders(vendor, upstream, headers),
        body: bounded.body as Uint8Array<ArrayBuffer>,
        signal: flight.controller.signal,
      });
    } catch (error) {
      // Whether the vendor billed it is unknown unless the connection never opened.
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      this.settle(grant, key, code !== undefined && NOT_SENT.has(code) ? 0 : reservedUsd);
      release();
      if (flight.cut !== undefined) return refusalResponse(vendor, 'unavailable', flight.cut);
      this.warn('A model request failed before its response', { subject: grant.subject });
      return refusalResponse(vendor, 'unavailable', 'the model service could not be reached');
    }

    if (!response.ok || response.body === null) {
      // The vendors bill no request they answer with an error status.
      this.settle(grant, key, response.ok ? reservedUsd : 0);
      const body = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
      release();
      return new Response(body, { status: response.status, headers: passedHeaders(response) });
    }
    return this.metered(grant, key, bounded, reservedUsd, response, flight, release);
  }

  /**
   * Passes the response through while its usage is read, and settles once it ends, however it
   * ends. A stream is cut when the grant is revoked and when the input the vendor reports makes
   * the request dearer than its reservation.
   */
  private metered(
    grant: Grant,
    key: string,
    bounded: Extract<Bounded, { ok: true }>,
    reservedUsd: number,
    response: Response,
    flight: Flight,
    release: () => void,
  ): Response {
    const vendor = grant.vendor;
    const { price } = bounded;
    const tracker = new UsageTracker(vendor, bounded.stream, bounded.oneHourCache, () => {
      const atMost = costUsd(price, { ...tracker.usage, output: bounded.outputTokens });
      if (atMost > reservedUsd + 1e-9) {
        flight.cut ??= 'the request was larger than its reservation';
        this.warn('A model request was cut: its input passed the bound', {
          subject: grant.subject,
        });
        flight.controller.abort();
      }
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => reject(new Error('aborted'));
      if (flight.controller.signal.aborted) fail();
      else flight.controller.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined);
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      const usage = tracker.usage;
      let usd: number;
      if (tracker.complete) usd = costUsd(price, usage);
      // A response that ended without its full usage settles at the reservation.
      else if (tracker.inputKnown && !tracker.ended) {
        usd = costUsd(price, { ...usage, output: Math.max(usage.output, bounded.outputTokens) });
      } else usd = reservedUsd;
      this.settle(grant, key, usd);
      release();
    };
    // A cut settles whether or not anyone reads the body: after the chunk being read, if any.
    const onCut = (): void => {
      queueMicrotask(() => {
        void reader.cancel().catch(() => undefined);
        finish();
      });
    };
    if (flight.controller.signal.aborted) onCut();
    else flight.controller.signal.addEventListener('abort', onCut, { once: true });
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const next = await Promise.race([reader.read(), aborted]);
          if (next.done) {
            tracker.end();
            finish();
            controller.close();
            return;
          }
          tracker.feed(next.value);
          controller.enqueue(next.value);
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          finish();
          if (flight.cut !== undefined && bounded.stream) {
            controller.enqueue(cutEvent(vendor, flight.cut));
            controller.close();
          } else controller.error(error);
        }
      },
      cancel: async () => {
        flight.controller.abort();
        void reader.cancel().catch(() => undefined);
        finish();
      },
    });
    return new Response(body, { status: response.status, headers: passedHeaders(response) });
  }

  /** The token count is free: forwarded without a reservation, still only for a live grant. */
  private async forwardCount(
    upstream: Upstream,
    json: Json,
    headers: Headers,
    flight: Flight,
    release: () => void,
  ): Promise<Response> {
    try {
      const response = await this.send(this.url('anthropic', upstream, 'count'), {
        method: 'POST',
        headers: this.upstreamHeaders('anthropic', upstream, headers),
        body: JSON.stringify(countBody(json)),
        signal: flight.controller.signal,
      });
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: passedHeaders(response) });
    } catch {
      return refusalResponse(
        'anthropic',
        'unavailable',
        flight.cut ?? 'the model service could not be reached',
      );
    } finally {
      release();
    }
  }

  private async count(
    upstream: Upstream,
    json: Json,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<{ ok: true; tokens: number } | { ok: false; transient: boolean }> {
    try {
      const response = await this.send(this.url('anthropic', upstream, 'count'), {
        method: 'POST',
        headers: this.upstreamHeaders('anthropic', upstream, headers),
        body: JSON.stringify(countBody(json)),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, transient: response.status === 429 || response.status >= 500 };
      }
      const body: unknown = await response.json();
      const tokens = isObject(body) ? body.input_tokens : undefined;
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
        return { ok: false, transient: false };
      }
      return { ok: true, tokens };
    } catch {
      return { ok: false, transient: true };
    }
  }

  // -- grants and budgets --------------------------------------------------------------------------

  private grant(input: Omit<IssueInput, 'taskId'> & { taskId?: string }): Grant {
    if (this.closed) throw new Error('The model gateway is closed.');
    if (!this.options.upstreams[input.vendor]) {
      throw new Error(`No model access is configured for ${input.vendor}.`);
    }
    let port: BudgetPort;
    let pool: Pool | undefined;
    const budget = input.budget;
    if ('reserve' in budget) port = budget;
    else {
      if (!Number.isFinite(budget.limitUsd) || budget.limitUsd <= 0) {
        throw new Error('A grant needs a positive budget.');
      }
      const own = new Allowance(budget.limitUsd);
      if (budget.poolId !== undefined) pool = this.pool(budget.poolId, budget.limitUsd);
      port = new LimitPort(pool ? [own, pool.allowance] : [own]);
    }
    const grant = new Grant(input.vendor, input.subject, input.taskId, port);
    if (pool) pool.open++;
    this.grants.add(grant);
    grant.onRevoke = () => {
      this.grants.delete(grant);
      if (pool) {
        pool.open--;
        this.evictIdlePools();
      }
    };
    return grant;
  }

  private pool(id: string, limitUsd: number): Pool {
    let pool = this.pools.get(id);
    if (pool) this.pools.delete(id);
    else pool = { allowance: new Allowance(limitUsd), open: 0 };
    // Most recently used last, so eviction takes the oldest idle pools.
    this.pools.set(id, pool);
    return pool;
  }

  private evictIdlePools(): void {
    let idle = 0;
    for (const pool of this.pools.values()) if (pool.open === 0) idle++;
    for (const [id, pool] of this.pools) {
      if (idle <= this.limits.maxIdlePools) return;
      if (pool.open === 0) {
        this.pools.delete(id);
        idle--;
      }
    }
  }

  private reserve(grant: Grant, key: string, usd: number): ReserveResult {
    let result: ReserveResult;
    try {
      result = grant.port.reserve(key, usd);
    } catch {
      this.warn('A budget could not be read', { subject: grant.subject });
      result = { ok: false, reason: 'the budget could not be read' };
    }
    if (!result.ok && result.budget && !grant.exhausted) {
      grant.exhausted = true;
      grant.notify();
    }
    return result;
  }

  private settle(grant: Grant, key: string, usd: number): void {
    try {
      grant.port.settle(key, usd);
    } catch {
      this.warn('A model request could not be settled', { subject: grant.subject });
    }
    grant.spentUsd += usd;
    grant.notify();
  }

  // -- upstream ------------------------------------------------------------------------------------

  private url(vendor: Vendor, upstream: Upstream, route: Route): string {
    const base = (upstream.baseUrl ?? DEFAULT_BASE[vendor]).replace(/\/+$/u, '');
    if (route === 'messages') return `${base}/v1/messages`;
    if (route === 'count') return `${base}/v1/messages/count_tokens`;
    return `${base}/responses`;
  }

  /** Only what the vendor needs; the caller's own credentials never pass. */
  private upstreamHeaders(vendor: Vendor, upstream: Upstream, incoming: Headers): Headers {
    const out = new Headers({ 'content-type': 'application/json' });
    const accept = incoming.get('accept');
    if (accept) out.set('accept', accept);
    if (vendor === 'anthropic') {
      out.set('x-api-key', upstream.apiKey);
      out.set('anthropic-version', incoming.get('anthropic-version') ?? '2023-06-01');
      const beta = incoming.get('anthropic-beta');
      if (beta) out.set('anthropic-beta', beta);
    } else {
      out.set('authorization', `Bearer ${upstream.apiKey}`);
      const beta = incoming.get('openai-beta');
      if (beta) out.set('openai-beta', beta);
    }
    return out;
  }
}

function passedHeaders(response: Response): Headers {
  const out = new Headers();
  for (const name of PASSED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

/** The route a path asks for, under the vendor's prefix or bare (for in-process clients). */
export function routeOf(vendor: Vendor, pathname: string): Route | undefined {
  const path = pathname.replace(/\/+$/u, '');
  if (vendor === 'anthropic') {
    if (path.endsWith('/v1/messages/count_tokens')) return 'count';
    if (path.endsWith('/v1/messages')) return 'messages';
    return undefined;
  }
  return path.endsWith('/responses') ? 'responses' : undefined;
}
