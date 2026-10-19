/** Single-quotes a value for bash. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;

/** Ids end up in sandbox paths, so only plain names pass. */
export function assertSafeId(kind: string, value: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Unsafe ${kind}: ${JSON.stringify(value)}`);
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
