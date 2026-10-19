import { emptyUsage, type Usage, type Vendor } from './pricing.js';

/** Longest SSE line the tracker reads; the rest of a longer one is skipped (usage lines are short). */
const MAX_LINE_CHARS = 1_048_576;
/** Largest JSON response body whose usage is read. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A count that is not a finite, non-negative number. */
const INVALID = Symbol('invalid');

type Count = number | undefined | typeof INVALID;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A count the field must carry: anything but a number (absent and `null` included) is invalid. */
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
  /** A count the vendor gave was not a number: what it billed cannot be known. */
  private malformed = false;
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
   * An Anthropic usage object: at `message_start`, in a `message_delta` (cumulative counts, so
   * they replace; the input fields may be `null` there, meaning unchanged), or in a whole JSON
   * body. The output count is required wherever usage appears. A cache-write split that is
   * present must give both lifetimes and add up to the aggregate count.
   */
  private anthropic(raw: unknown, where: 'start' | 'delta' | 'body'): void {
    if (where === 'body') this.final = true;
    if (!isObject(raw)) {
      this.malformed = true;
      return;
    }
    const u = this.usage;
    const input = this.take(
      where === 'delta' ? optional(raw.input_tokens) : required(raw.input_tokens),
    );
    if (input !== undefined) {
      u.input = input;
      this.input = true;
    }
    const read = this.take(optional(raw.cache_read_input_tokens));
    if (read !== undefined) u.cacheRead = read;
    const written = this.take(optional(raw.cache_creation_input_tokens));
    if (raw.cache_creation !== undefined && raw.cache_creation !== null) {
      const split = isObject(raw.cache_creation) ? raw.cache_creation : {};
      const fiveMinutes = this.take(required(split.ephemeral_5m_input_tokens));
      const oneHour = this.take(required(split.ephemeral_1h_input_tokens));
      if (fiveMinutes !== undefined && oneHour !== undefined) {
        if (written !== undefined && fiveMinutes + oneHour !== written) this.malformed = true;
        u.cacheWrite5m = fiveMinutes;
        u.cacheWrite1h = oneHour;
      }
    } else if (written !== undefined) {
      u.cacheWrite5m = this.oneHourCache ? 0 : written;
      u.cacheWrite1h = this.oneHourCache ? written : 0;
    }
    const output = this.take(required(raw.output_tokens));
    if (where === 'start') {
      // The start's output count is a placeholder; the final one comes in `message_delta`.
      this.output = false;
      return;
    }
    if (output !== undefined) {
      u.output = output;
      this.output = true;
    }
  }

  /** An OpenAI final usage object; the cached and reasoning details must be valid when present. */
  private openAI(raw: unknown): void {
    this.final = true;
    if (!isObject(raw)) {
      this.malformed = true;
      return;
    }
    const u = this.usage;
    const input = this.take(required(raw.input_tokens));
    const output = this.take(required(raw.output_tokens));
    let cached = 0;
    const inputDetails = raw.input_tokens_details;
    if (inputDetails !== undefined) {
      if (!isObject(inputDetails)) this.malformed = true;
      else if (inputDetails.cached_tokens !== undefined) {
        cached = this.take(required(inputDetails.cached_tokens)) ?? 0;
      }
    }
    const outputDetails = raw.output_tokens_details;
    if (outputDetails !== undefined) {
      if (!isObject(outputDetails)) this.malformed = true;
      else if (outputDetails.reasoning_tokens !== undefined) {
        const reasoning = this.take(required(outputDetails.reasoning_tokens));
        if (reasoning !== undefined && output !== undefined && reasoning > output) {
          this.malformed = true;
        }
      }
    }
    if (input !== undefined) {
      if (cached > input) this.malformed = true;
      u.input = input - Math.min(input, cached);
      u.cacheRead = Math.min(input, cached);
      this.input = true;
    }
    if (output !== undefined) {
      u.output = output;
      this.output = true;
    }
  }
}
