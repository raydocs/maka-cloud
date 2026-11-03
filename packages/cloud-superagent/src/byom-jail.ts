import { isAbsolute, relative, resolve, sep } from 'node:path';

export class JailError extends Error {
  readonly reason = 'jail' as const;

  constructor(message: string) {
    super(message);
    this.name = 'JailError';
  }
}

/** Resolve `target` inside `root`. Rejects `..` escapes and NUL. */
export function jailPath(root: string, target: string): string {
  if (target.includes('\0')) throw new JailError('path contains NUL');
  const resolvedRoot = resolve(root);
  const resolved = isAbsolute(target) ? resolve(target) : resolve(resolvedRoot, target);
  const rel = relative(resolvedRoot, resolved);
  if (rel === '') return resolvedRoot;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new JailError(`path escapes workspace root: ${target}`);
  }
  if (rel.split(sep).includes('..')) {
    throw new JailError(`path escapes workspace root: ${target}`);
  }
  return resolved;
}

export function assertInsideRoot(root: string, target: string): string {
  return jailPath(root, target);
}
