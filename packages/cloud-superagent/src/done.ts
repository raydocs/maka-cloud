import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const DONE_KINDS = ['merged', 'closed', 'published', 'command', 'file', 'url'] as const;
export type DoneKind = (typeof DONE_KINDS)[number];

export type DoneSignal =
  | { kind: 'merged'; repo: string; number: number }
  | { kind: 'closed'; repo: string; number: number }
  | { kind: 'published'; package: string; version: string }
  | { kind: 'command'; argv: readonly string[]; stdout?: string }
  | { kind: 'file'; path: string; sha256?: string; jsonPath?: string; jsonEquals?: unknown }
  | { kind: 'url'; href: string; status?: number; body?: string };

export interface DoneClaim {
  signals: DoneSignal[];
  evidence: string;
  workspaceDir?: string;
}

export interface DoneCheck {
  signal: DoneSignal;
  ok: boolean;
  detail: string;
}

export interface DoneWorld {
  pull?(repo: string, number: number): Promise<{ merged: boolean; mergeSha?: string }>;
  issue?(repo: string, number: number): Promise<{ closed: boolean }>;
  published?(pkg: string, version: string): Promise<boolean>;
  command?(argv: readonly string[], cwd?: string): Promise<{ code: number; stdout: string }>;
  readFile?(path: string): Promise<{ exists: boolean; sha256?: string; json?: unknown }>;
  fetch?(href: string): Promise<{ status: number; body: string }>;
  unpushed?(dir: string): Promise<string[]>;
}

export async function verifyDone(
  claim: DoneClaim,
  world: DoneWorld,
): Promise<{ ok: boolean; checks: DoneCheck[]; reasons: string[] }> {
  if (!claim.signals.length) {
    return { ok: false, checks: [], reasons: ['empty Done claim'] };
  }
  if (!claim.evidence.trim()) {
    return { ok: false, checks: [], reasons: ['Done claim needs evidence'] };
  }
  const checks: DoneCheck[] = [];
  for (const signal of claim.signals) {
    checks.push(await checkSignal(signal, world, claim.workspaceDir));
  }
  const reasons = checks.filter((row) => !row.ok).map((row) => row.detail);
  if (claim.workspaceDir && world.unpushed) {
    reasons.push(...(await world.unpushed(claim.workspaceDir)));
  }
  return { ok: reasons.length === 0, checks, reasons };
}

export async function checkSignal(
  signal: DoneSignal,
  world: DoneWorld,
  cwd?: string,
): Promise<DoneCheck> {
  switch (signal.kind) {
    case 'merged': {
      const pull = await world.pull?.(signal.repo, signal.number);
      if (!pull)
        return {
          signal,
          ok: false,
          detail: `merged ${signal.repo}#${signal.number}: no live reader`,
        };
      const ok = pull.merged && Boolean(pull.mergeSha);
      return {
        signal,
        ok,
        detail: ok
          ? `MERGED ${pull.mergeSha?.slice(0, 10)}`
          : `merged ${signal.repo}#${signal.number} is not merged`,
      };
    }
    case 'closed': {
      const issue = await world.issue?.(signal.repo, signal.number);
      if (!issue)
        return {
          signal,
          ok: false,
          detail: `closed ${signal.repo}#${signal.number}: no live reader`,
        };
      return {
        signal,
        ok: issue.closed,
        detail: issue.closed
          ? `CLOSED ${signal.repo}#${signal.number}`
          : `closed ${signal.repo}#${signal.number} is still open`,
      };
    }
    case 'published': {
      const ok = (await world.published?.(signal.package, signal.version)) === true;
      return {
        signal,
        ok,
        detail: ok
          ? `published ${signal.package}@${signal.version}`
          : `published ${signal.package}@${signal.version} not on the registry`,
      };
    }
    case 'command': {
      const ran = await world.command?.(signal.argv, cwd);
      if (!ran) return { signal, ok: false, detail: 'command: no runner' };
      if (ran.code !== 0) {
        return { signal, ok: false, detail: `command exit ${ran.code}` };
      }
      if (signal.stdout && !new RegExp(signal.stdout).test(ran.stdout)) {
        return { signal, ok: false, detail: `command stdout does not match /${signal.stdout}/` };
      }
      return { signal, ok: true, detail: 'command exit 0' };
    }
    case 'file': {
      const file = await world.readFile?.(signal.path);
      if (!file?.exists) return { signal, ok: false, detail: `file missing: ${signal.path}` };
      if (signal.sha256 && file.sha256 !== signal.sha256) {
        return { signal, ok: false, detail: `file sha256 mismatch: ${signal.path}` };
      }
      if (signal.jsonPath) {
        const got = dig(file.json, signal.jsonPath);
        if (JSON.stringify(got) !== JSON.stringify(signal.jsonEquals)) {
          return { signal, ok: false, detail: `file json ${signal.jsonPath} mismatch` };
        }
      }
      return { signal, ok: true, detail: `file present: ${signal.path}` };
    }
    case 'url': {
      const res = await world.fetch?.(signal.href);
      if (!res) return { signal, ok: false, detail: `url: no fetcher` };
      const want = signal.status ?? 200;
      if (res.status !== want) {
        return { signal, ok: false, detail: `url status ${res.status}, want ${want}` };
      }
      if (signal.body && !new RegExp(signal.body).test(res.body)) {
        return { signal, ok: false, detail: `url body does not match /${signal.body}/` };
      }
      return { signal, ok: true, detail: `url status ${res.status}` };
    }
  }
}

/** Filesystem readers only. Hosts inject pull/issue/published/command/fetch. */
export function defaultDoneWorld(overrides: DoneWorld = {}): DoneWorld {
  return {
    unpushed: gitUnpushed,
    readFile: readDoneFile,
    ...overrides,
  };
}

export async function gitUnpushed(dir: string): Promise<string[]> {
  try {
    const dirty = await run('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no']);
    const ahead = await run('git', [
      '-C',
      dir,
      'rev-list',
      '--count',
      'HEAD',
      '--not',
      '--remotes',
    ]);
    if (dirty.stdout.trim() || Number(ahead.stdout.trim()) > 0) {
      return [`unpushed work in ${dir}`];
    }
    return [];
  } catch {
    return [`unpushed work in ${dir} (git state unreadable)`];
  }
}

export async function readDoneFile(path: string): Promise<{
  exists: boolean;
  sha256?: string;
  json?: unknown;
}> {
  try {
    await stat(path);
  } catch {
    return { exists: false };
  }
  const buf = await readFile(path);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  let json: unknown;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = undefined;
  }
  return { exists: true, sha256, json };
}

function dig(value: unknown, path: string): unknown {
  const parts = path.replace(/^\./, '').split('.').filter(Boolean);
  let cur = value;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
