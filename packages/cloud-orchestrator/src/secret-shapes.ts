/**
 * Shapes of the keys and tokens this system and its vendors hand out, and of the headers that
 * carry them. Text that leaves the process (a log line, an error shown to the owner) goes through
 * `scrubSecretShapes` first. Every pattern here is narrow enough to leave ordinary prose and page
 * titles alone; the host's logger adds broader ones of its own.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu,
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
const SECRET_JSON_FIELD = new RegExp(
  `(?<!\\\\)(\\\\*)(["'])(?:${SECRET_FIELD})\\1\\2\\s*:\\s*`,
  'giu',
);

/**
 * Header and credential pairs written as data rather than as `name: value`:
 * `{"scheme":"Basic","value":"..."}`, `{"name":"Authorization","value":"..."}`, `["Authorization","..."]`.
 * Also when the text was serialised again inside a string, which escapes the quotes (`{\\"scheme\\":
 * \\"Basic\\",...}`), once or twice over.
 */
const SCHEMES = 'Bearer|Basic|Digest|Token|ApiKey';
const CREDENTIAL_KEYS = 'value|credentials?|token|param|parameter';
const PAIR_HEADERS = 'authorization|proxy-authorization|x-api-key|cookie';

/** How many times a JSON text can have been put inside another JSON string and still be read. */
const MAX_ESCAPE_DEPTH = 4;

/**
 * The pieces of a JSON string as it is written after `depth` rounds of being put inside another
 * string. A quote is then `\"`, `\\\"`, ... (2^depth - 1 backslashes), a backslash 2^depth of them. A
 * value ends at its own closing quote, never at an escaped quote of the text inside it.
 */
function escapedParts(depth: number) {
  const slashes = 2 ** depth;
  const bs = '\\\\'.repeat(slashes); // regex source for 2^depth backslashes
  const quote = `${'\\\\'.repeat(slashes - 1)}"`;
  const value =
    depth === 0 ? '(?:[^"\\\\]|\\\\.)*' : `(?:[^"\\\\]|${bs}(?:${bs}|${quote}|[^"\\\\]))*?`;
  return { quote, value };
}

const SECRET_PAIRS: readonly [RegExp, string][] = Array.from(
  { length: MAX_ESCAPE_DEPTH + 1 },
  (_, depth) => depth,
).flatMap((depth) => {
  const { quote: q, value } = escapedParts(depth);
  const literal = q.replaceAll('\\\\', '\\');
  // Any other field may sit between the two that give the pair away, before or after.
  const between = '[^{}]{0,512}?';
  return [
    // {"scheme":"Basic", ..., "value":"..."}
    [
      new RegExp(
        `(${q}(?:scheme|type)${q}\\s*:\\s*${q}(?:${SCHEMES})${q}${between}${q}(?:${CREDENTIAL_KEYS})${q}\\s*:\\s*)${q}${value}${q}`,
        'giu',
      ),
      literal,
    ],
    // {"value":"...", ..., "scheme":"Basic"}
    [
      new RegExp(
        `(${q}(?:${CREDENTIAL_KEYS})${q}\\s*:\\s*)${q}${value}${q}(?=${between}${q}(?:scheme|type)${q}\\s*:\\s*${q}(?:${SCHEMES})${q})`,
        'giu',
      ),
      literal,
    ],
    // {"name":"Authorization", ..., "value":"..."}
    [
      new RegExp(
        `(${q}(?:name|key|header)${q}\\s*:\\s*${q}(?:${PAIR_HEADERS})${q}${between}${q}value${q}\\s*:\\s*)${q}${value}${q}`,
        'giu',
      ),
      literal,
    ],
    // {"value":"...", ..., "name":"Authorization"}
    [
      new RegExp(
        `(${q}value${q}\\s*:\\s*)${q}${value}${q}(?=${between}${q}(?:name|key|header)${q}\\s*:\\s*${q}(?:${PAIR_HEADERS})${q})`,
        'giu',
      ),
      literal,
    ],
    // ["Authorization","..."]
    [new RegExp(`(\\[\\s*${q}(?:${PAIR_HEADERS})${q}\\s*,\\s*)${q}${value}${q}`, 'giu'), literal],
  ] as [RegExp, string][];
});

let knownSecrets: RegExp | undefined;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The shortest value that is registered as a secret. */
const MIN_KNOWN_SECRET_LENGTH = 4;

/**
 * The secret values this process holds (the keys it was given), replaced wherever they appear in
 * text that leaves it: as they are, URL-encoded, escaped for JSON, or as the base64 of a Basic
 * credential that has them in it. Replaces the earlier list. A short value counts, however plain it
 * looks (`hunter2`, `google`, `123456`): the caller chose it as a secret, and a key is not left in
 * the text for being short. Only under four characters is a value left out, as it would eat the
 * text around it.
 */
export function setKnownSecrets(values: readonly string[]): void {
  const forms = new Set<string>();
  for (const value of values) {
    const secret = value.trim();
    // Under four characters a value is not a key, and replacing it would eat the text around it. Above
    // that it is kept whatever it looks like (a word, a number): the caller chose it as a secret.
    if (secret.length < MIN_KNOWN_SECRET_LENGTH) continue;
    for (const form of secretForms(secret)) forms.add(form);
  }
  knownSecrets = formsPattern(forms);
}

/** How many times the encodings below can be stacked (percent-encoding a JSON-escaped key, and so on). */
const MAX_ENCODING_LAYERS = 3;

const percent = (text: string): string => encodeURIComponent(text);
const jsonEscape = (text: string): string => JSON.stringify(text).slice(1, -1);

/**
 * The ways a secret can show up in text that was built from it: as it is, percent-encoded, escaped
 * for JSON (also with `/` escaped), each of those put through the others up to three layers deep
 * (a key in a URL in a JSON body in a log line), as a URL's userinfo encodes it, and as the base64
 * of a Basic credential that has it in it. Percent-escapes are written in upper case here; the
 * pattern built from the forms (`formsPattern`) takes either case of every one of them.
 */
export function secretForms(secret: string): string[] {
  const forms = new Set<string>([secret]);
  let frontier = [secret];
  for (let layer = 0; layer < MAX_ENCODING_LAYERS; layer++) {
    const next: string[] = [];
    for (const form of frontier) {
      for (const encoded of [
        percent(form),
        jsonEscape(form),
        jsonEscape(form).replaceAll('/', '\\/'),
      ]) {
        if (!forms.has(encoded)) {
          forms.add(encoded);
          next.push(encoded);
        }
      }
    }
    frontier = next;
  }
  try {
    const url = new URL('https://x.invalid');
    url.password = secret;
    forms.add(url.password);
  } catch {}
  forms.add(Buffer.from(secret).toString('base64').replace(/=+$/u, ''));
  forms.delete('');
  return [...forms];
}

/** A form as a regex source: percent-escapes (also the escaped escapes: `%25 2F`) match in either case of hex. */
function formSource(form: string): string {
  return form
    .split(/(%(?:25)*[0-9A-Fa-f]{2})/u)
    .map((part, index) =>
      index % 2 === 0
        ? escapeRegExp(part)
        : part.replace(/[A-Fa-f]/gu, (hex) => `[${hex.toLowerCase()}${hex.toUpperCase()}]`),
    )
    .join('');
}

function formsPattern(forms: ReadonlySet<string>): RegExp | undefined {
  return forms.size === 0
    ? undefined
    : new RegExp(
        [...forms]
          .sort((a, b) => b.length - a.length)
          .map(formSource)
          .join('|'),
        'gu',
      );
}

/**
 * `text` with each of these values, in every form `secretForms` lists, replaced by `[secret]`. A
 * value of any length counts: the caller says these are secrets, so there is no minimum. A text
 * that is JSON is read first and the replacement made inside each string (a key is escaped by the
 * sender however it likes, `\u0041` included), then the written-out text is checked again.
 */
export function scrubValues(text: string, values: readonly string[]): string {
  const forms = new Set<string>();
  for (const value of values) for (const form of secretForms(value)) forms.add(form);
  const pattern = formsPattern(forms);
  if (!pattern) return text;
  const replace = (value: string) => value.replace(pattern, '[secret]');
  let out = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const walk = (value: unknown): unknown => {
        if (typeof value === 'string') return replace(value);
        if (Array.isArray(value)) return value.map(walk);
        if (typeof value === 'object' && value !== null) {
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [replace(k), walk(v)]));
        }
        return value;
      };
      out = JSON.stringify(walk(parsed));
    }
  } catch {}
  return replace(out);
}

/**
 * The index just after the value that starts at `start`: a string, an array or object (balanced),
 * or a bare word. `slashes` is how many backslashes the quotes of this text carry (0 for plain
 * JSON, 1 for JSON inside a string, 3 inside that, ...): a quote with more backslashes in front
 * belongs to text inside the value, and does not end it.
 */
function endOfValue(text: string, start: number, slashes: number): number {
  const first = text[start];
  const quoteChar = slashes === 0 ? first : text[start + slashes];
  if (
    (slashes === 0 && (first === '"' || first === "'")) ||
    (slashes > 0 && first === '\\' && quoteChar === '"')
  ) {
    const quote = slashes === 0 ? (first as string) : '"';
    let i = start + slashes + 1;
    while (i < text.length) {
      let run = 0;
      while (text[i + run] === '\\') run++;
      if (text[i + run] === quote && run === slashes) return i + run + 1;
      i += run === 0 ? 1 : run + 1;
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
    const slashes = (match[1] ?? '').length;
    const end = endOfValue(text, start, slashes);
    const quote = `${match[1] ?? ''}${match[2] ?? '"'}`;
    out += `${text.slice(at, start)}${quote}[secret]${quote}`;
    at = end;
    field.lastIndex = end;
  }
  return out + text.slice(at);
}

/**
 * A text that is JSON, read as JSON: a field with a secret name, or one that is a credential
 * because of another field beside it (in whatever order the fields come), loses its value, and a
 * string that is JSON again is read the same way. Undefined when the text is not JSON or holds
 * nothing to remove, so that text is left as it was written.
 */
function scrubParsed(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  // Text nested deeper than the stack allows is not read as JSON; the patterns below still see it.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const cleaned = JSON.stringify(scrubSecretFields(parsed));
    return cleaned === JSON.stringify(parsed) ? undefined : cleaned;
  } catch {
    return undefined;
  }
}

/**
 * Runs of text written with escapes (`%5F`, `\u005f`, `\x5f`): a token whose escapes were put in
 * to get past the patterns. Each is read with the escapes undone (up to three rounds, as a token
 * can be escaped again); one that holds a secret once read is replaced whole.
 */
const ESCAPE = String.raw`%[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}`;
// One pass over the token characters and escapes; a run without an escape is skipped by the caller.
// (A pattern that looked for the first escape inside the run backtracked quadratically on a long
// token followed by a lone `%`.)
const ESCAPED_RUN = new RegExp(`(?:[\\w.~+/=:@-]|${ESCAPE})+`, 'gu');
const HAS_ESCAPE = new RegExp(ESCAPE, 'u');

function unescapeRun(run: string): string {
  let text = run;
  for (let round = 0; round < 3; round++) {
    const next = text
      .replace(/\\u([0-9A-Fa-f]{4})/gu, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\x([0-9A-Fa-f]{2})/gu, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/(?:%[0-9A-Fa-f]{2})+/gu, (seq) => {
        try {
          return decodeURIComponent(seq);
        } catch {
          return seq;
        }
      });
    if (next === text) break;
    text = next;
  }
  return text;
}

function scrubEscapedRuns(text: string): string {
  if (!text.includes('%') && !text.includes('\\')) return text;
  return text.replace(ESCAPED_RUN, (run) => {
    if (!HAS_ESCAPE.test(run)) return run;
    const plain = unescapeRun(run);
    return plain !== run && scrubShapes(plain) !== plain ? '[secret]' : run;
  });
}

/** `text` with every secret-shaped run replaced by `[secret]`. */
export function scrubSecretShapes(text: string): string {
  let out = knownSecrets ? text.replace(knownSecrets, '[secret]') : text;
  out = scrubParsed(out) ?? out;
  out = scrubEscapedRuns(out);
  return scrubShapes(out);
}

/**
 * `text` with the vendor key shapes taken out and nothing else: no field is blanked for its name
 * and nothing is parsed. For a copy of text that must stay otherwise exact (the backup of the kept
 * conversations), where a field called `signature` is the model's own. The private key block is
 * not among them: it runs to the end of the text and would take the closing quote of a JSON
 * string with it, so the caller removes it its own way.
 */
export function scrubKeyShapes(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES.slice(1)) {
    out = out.replace(shape, (match, name: unknown) =>
      typeof name === 'string' ? `${name}[secret]` : '[secret]',
    );
  }
  return out;
}

/** The patterns, on text as it is written. */
function scrubShapes(text: string): string {
  let out = knownSecrets ? text.replace(knownSecrets, '[secret]') : text;
  out = scrubJsonFields(out);
  for (const [pair, quote] of SECRET_PAIRS) out = out.replace(pair, `$1${quote}[secret]${quote}`);
  out = out.replace(SECRET_PARAM, '$1[secret]');
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, (match, name: unknown) =>
      typeof name === 'string' ? `${name}[secret]` : '[secret]',
    );
  }
  return out;
}

/**
 * Characters that show nothing, or only change the one before: format characters, combining marks,
 * variation selectors, the Hangul fillers and the Mongolian free variation selectors. A token with
 * one between its letters reads as the same token to a person and to a search, not to a pattern.
 */
const INVISIBLE =
  /[\p{Cf}\p{Mn}\p{Me}\u115f\u1160\u2800\u3164\uffa0\u180b-\u180d\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
/** The same without the combining marks, which are part of how Indic, Thai and Arabic text is written. */
const INVISIBLE_NOT_MARKS =
  /[\p{Cf}\u115f\u1160\u2800\u3164\uffa0\u034f\u180b-\u180d\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
/** A combining mark after an ASCII character: Latin text has no use for one that NFKC could not compose. */
const MARK_AFTER_ASCII = /([\x21-\x7e])[\p{Mn}\p{Me}]+/gu;

/**
 * `value` as it reads: compatibility forms folded, invisible characters gone. For finding secrets,
 * not for showing. Decomposed before the marks go: composed first, `c` and a combining acute would
 * become one letter `ć` with no mark left to remove, and a key written that way would not be found.
 * Composed again after, so Hangul reads as its syllables.
 */
export function withoutInvisible(value: string): string {
  return value.normalize('NFKD').replace(INVISIBLE, '').normalize('NFC');
}

/** Like `withoutInvisible`, but the combining marks of other scripts stay, so it can be shown: the text of an outside page, or of a message with a secret cut out of it. */
export function withoutHidden(value: string): string {
  return value.normalize('NFKC').replace(INVISIBLE_NOT_MARKS, '').replace(MARK_AFTER_ASCII, '$1');
}

/**
 * Runs `scrub` over `value` as it reads, so a token split by characters that show nothing is found
 * by patterns that know nothing of them. When nothing is found, the text comes back exactly as it
 * was written (an emoji joined by a zero-width joiner, a Hindi sentence); when something is, the
 * text comes back with the invisible characters gone, and the marks of other scripts kept where
 * the secret allowed.
 */
export function scrubReading(value: string, scrub: (text: string) => string): string {
  const shown = withoutHidden(value);
  const scrubbedShown = scrub(shown);
  if (scrubbedShown !== shown) return scrubbedShown;
  const plain = withoutInvisible(value);
  if (plain !== shown) {
    const scrubbedPlain = scrub(plain);
    if (scrubbedPlain !== plain) return scrubbedPlain;
  }
  return scrub(value);
}

/**
 * Text as clients see it when only the secrets must go. Invisible and compatibility characters
 * are read away first, so one cannot split a token past the patterns; text with nothing in it
 * comes back untouched, so an emoji joined by a zero-width joiner survives.
 */
export function scrubSecretText(value: string): string {
  return scrubReading(value, scrubSecretShapes);
}

/**
 * Whether anything in a value is a secret: every string in it and every key, read as it is and
 * read without invisible characters, and fields that are secrets by their name or by the field
 * beside them. The value is walked as it is, never written out as one text first, so what was
 * escaped by being nested is found where it sits.
 */
export function containsSecret(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') {
    return scrubReading(value, scrubSecretShapes) !== value;
  }
  if (depth > 12 || typeof value !== 'object' || value === null) return false;
  if (JSON.stringify(scrubSecretFields(value)) !== JSON.stringify(value)) return true;
  const items = Array.isArray(value) ? value : [...Object.keys(value), ...Object.values(value)];
  return items.some((item) => containsSecret(item, depth + 1));
}

const SECRET_KEY = new RegExp(`^(?:${SECRET_FIELD})$`, 'iu');

const CREDENTIAL_SCHEME = new RegExp(`^(?:${SCHEMES})$`, 'iu');
const CREDENTIAL_KEY = new RegExp(`^(?:${CREDENTIAL_KEYS})$`, 'iu');

/**
 * The keys of an object whose value is a secret because of another field beside it, which the
 * keys alone do not say: `{scheme: 'Basic', value}`, `{name: 'Authorization', value}`. Walking an
 * object field by field loses that link, and the base64 of a Basic credential has no shape.
 */
export function linkedSecretKeys(record: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue;
    if (/^(?:scheme|type)$/iu.test(name) && CREDENTIAL_SCHEME.test(value)) {
      for (const other of Object.keys(record)) if (CREDENTIAL_KEY.test(other)) keys.add(other);
    }
    if (/^(?:name|key|header)$/iu.test(name) && SECRET_KEY.test(value)) keys.add('value');
  }
  return keys;
}

/** The same for an array that is one header written as a pair: `['Authorization', value]`. */
export function linkedSecretPair(items: readonly unknown[]): boolean {
  const [name] = items;
  return items.length >= 2 && typeof name === 'string' && SECRET_KEY.test(name);
}

/**
 * A value as clients see it, field by field before it is written out: a field with a secret name
 * loses its whole value, and every string goes through `scrubSecretShapes`.
 */
export function scrubSecretFields(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubSecretShapes(value);
  if (depth > 12 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    const pair = linkedSecretPair(value);
    return value.map((item, index) =>
      pair && index > 0 && item !== null && item !== undefined
        ? '[secret]'
        : scrubSecretFields(item, depth + 1),
    );
  }
  const linked = linkedSecretKeys(value as Record<string, unknown>);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (SECRET_KEY.test(key) || linked.has(key)) && item !== null && item !== undefined
        ? '[secret]'
        : scrubSecretFields(item, depth + 1),
    ]),
  );
}
