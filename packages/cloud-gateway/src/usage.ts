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

/** A token count; absent (`undefined` or `null`) and malformed are told apart. */
function count(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : INVALID;
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
        if (isObject(body)) this.read(body.usage, true);
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
      if (data.type === 'message_start' && isObject(data.message)) {
        this.read(data.message.usage, false);
        // The start's output count is a placeholder; the final one comes in `message_delta`.
        this.output = false;
        if (this.inputKnown) this.onInputKnown();
      } else if (data.type === 'message_delta') {
        this.read(data.usage, false);
      } else if (data.type === 'message_stop') {
        this.final = true;
      }
      return;
    }
    if (
      (data.type === 'response.completed' ||
        data.type === 'response.incomplete' ||
        data.type === 'response.failed') &&
      isObject(data.response)
    ) {
      this.read(data.response.usage, true);
    }
  }

  /**
   * Takes the counts present in `raw`; counts the vendor repeats are cumulative, so they replace.
   * A count that is present but not a number marks the usage malformed for good.
   */
  private read(raw: unknown, final: boolean): void {
    if (!isObject(raw)) return;
    const take = (value: unknown): number | undefined => {
      const n = count(value);
      if (n !== INVALID) return n;
      this.malformed = true;
      return undefined;
    };
    const u = this.usage;
    if (this.vendor === 'anthropic') {
      const input = take(raw.input_tokens);
      if (input !== undefined) {
        u.input = input;
        this.input = true;
      }
      const read = take(raw.cache_read_input_tokens);
      if (read !== undefined) u.cacheRead = read;
      const split = isObject(raw.cache_creation) ? raw.cache_creation : undefined;
      const fiveMinutes = take(split?.ephemeral_5m_input_tokens);
      const oneHour = take(split?.ephemeral_1h_input_tokens);
      const written = take(raw.cache_creation_input_tokens);
      if (fiveMinutes !== undefined || oneHour !== undefined) {
        u.cacheWrite5m = fiveMinutes ?? 0;
        u.cacheWrite1h = oneHour ?? 0;
      } else if (written !== undefined) {
        u.cacheWrite5m = this.oneHourCache ? 0 : written;
        u.cacheWrite1h = this.oneHourCache ? written : 0;
      }
      const output = take(raw.output_tokens);
      if (output !== undefined) {
        u.output = output;
        this.output = true;
      }
      if (final) this.final = true;
      return;
    }
    const input = take(raw.input_tokens);
    const details = isObject(raw.input_tokens_details) ? raw.input_tokens_details : undefined;
    const cached = take(details?.cached_tokens) ?? 0;
    const output = take(raw.output_tokens);
    if (input !== undefined) {
      u.input = input - Math.min(input, cached);
      u.cacheRead = Math.min(input, cached);
      this.input = true;
    }
    if (output !== undefined) {
      u.output = output;
      this.output = true;
    }
    if (final) this.final = true;
  }
}
