import { createHash } from 'node:crypto';

/** sha256 of a value serialized with sorted keys, so equal states hash equally. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
