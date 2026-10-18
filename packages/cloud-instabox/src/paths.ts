/** POSIX path helpers. Sandbox paths are always POSIX, whatever the host running Maka is. */

export function isPosixAbsolute(path: string): boolean {
  return path.startsWith('/');
}

/** True when `candidate` is `root` or below it. Both must be canonical. */
export function isInsidePosix(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return candidate.startsWith(prefix);
}

/** Same message and `EACCES` code as the local executor's containment failure. */
export function containmentError(root: string, inputPath: string, resolved: string, label: string) {
  return Object.assign(
    new Error(
      `${label} path must stay inside session cwd ${JSON.stringify(root)}; ` +
        `received ${JSON.stringify(inputPath)}, which resolves to ${JSON.stringify(resolved)}.`,
    ),
    { code: 'EACCES' },
  );
}

const GLOB_MAGIC = /[*?[\]{}()!+@\\]/;

/** Leading directory segments of a pattern that contain no glob syntax. */
export function literalGlobPrefix(pattern: string): string {
  if (pattern.includes('{')) return '';
  const segments = pattern.split('/');
  const literal: string[] = [];
  // The last segment is the pattern's own name and may be a plain file name.
  for (const segment of segments.slice(0, -1)) {
    if (segment === '' || segment === '.' || GLOB_MAGIC.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/');
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
