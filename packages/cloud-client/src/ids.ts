/**
 * An id for a request that must be the same on a retry (a message, an answer). It only has to be
 * unique, not secret. Browsers and Node have `crypto.randomUUID`; React Native's JS engine does not
 * always, so there is a fallback built on `getRandomValues`, and last of all on `Math.random`.
 */
export function randomId(): string {
  const source = (
    globalThis as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (bytes: Uint8Array) => unknown };
    }
  ).crypto;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
