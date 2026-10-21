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

/** `text` with every secret-shaped run replaced by `[secret]`. */
export function scrubSecretShapes(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, (match, name: unknown) =>
      typeof name === 'string' ? `${name}[secret]` : '[secret]',
    );
  }
  return out;
}
