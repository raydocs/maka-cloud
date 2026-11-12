import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizedEvent } from './types.js';

const run = promisify(execFile);

/**
 * Cheap read-only checks the Router can run instead of guessing.
 * Never writes, never pushes, never sees a secret.
 */
export interface RouterInspect {
  gitLog(input: { repoDir?: string; n?: number }): Promise<string>;
  ciStatus(input: { repo: string; ref?: string }): Promise<string>;
}

export class FakeRouterInspect implements RouterInspect {
  constructor(
    public gitLogText = 'abc123 fix login\ndef456 init',
    public ciText = 'CI: success',
  ) {}

  async gitLog(): Promise<string> {
    return this.gitLogText;
  }

  async ciStatus(): Promise<string> {
    return this.ciText;
  }
}

/** Local `git log` plus an optional CI URL the owner already knows. */
export class LocalRouterInspect implements RouterInspect {
  constructor(private readonly ci?: (repo: string, ref: string) => string) {}

  async gitLog(input: { repoDir?: string; n?: number }): Promise<string> {
    const dir = input.repoDir;
    if (!dir) return '';
    const { stdout } = await run('git', [
      '-C',
      dir,
      'log',
      '-n',
      String(input.n ?? 5),
      '--oneline',
    ]);
    return stdout.trim();
  }

  async ciStatus(input: { repo: string; ref?: string }): Promise<string> {
    const ref = input.ref ?? 'HEAD';
    const url = this.ci?.(input.repo, ref);
    return url ?? `CI for ${input.repo}@${ref} (no status API wired; read-only).`;
  }
}

export async function inspectNotes(
  inspect: RouterInspect | undefined,
  event: NormalizedEvent,
): Promise<string> {
  if (!inspect) return '';
  const repo = event.subject?.repo ?? '';
  const [log, ci] = await Promise.all([
    inspect.gitLog({ n: 5 }).catch(() => ''),
    repo ? inspect.ciStatus({ repo, ref: event.subject?.branch }).catch(() => '') : '',
  ]);
  const parts = [log && `git_log=${log}`, ci && `ci=${ci}`].filter(Boolean);
  return parts.join('\n');
}
