/** Web search for tasks: a provider behind the gateway, paid per call from the task's budget. */

export interface SearchRequest {
  /** 1 to `MAX_QUERY_CHARS` characters. */
  query: string;
  /** Results wanted, 1 to `MAX_RESULTS`. */
  count: number;
}

/** One result. Every field is text from the web: data for the task, never instructions. */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** When the page says it was published, as the provider gives it. */
  published?: string;
}

export type SearchOutcome =
  /** `billed`: the provider charged for the call (it found something, even if nothing was kept). */
  | { ok: true; hits: SearchHit[]; billed: boolean }
  /**
   * `billed`: whether the provider charged for the call. `unknown` when the call may have
   * reached it and no answer says (a connection that broke after the request was sent).
   */
  | { ok: false; billed: 'no' | 'unknown'; retryable: boolean };

/** A search backend. It never puts its own name in what it returns. */
export interface SearchProvider {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchOutcome>;
}

export const MAX_QUERY_CHARS = 128;
/** A search request body is a query and a count: anything longer is refused unread. */
export const MAX_SEARCH_BODY_BYTES = 4_096;
/** What one call is reserved and settled at by default: the DeepSeek Search API's $0.75 per 1k calls. */
export const DEFAULT_SEARCH_CALL_USD = 0.00075;
/** How long a call may take before the gateway cuts it. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
export const MAX_RESULTS = 20;
export const DEFAULT_RESULTS = 10;

const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 2_000;
const MAX_URL_CHARS = 2_048;

/** Text with control characters other than newline and tab removed, cut to `max`. */
function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    '',
  );
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A result as it may leave the gateway: an http(s) URL and bounded, cleaned text. */
export function cleanHit(raw: {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  published?: unknown;
}): SearchHit | undefined {
  if (typeof raw.url !== 'string' || raw.url.length > MAX_URL_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const published = clean(raw.published, 64);
  return {
    title: clean(raw.title, MAX_TITLE_CHARS),
    url: url.href,
    snippet: clean(raw.snippet, MAX_SNIPPET_CHARS),
    ...(published === '' ? {} : { published }),
  };
}

/** The request a task sent, or why it is not one. */
export function parseSearchRequest(body: unknown): SearchRequest | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'the request body is not a JSON object';
  }
  const { query, count, ...rest } = body as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) return `the field "${extra}" is not allowed`;
  if (typeof query !== 'string' || query.trim() === '') return 'the query is empty';
  if (query.trim().length > MAX_QUERY_CHARS) {
    return `the query is longer than ${MAX_QUERY_CHARS} characters`;
  }
  if (count !== undefined && (!Number.isInteger(count) || (count as number) < 1)) {
    return 'count must be a positive whole number';
  }
  return {
    query: query.trim(),
    count: Math.min((count as number | undefined) ?? DEFAULT_RESULTS, MAX_RESULTS),
  };
}

export interface DeepSeekSearchOptions {
  apiKey: string;
  /** Default `https://api.deepseek.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Errors of a request that never reached the provider, so nothing was billed. */
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * The DeepSeek Search API (`POST /v1/tools/search`). It bills a call that answers 200 with at
 * least one result; errors, empty results and timeouts are free.
 */
export function deepSeekSearch(options: DeepSeekSearchOptions): SearchProvider {
  const base = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/u, '');
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async search(request, signal) {
      let response: Response;
      try {
        response = await send(`${base}/v1/tools/search`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query: request.query, count: request.count }),
          signal,
        });
      } catch (error) {
        const code = (error as { cause?: { code?: string } })?.cause?.code;
        return {
          ok: false,
          billed: code !== undefined && NOT_SENT.has(code) ? 'no' : 'unknown',
          retryable: true,
        };
      }
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        return {
          ok: false,
          billed: 'no',
          retryable: response.status === 429 || response.status >= 500 || response.status === 408,
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // A 200 whose body did not arrive whole: it may have been billed.
        return { ok: false, billed: 'unknown', retryable: true };
      }
      const results = (body as { results?: unknown } | null)?.results;
      // Only a valid empty list means nothing was found, and nothing billed. An answer without
      // one may have been billed, so it keeps the reservation.
      if (!Array.isArray(results)) return { ok: false, billed: 'unknown', retryable: false };
      const found = results;
      const hits: SearchHit[] = [];
      for (const raw of found) {
        if (typeof raw !== 'object' || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        const hit = cleanHit({
          title: entry.title,
          url: entry.url,
          snippet: entry.snippet ?? entry.summary,
          published: entry.date,
        });
        if (hit) hits.push(hit);
        if (hits.length >= request.count) break;
      }
      return { ok: true, hits, billed: found.length > 0 };
    },
  };
}
