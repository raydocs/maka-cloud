import { scrubErrorText } from '@maka-cloud/server';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

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

/** Shapes of the keys and tokens this system and its vendors hand out. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\b(?:Bearer|Basic)\s+[\w.~+/=-]+/giu,
  /\b(?:sk|pk|rk)-[\w-]{8,}/gu,
  /\bgh[pousr]_\w{16,}/gu,
  /\bgithub_pat_\w{16,}/gu,
  /\bAIza[\w-]{20,}/gu,
  /\bibx-[\w-]{6,}/gu,
  /\bmk[iog]_[\w.-]{8,}/gu,
  // A header or setting that carries a secret: the name stays, the value goes.
  /\b((?:x-api-key|authorization|api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
  // Anything long and key-like that nothing above knew.
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
  return (text) => {
    let out = text.normalize('NFKC').replace(/\p{Cf}/gu, '');
    if (exact) out = out.replace(exact, '[secret]');
    for (const shape of SECRET_SHAPES) {
      out = out.replace(shape, (match, name: unknown) =>
        typeof name === 'string' ? `${name}[secret]` : '[secret]',
      );
    }
    return scrubErrorText(out);
  };
}

function describe(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  // Name and message only: a stack or a cause chain can carry request bodies and headers.
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail) ?? String(detail);
  } catch {
    return 'unprintable';
  }
}

export interface LoggerOptions {
  write: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** One JSON object per line, with every string scrubbed before it is written. */
export function createLogger(options: LoggerOptions): Logger {
  const scrub = createScrubber(options.env ?? process.env);
  const now = options.now ?? Date.now;
  const clip = (text: string): string => {
    const clean = scrub(text);
    return clean.length > MAX_FIELD_LENGTH ? `${clean.slice(0, MAX_FIELD_LENGTH)}…` : clean;
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
      const safe = RESERVED.has(key) ? `field_${key}` : key;
      if (typeof value === 'string') {
        // A field whose name says it holds a secret never prints, whatever it holds.
        line[safe] = SECRET_NAME.test(safe) ? '[secret]' : clip(value);
      } else {
        line[safe] = value;
      }
    }
    options.write(JSON.stringify(line));
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
