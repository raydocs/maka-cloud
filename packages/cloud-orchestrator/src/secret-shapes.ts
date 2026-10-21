/**
 * Shapes of the keys and tokens this system and its vendors hand out, and of the headers that
 * carry them. Text that leaves the process (a log line, an error shown to the owner) goes through
 * `scrubSecretShapes` first. Every pattern here is narrow enough to leave ordinary prose and page
 * titles alone; the host's logger adds broader ones of its own.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\b(?:Bearer|Basic)\s+[\w.~+/=-]+/giu,
  /\b(?:sk|pk|rk)-[\w-]{8,}/gu,
  /\bgh[pousr]_\w{16,}/gu,
  /\bgithub_pat_\w{16,}/gu,
  /\bAIza[\w-]{20,}/gu,
  /\bibx-[\w-]{6,}/gu,
  /\bmk[iog]_[\w.-]{8,}/gu,
  // A header or setting that carries a key: the name stays, the value goes.
  /\b((?:x-api-key|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
];

/** Names whose value is a secret whatever it looks like: in a header, a query string or a JSON field. */
const SECRET_FIELD =
  'authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer|token|secret|client[_-]?secret|password|passwd|credentials?|cookie|set-cookie|private[_-]?key|signature|x-amz-security-token';

/** A query-string or fragment parameter that carries a secret: the name stays, the value goes. */
const SECRET_PARAM = new RegExp(
  `([?&;#](?:${SECRET_FIELD}|key|auth|sig|x-amz-signature|x-goog-signature)=)[^&#\\s"'<>]+`,
  'giu',
);

/** The start of a JSON (or JS object) field with a secret name: `"Authorization":`, also inside an escaped string. */
const SECRET_JSON_FIELD = new RegExp(`(\\\\?)(["'])(?:${SECRET_FIELD})\\1\\2\\s*:\\s*`, 'giu');

/**
 * Header and credential pairs written as data rather than as `name: value`:
 * `{"scheme":"Basic","value":"..."}`, `{"name":"Authorization","value":"..."}`, `["Authorization","..."]`.
 */
const SECRET_PAIRS: readonly RegExp[] = [
  /("(?:scheme|type)"\s*:\s*"(?:Bearer|Basic|Digest|Token|ApiKey)"[^{}]*?"(?:value|credentials?|token|param|parameter)"\s*:\s*)"(?:[^"\\]|\\.)*"/giu,
  /("(?:value|credentials?|token|param|parameter)"\s*:\s*)"(?:[^"\\]|\\.)*"(?=[^{}]*?"(?:scheme|type)"\s*:\s*"(?:Bearer|Basic|Digest|Token|ApiKey)")/giu,
  /("(?:name|key|header)"\s*:\s*"(?:authorization|proxy-authorization|x-api-key|cookie)"[^{}]*?"value"\s*:\s*)"(?:[^"\\]|\\.)*"/giu,
  /(\[\s*"(?:authorization|proxy-authorization|x-api-key|cookie)"\s*,\s*)"(?:[^"\\]|\\.)*"/giu,
];

const MIN_KNOWN_SECRET_LENGTH = 8;
let knownSecrets: RegExp | undefined;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * The secret values this process holds (the keys it was given), replaced wherever they appear in
 * text that leaves it: as they are, URL-encoded, escaped for JSON, or as the base64 of a Basic
 * credential that has them in it. Replaces the earlier list; values shorter than eight characters
 * are ignored because they would eat ordinary words.
 */
export function setKnownSecrets(values: readonly string[]): void {
  const forms = new Set<string>();
  for (const value of values) {
    const secret = value.trim();
    if (secret.length < MIN_KNOWN_SECRET_LENGTH) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1));
    forms.add(Buffer.from(secret).toString('base64').replace(/=+$/u, ''));
  }
  knownSecrets =
    forms.size === 0
      ? undefined
      : new RegExp(
          [...forms]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegExp)
            .join('|'),
          'gu',
        );
}

/** The index just after the value that starts at `start`: a string, an array or object (balanced), or a bare word. */
function endOfValue(text: string, start: number, escaped: boolean): number {
  const first = text[start];
  if (first === '"' || first === "'" || (escaped && first === '\\')) {
    const quote = escaped ? '\\"' : first;
    let i = start + quote.length;
    while (i < text.length) {
      if (text.startsWith(quote, i)) return i + quote.length;
      i += !escaped && text[i] === '\\' ? 2 : 1;
    }
    return text.length;
  }
  if (first === '[' || first === '{') {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && !/[\s,}\]]/u.test(text[i] ?? '')) i++;
  return i;
}

/** Every JSON field with a secret name loses its whole value, whatever shape the value has. */
function scrubJsonFields(text: string): string {
  let out = '';
  let at = 0;
  const field = new RegExp(SECRET_JSON_FIELD.source, 'giu');
  for (let match = field.exec(text); match; match = field.exec(text)) {
    const start = match.index + match[0].length;
    const escaped = match[1] === '\\';
    const end = endOfValue(text, start, escaped);
    const quote = escaped ? '\\"' : (match[2] ?? '"');
    out += `${text.slice(at, start)}${quote}[secret]${quote}`;
    at = end;
    field.lastIndex = end;
  }
  return out + text.slice(at);
}

/** `text` with every secret-shaped run replaced by `[secret]`. */
export function scrubSecretShapes(text: string): string {
  let out = knownSecrets ? text.replace(knownSecrets, '[secret]') : text;
  out = scrubJsonFields(out);
  for (const pair of SECRET_PAIRS) out = out.replace(pair, '$1"[secret]"');
  out = out.replace(SECRET_PARAM, '$1[secret]');
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, (match, name: unknown) =>
      typeof name === 'string' ? `${name}[secret]` : '[secret]',
    );
  }
  return out;
}

const SECRET_KEY = new RegExp(`^(?:${SECRET_FIELD})$`, 'iu');

/**
 * A value as clients see it, field by field before it is written out: a field with a secret name
 * loses its whole value, and every string goes through `scrubSecretShapes`.
 */
export function scrubSecretFields(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubSecretShapes(value);
  if (depth > 12 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubSecretFields(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) && item !== null && item !== undefined
        ? '[secret]'
        : scrubSecretFields(item, depth + 1),
    ]),
  );
}
