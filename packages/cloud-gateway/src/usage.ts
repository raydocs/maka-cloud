import { emptyUsage, type Usage, type Vendor } from './pricing.js';

/** Longest SSE line the tracker reads; the rest of a longer one is skipped (usage lines are short). */
const MAX_LINE_CHARS = 1_048_576;
/** Largest JSON response body whose usage is read. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reads the vendor's usage from a response while its bytes pass through unchanged. For an
 * Anthropic stream the input counts are known at `message_start`, before any output.
 */
export class UsageTracker {
  readonly usage: Usage = emptyUsage();
  /** The input counts are known. */
  inputKnown = false;
  /** The vendor's final usage was seen. */
  complete = false;
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
        this.inputKnown = true;
        this.onInputKnown();
      } else if (data.type === 'message_delta') {
        this.read(data.usage, false);
      } else if (data.type === 'message_stop') {
        this.complete = this.inputKnown;
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

  /** Takes the counts present in `raw`; counts the vendor repeats are cumulative, so they replace. */
  private read(raw: unknown, final: boolean): void {
    if (!isObject(raw)) return;
    const u = this.usage;
    if (this.vendor === 'anthropic') {
      const input = count(raw.input_tokens);
      if (input !== undefined) u.input = input;
      const read = count(raw.cache_read_input_tokens);
      if (read !== undefined) u.cacheRead = read;
      const split = isObject(raw.cache_creation) ? raw.cache_creation : undefined;
      const fiveMinutes = count(split?.ephemeral_5m_input_tokens);
      const oneHour = count(split?.ephemeral_1h_input_tokens);
      const written = count(raw.cache_creation_input_tokens);
      if (fiveMinutes !== undefined || oneHour !== undefined) {
        u.cacheWrite5m = fiveMinutes ?? 0;
        u.cacheWrite1h = oneHour ?? 0;
      } else if (written !== undefined) {
        u.cacheWrite5m = this.oneHourCache ? 0 : written;
        u.cacheWrite1h = this.oneHourCache ? written : 0;
      }
      const output = count(raw.output_tokens);
      if (output !== undefined) u.output = output;
      if (final) {
        this.inputKnown = true;
        this.complete = true;
      }
      return;
    }
    const input = count(raw.input_tokens) ?? 0;
    const details = isObject(raw.input_tokens_details) ? raw.input_tokens_details : undefined;
    const cached = Math.min(input, count(details?.cached_tokens) ?? 0);
    u.input = input - cached;
    u.cacheRead = cached;
    u.output = count(raw.output_tokens) ?? 0;
    this.inputKnown = true;
    this.complete = final;
  }
}
