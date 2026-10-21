import {
  linkedSecretKeys,
  linkedSecretPair,
  scrubErrorText,
  scrubReading,
  scrubSecretShapes,
  setKnownSecrets,
} from '@maka-cloud/server';

export type LogLevel = 'info' | 'warn' | 'error';
/** Scalars are the norm; anything else (an object, a list) is scrubbed value by value before it prints. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** The stack's `onWarning` shape: a message and whatever went wrong. */
  warning(message: string, detail?: unknown): void;
}

const SECRET_NAME = /key|token|secret|password|passphrase|private|credential|auth/iu;
const MIN_SECRET_LENGTH = 6;
const MAX_FIELD_LENGTH = 1_000;
const NAME = /^[a-z][a-z0-9_.]{0,63}$/u;
const RESERVED = new Set(['ts', 'level', 'event']);

/** What only a log line gets on top of the shared shapes: any setting that smells of a secret, and anything long and key-like. */
const LOG_ONLY_SHAPES: readonly RegExp[] = [
  /\b((?:token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
  /[A-Za-z0-9_-]{40,}/gu,
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The values of the environment variables whose names say they hold a secret, longest first. */
export function secretValuesOf(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        SECRET_NAME.test(entry[0]) && (entry[1]?.trim().length ?? 0) >= MIN_SECRET_LENGTH,
    )
    .map(([, value]) => value.trim())
    .sort((a, b) => b.length - a.length);
}

/**
 * Removes secrets and vendor names from text. Secrets are the values of the environment variables
 * whose names say so (exactly, wherever they appear) and anything shaped like a key or token;
 * vendor names go the way client-facing error text does.
 */
export function createScrubber(env: NodeJS.ProcessEnv = process.env): (text: string) => string {
  const values = secretValuesOf(env);
  const exact = values.length === 0 ? undefined : new RegExp(values.map(escape).join('|'), 'gu');
  const scrub = (text: string): string => {
    let out = exact ? text.replace(exact, '[secret]') : text;
    out = scrubSecretShapes(out);
    for (const shape of LOG_ONLY_SHAPES) {
      out = out.replace(shape, (match, name: unknown) =>
        typeof name === 'string' ? `${name}[secret]` : '[secret]',
      );
    }
    return out;
  };
  return (text) => scrubErrorText(scrubReading(text, scrub));
}

/** The only keys of an error or a detail object that print, and only as scalars. Never a message body, header or endpoint. */
const DETAIL_KEYS = [
  'name',
  'code',
  'status',
  'statusCode',
  'errcode',
  'errstr',
  'errno',
  'syscall',
  'type',
  'kind',
] as const;
const MAX_DEPTH = 4;
const MAX_ITEMS = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A Buffer, any typed array, a DataView or an ArrayBuffer: values whose content is bytes. */
const isBinary = (value: object): boolean =>
  ArrayBuffer.isView(value) ||
  value instanceof ArrayBuffer ||
  (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);

/** An error's message prints only when we wrote it (`safeToLog`) or the operating system did (it names a `syscall`). */
function messageIsSafe(error: Error): boolean {
  const flags = error as Error & { safeToLog?: unknown; syscall?: unknown };
  return flags.safeToLog === true || typeof flags.syscall === 'string';
}

export interface LoggerOptions {
  write: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** One JSON object per line, with every value scrubbed before it is written. */
export function createLogger(options: LoggerOptions): Logger {
  // The process has one logger, made once at start: its secrets are also the ones the server's
  // client-facing text (events, notices, errors) must never show.
  setKnownSecrets(secretValuesOf(options.env ?? process.env));
  const scrub = createScrubber(options.env ?? process.env);
  const now = options.now ?? Date.now;
  const clip = (text: string): string => {
    const clean = scrub(text);
    return clean.length > MAX_FIELD_LENGTH ? `${clean.slice(0, MAX_FIELD_LENGTH)}…` : clean;
  };

  /** A value as it may print: scalars scrubbed, containers walked, a secret-named key dropped whatever it holds. */
  const safe = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return clip(value);
    if (typeof value === 'number' || typeof value === 'bigint') {
      // A number can be a secret too (a PIN, a numeric token): compare it as text.
      const text = String(value);
      return scrub(text) === text ? (typeof value === 'bigint' ? text : value) : '[secret]';
    }
    if (!isRecord(value)) return undefined;
    // Bytes may be a secret (a key, a body): walking them as an object would list every byte.
    if (isBinary(value)) return '[binary]';
    if (seen.has(value) || depth >= MAX_DEPTH) return '[cut]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        // A header written as a pair: the name says what the next one is.
        const pair = linkedSecretPair(value);
        const items = value
          .slice(0, MAX_ITEMS)
          .map((item, index) => (pair && index > 0 ? '[secret]' : safe(item, depth + 1, seen)));
        return value.length > MAX_ITEMS ? [...items, `[${value.length - MAX_ITEMS} more]`] : items;
      }
      if (value instanceof Error) return clip(describeError(value));
      const out: Record<string, unknown> = {};
      // `{ scheme: 'Basic', value }` and `{ name: 'Authorization', value }`: the field beside it says.
      const linked = linkedSecretKeys(value);
      for (const [key, inner] of Object.entries(value).slice(0, MAX_ITEMS)) {
        const name = clip(key);
        out[name] =
          SECRET_NAME.test(key) || linked.has(key) ? '[secret]' : safe(inner, depth + 1, seen);
      }
      return out;
    } catch {
      return '[unprintable]';
    } finally {
      seen.delete(value);
    }
  };

  /** An error as text: its name and the few scalars that identify it. Its message only when it is safe to print. */
  const describeError = (error: Error): string => {
    const parts: string[] = [error.name];
    const flags = error as unknown as Record<string, unknown>;
    for (const key of DETAIL_KEYS) {
      const inner = flags[key];
      if (key !== 'name' && (typeof inner === 'string' || typeof inner === 'number')) {
        parts.push(`${key}=${String(inner)}`);
      }
    }
    return messageIsSafe(error) ? `${parts.join(' ')}: ${error.message}` : parts.join(' ');
  };

  /** Detail for a warning: an error by `describeError`, an object by the allowlist, text as text. */
  const describe = (detail: unknown): string | undefined => {
    if (detail === undefined || detail === null) return undefined;
    if (typeof detail === 'string') return clip(detail);
    if (typeof detail === 'number' || typeof detail === 'boolean') return clip(String(detail));
    if (!isRecord(detail)) return undefined;
    const kept: string[] = [];
    try {
      // An error's properties are read inside the try: a getter that throws must not escape.
      if (detail instanceof Error) return clip(describeError(detail));
      for (const key of DETAIL_KEYS) {
        const inner = (detail as Record<string, unknown>)[key];
        if (typeof inner === 'string' || typeof inner === 'number')
          kept.push(`${key}=${String(inner)}`);
      }
    } catch {
      return 'unprintable';
    }
    return clip(kept.length > 0 ? kept.join(' ') : 'details omitted');
  };

  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const line: Record<string, unknown> = {
      ts: new Date(now()).toISOString(),
      level,
      event: NAME.test(event) ? event : 'invalid_event',
    };
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const key = NAME.test(name) ? name : 'invalid_field';
      const field = RESERVED.has(key) ? `field_${key}` : key;
      // A field whose name says it holds a secret never prints, whatever it holds and whatever its type.
      const printable =
        SECRET_NAME.test(name) || SECRET_NAME.test(field) ? '[secret]' : safe(value, 0, new Set());
      if (printable !== undefined) line[field] = printable;
    }
    let out: string;
    try {
      out = JSON.stringify(line);
    } catch {
      out = JSON.stringify({ ts: line.ts, level, event: line.event, note: 'fields unprintable' });
    }
    options.write(out);
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    warning: (message, detail) => {
      const text = describe(detail);
      emit('warn', 'warning', {
        message: clip(message),
        ...(text === undefined ? {} : { detail: text }),
      });
    },
  };
}
