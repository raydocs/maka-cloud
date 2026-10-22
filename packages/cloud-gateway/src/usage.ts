import { emptyUsage, type Usage, type Vendor } from './pricing.js';

/** Longest SSE line the tracker reads; the rest of a longer one is skipped (usage lines are short). */
const MAX_LINE_CHARS = 1_048_576;
/** Largest JSON response body whose usage is read. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A count that is not a non-negative integer. */
const INVALID = Symbol('invalid');

type Count = number | undefined | typeof INVALID;

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A count the field must carry: anything but a count (absent and `null` included) is invalid. */
function required(value: unknown): number | typeof INVALID {
  return isCount(value) ? value : INVALID;
}

/**
 * A count the vendor may leave out: absent or `null` is "not given", which is only allowed where
 * the vendor's API documents it as nullable.
 */
function optional(value: unknown): Count {
  if (value === undefined || value === null) return undefined;
  return isCount(value) ? value : INVALID;
}

/**
 * A field the schema does not list is allowed only if it cannot carry a charge: a string, a
 * boolean, `null` or a zero. A count above zero or an object could bill what nothing prices.
 */
function harmless(value: unknown): boolean {
  return value === null || value === 0 || typeof value === 'string' || typeof value === 'boolean';
}

function unlisted(raw: Json, listed: ReadonlySet<string>): boolean {
  return Object.entries(raw).some(([key, value]) => !listed.has(key) && !harmless(value));
}

const ANTHROPIC_USAGE = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cache_creation',
  'server_tool_use',
]);
const ANTHROPIC_SPLIT = new Set(['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']);
const OPENAI_USAGE = new Set([
  'input_tokens',
  'input_tokens_details',
  'output_tokens',
  'output_tokens_details',
  'total_tokens',
]);
const OPENAI_INPUT_DETAILS = new Set([
  'cached_tokens',
  'cache_write_tokens',
  'cache_write_tokens_details',
]);
const OPENAI_WRITE_SPLIT = new Set(['ttl_30m_tokens', 'ttl_12h_tokens']);
const OPENAI_OUTPUT_DETAILS = new Set(['reasoning_tokens']);

/**
 * Reads the vendor's usage from a response while its bytes pass through unchanged. For an
 * Anthropic stream the input counts are known at `message_start`, before any output.
 */
export class UsageTracker {
  readonly usage: Usage = emptyUsage();
  /** The vendor gave a valid input count. */
  private input = false;
  /** The vendor gave a valid final output count. */
  private output = false;
  /** The vendor's final usage was seen. */
  private final = false;
  /** A count the vendor gave broke the schema: what it billed cannot be known. */
  private malformed = false;
  /** The cache-write aggregate the vendor gave, if it gave one. */
  private written: number | undefined;
  /** The highest output count seen, the start's placeholder included. */
  private outputSeen = 0;
  private readonly decoder = new TextDecoder();
  private line = '';
  private skipping = false;
  private readonly json: Uint8Array[] = [];
  private jsonBytes = 0;

  constructor(
    private readonly vendor: Vendor,
    private readonly stream: boolean,
    /** The request asked for a one-hour cache: an unsplit cache-write count is charged at that rate. */
    private readonly oneHourCache: boolean,
    private readonly onInputKnown: () => void = () => undefined,
  ) {}

  /** The input counts are known, and every count seen so far was valid. */
  get inputKnown(): boolean {
    return this.input && !this.malformed;
  }

  /** The vendor's final usage was seen, whether or not it was complete. */
  get ended(): boolean {
    return this.final;
  }

  /** The vendor's final usage was seen, with a valid input and output count and nothing malformed. */
  get complete(): boolean {
    return this.final && this.input && this.output && !this.malformed;
  }

  feed(chunk: Uint8Array): void {
    if (!this.stream) {
      if (this.jsonBytes + chunk.byteLength <= MAX_JSON_BYTES) this.json.push(chunk);
      this.jsonBytes += chunk.byteLength;
      return;
    }
    this.lines(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    if (!this.stream) {
      if (this.jsonBytes > MAX_JSON_BYTES) return;
      try {
        const body: unknown = JSON.parse(Buffer.concat(this.json).toString('utf8'));
        if (!isObject(body)) return;
        if (this.vendor === 'anthropic') this.anthropic(body.usage, 'body');
        else this.openAI(body.usage);
      } catch {
        // Not JSON: no usage, so the reservation stands as the charge.
      }
      return;
    }
    this.lines(`${this.decoder.decode()}\n`);
  }

  private lines(text: string): void {
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) {
        if (!this.skipping) this.line += text.slice(start);
        if (this.line.length > MAX_LINE_CHARS) {
          this.line = '';
          this.skipping = true;
        }
        return;
      }
      if (!this.skipping) this.event(this.line + text.slice(start, newline));
      this.line = '';
      this.skipping = false;
      start = newline + 1;
    }
  }

  private event(line: string): void {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith('data:')) return;
    let data: unknown;
    try {
      data = JSON.parse(trimmed.slice(5).trim());
    } catch {
      return;
    }
    if (!isObject(data)) return;
    if (this.vendor === 'anthropic') {
      if (data.type === 'message_start') {
        this.anthropic(isObject(data.message) ? data.message.usage : undefined, 'start');
        if (this.inputKnown) this.onInputKnown();
      } else if (data.type === 'message_delta') {
        this.anthropic(data.usage, 'delta');
      } else if (data.type === 'message_stop') {
        this.final = true;
      }
      return;
    }
    if (
      data.type === 'response.completed' ||
      data.type === 'response.incomplete' ||
      data.type === 'response.failed'
    ) {
      this.openAI(isObject(data.response) ? data.response.usage : undefined);
    }
  }

  /** Records `value`, or marks the usage malformed for good when it is invalid. */
  private take(value: Count): number | undefined {
    if (value !== INVALID) return value;
    this.malformed = true;
    return undefined;
  }

  /**
   * Moves a cumulative count forward. A count below the one seen before cannot be right, so it
   * marks the usage malformed.
   */
  private advance(before: number, value: number | undefined): number {
    if (value === undefined) return before;
    if (value < before) this.malformed = true;
    return Math.max(before, value);
  }

  /**
   * An Anthropic usage object: at `message_start`, in a `message_delta` (cumulative counts), or in
   * a whole JSON body. The schema, for every mode:
   * - `output_tokens` is required; `input_tokens` too, except in a delta, where `null` means
   *   unchanged. The cache counts may be `null` (unchanged, or none).
   * - every count is a non-negative integer, and none goes down from one event to the next;
   * - a cache-write split, when present, gives both lifetimes, each at least what it was, and adds
   *   up to the aggregate count (given here or earlier); without one, new writes are charged at
   *   the dearest rate the request allows;
   * - hosted-tool counts, refused in the request, must be zero, and an unlisted field may not
   *   carry a charge.
   * Anything else marks the usage malformed, and the request settles at its reservation.
   */
  private anthropic(raw: unknown, where: 'start' | 'delta' | 'body'): void {
    if (where === 'body') this.final = true;
    if (!isObject(raw) || unlisted(raw, ANTHROPIC_USAGE)) {
      this.malformed = true;
      return;
    }
    if (raw.server_tool_use !== undefined && raw.server_tool_use !== null) {
      const tools = raw.server_tool_use;
      if (!isObject(tools) || Object.values(tools).some((value) => !harmless(value))) {
        this.malformed = true;
      }
    }
    const u = this.usage;
    const input = this.take(
      where === 'delta' ? optional(raw.input_tokens) : required(raw.input_tokens),
    );
    if (input !== undefined) {
      u.input = this.advance(this.input ? u.input : 0, input);
      this.input = true;
    }
    u.cacheRead = this.advance(u.cacheRead, this.take(optional(raw.cache_read_input_tokens)));
    const given = this.take(optional(raw.cache_creation_input_tokens));
    if (given !== undefined) this.written = this.advance(this.written ?? 0, given);
    if (raw.cache_creation !== undefined && raw.cache_creation !== null) {
      const split = raw.cache_creation;
      if (!isObject(split) || unlisted(split, ANTHROPIC_SPLIT)) this.malformed = true;
      else {
        const fiveMinutes = this.take(required(split.ephemeral_5m_input_tokens));
        const oneHour = this.take(required(split.ephemeral_1h_input_tokens));
        if (fiveMinutes !== undefined && oneHour !== undefined) {
          u.cacheWrite5m = this.advance(u.cacheWrite5m, fiveMinutes);
          u.cacheWrite1h = this.advance(u.cacheWrite1h, oneHour);
          if (this.written !== fiveMinutes + oneHour) this.malformed = true;
        }
      }
    }
    const unsplit = (this.written ?? 0) - u.cacheWrite5m - u.cacheWrite1h;
    if (unsplit > 0) {
      if (this.oneHourCache) u.cacheWrite1h += unsplit;
      else u.cacheWrite5m += unsplit;
    }
    const output = this.take(required(raw.output_tokens));
    if (output !== undefined) this.outputSeen = this.advance(this.outputSeen, output);
    if (where === 'start') {
      // The start's output count is a placeholder; the final one comes in `message_delta`.
      this.output = false;
      return;
    }
    if (output !== undefined) {
      u.output = this.outputSeen;
      this.output = true;
    }
  }

  /**
   * An OpenAI final usage object, read once. The schema: `input_tokens` and `output_tokens` are
   * required; each details object, when present, carries its count (`cached_tokens`,
   * `reasoning_tokens`), no larger than the total it is part of; `total_tokens`, when present, is
   * their sum; every count is a non-negative integer, and an unlisted field may not carry a
   * charge. Anything else marks the usage malformed, and the request settles at its reservation.
   *
   * Cache writes (GPT-5.6 and later bill them, at 1.25x input for the default 30-minute lifetime):
   * `cache_write_tokens` counts them apart from `cached_tokens` (billed reads), both inside
   * `input_tokens`. A lifetime split, when present, adds up to it. The 12-hour lifetime needs a
   * request field or breakpoint `ttl` the gateway refuses, so a 12-hour write marks the usage malformed. See
   * https://developers.openai.com/api/docs/guides/prompt-caching.
   */
  private openAI(raw: unknown): void {
    if (this.final) this.malformed = true;
    this.final = true;
    if (!isObject(raw) || unlisted(raw, OPENAI_USAGE)) {
      this.malformed = true;
      return;
    }
    const u = this.usage;
    const input = this.take(required(raw.input_tokens));
    const output = this.take(required(raw.output_tokens));
    const detail = (value: unknown, listed: ReadonlySet<string>, key: string): number => {
      if (value === undefined) return 0;
      if (!isObject(value) || unlisted(value, listed)) {
        this.malformed = true;
        return 0;
      }
      return this.take(required(value[key])) ?? 0;
    };
    const details = raw.input_tokens_details;
    const cached = detail(details, OPENAI_INPUT_DETAILS, 'cached_tokens');
    const written = isObject(details) ? this.openAIWrites(details) : 0;
    const reasoning = detail(raw.output_tokens_details, OPENAI_OUTPUT_DETAILS, 'reasoning_tokens');
    const total = this.take(optional(raw.total_tokens));
    if (input === undefined || output === undefined) return;
    if (
      cached + written > input ||
      reasoning > output ||
      (total !== undefined && total !== input + output)
    ) {
      this.malformed = true;
    }
    u.cacheRead = Math.min(input, cached);
    u.cacheWrite5m = Math.min(input - u.cacheRead, written);
    u.input = input - u.cacheRead - u.cacheWrite5m;
    u.output = output;
    this.input = true;
    this.output = true;
  }

  /** The cache writes an OpenAI input details object reports, all at the 30-minute rate. */
  private openAIWrites(details: Json): number {
    const written = this.take(optional(details.cache_write_tokens)) ?? 0;
    const split = details.cache_write_tokens_details;
    if (split === undefined || split === null) return written;
    if (!isObject(split) || unlisted(split, OPENAI_WRITE_SPLIT)) {
      this.malformed = true;
      return written;
    }
    const halfHour = this.take(required(split.ttl_30m_tokens));
    const halfDay = this.take(required(split.ttl_12h_tokens));
    if (halfHour === undefined || halfDay === undefined) return written;
    if (halfDay > 0 || halfHour + halfDay !== written) this.malformed = true;
    return written;
  }
}
