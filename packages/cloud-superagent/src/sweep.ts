import type { GitHostPort } from './loop.js';

export const SWEEP_KINDS = ['duplicate', 'temp_patch', 'dead_code', 'changelog_docs'] as const;
export type SweepKind = (typeof SWEEP_KINDS)[number];

export interface SweepCommit {
  sha: string;
  title: string;
  files: string[];
  patch?: string;
  mergedAt: number;
}

export interface SweepFinding {
  kind: SweepKind;
  path: string;
  detail: string;
  sha?: string;
}

export interface SweepSource {
  listMergedSince(input: {
    tenantId: string;
    repo?: string;
    since: number;
  }): Promise<SweepCommit[]>;
}

export class FakeSweepSource implements SweepSource {
  commits: SweepCommit[] = [];

  async listMergedSince(input: {
    tenantId: string;
    repo?: string;
    since: number;
  }): Promise<SweepCommit[]> {
    void input.tenantId;
    void input.repo;
    return this.commits.filter((row) => row.mergedAt >= input.since).map((row) => ({ ...row }));
  }
}

export interface SweepSettings {
  enabled: boolean;
  source?: SweepSource;
  git?: GitHostPort;
  repo?: string;
  /** How far back to look. Default 7 days. */
  windowMs: number;
}

/**
 * Host-facing constructor helper. Does not read `process.env`.
 * `enabled` is true only when the host passes `true`.
 */
export function sweepSettingsFrom(
  input: {
    enabled?: boolean;
    source?: SweepSource;
    git?: GitHostPort;
    repo?: string;
    windowMs?: number;
  } = {},
): SweepSettings {
  return {
    enabled: input.enabled === true,
    source: input.source,
    git: input.git,
    repo: input.repo,
    windowMs: input.windowMs ?? 7 * 24 * 60 * 60_000,
  };
}

export const DEFAULT_SWEEP: SweepSettings = sweepSettingsFrom();

export interface SweepResult {
  skipped?: 'disabled' | 'no_source' | 'no_git' | 'no_findings';
  findings: SweepFinding[];
  pr?: { number: number; url: string; branch: string };
}

const FN_RE = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g;
const TEMP_RE = /\b(HACK|FIXME|XXX|TEMP|workaround|quick fix)\b/i;
const DEAD_RE = /\.(bak|old|orig)$|\/deprecated\/|^\s*\/\/\s*unused\b/im;
const DIARY_RE = /\b(today i|this week i|wip notes|scratch notes|what i did)\b/i;

export function analyzeSweep(commits: readonly SweepCommit[]): SweepFinding[] {
  const findings: SweepFinding[] = [];
  const names = new Map<string, string[]>();
  for (const commit of commits) {
    for (const file of commit.files) {
      const key = file.split('/').pop() ?? file;
      const list = names.get(key) ?? [];
      list.push(file);
      names.set(key, list);
    }
    const patch = commit.patch ?? '';
    for (const match of patch.matchAll(FN_RE)) {
      const name = match[1];
      if (!name) continue;
      const list = names.get(`fn:${name}`) ?? [];
      list.push(commit.sha);
      names.set(`fn:${name}`, list);
    }
    if (TEMP_RE.test(patch) || TEMP_RE.test(commit.title)) {
      findings.push({
        kind: 'temp_patch',
        path: commit.files[0] ?? commit.sha,
        detail: `Temporary patch in ${commit.sha.slice(0, 8)}: ${commit.title}`,
        sha: commit.sha,
      });
    }
    for (const file of commit.files) {
      if (DEAD_RE.test(file) || DEAD_RE.test(patch)) {
        findings.push({
          kind: 'dead_code',
          path: file,
          detail: `Unused or leftover path ${file} in ${commit.sha.slice(0, 8)}`,
          sha: commit.sha,
        });
      }
      if (/\.(md|txt)$/i.test(file) && (DIARY_RE.test(patch) || DIARY_RE.test(commit.title))) {
        findings.push({
          kind: 'changelog_docs',
          path: file,
          detail: `Diary-style doc ${file} in ${commit.sha.slice(0, 8)}`,
          sha: commit.sha,
        });
      }
    }
  }
  for (const [key, paths] of names) {
    const unique = [...new Set(paths)];
    if (unique.length < 2) continue;
    if (key.startsWith('fn:')) {
      findings.push({
        kind: 'duplicate',
        path: key.slice(3),
        detail: `Function ${key.slice(3)} landed more than once this week`,
      });
      continue;
    }
    if (unique.length >= 2) {
      findings.push({
        kind: 'duplicate',
        path: key,
        detail: `Same basename ${key} added in ${unique.join(', ')}`,
      });
    }
  }
  return dedupeFindings(findings);
}

export function sweepBranch(at: number): string {
  const week = Math.floor(at / (7 * 24 * 60 * 60_000));
  return `maka/sa-sweep-${week}`;
}

export function formatSweepPr(findings: readonly SweepFinding[]): { title: string; body: string } {
  const lines = [
    'Weekly sweep of merged work. Review and CI must pass before merge.',
    'This PR does not push to main. File deletes stay in this branch.',
    '',
    '### Findings',
  ];
  for (const row of findings) {
    lines.push(`- **${row.kind}** \`${row.path}\` — ${row.detail}`);
  }
  return {
    title: `chore: weekly sweep (${findings.length} findings)`,
    body: lines.join('\n'),
  };
}

export async function runSweep(input: {
  settings: SweepSettings;
  tenantId: string;
  repo?: string;
  since: number;
  at: number;
}): Promise<SweepResult> {
  if (!input.settings.enabled) return { skipped: 'disabled', findings: [] };
  if (!input.settings.source) return { skipped: 'no_source', findings: [] };
  const commits = await input.settings.source.listMergedSince({
    tenantId: input.tenantId,
    repo: input.repo ?? input.settings.repo,
    since: input.since,
  });
  const findings = analyzeSweep(commits);
  if (findings.length === 0) return { skipped: 'no_findings', findings: [] };
  const git = input.settings.git;
  const repo = input.repo ?? input.settings.repo;
  if (!git || !repo) return { skipped: 'no_git', findings };
  const branch = sweepBranch(input.at);
  const { title, body } = formatSweepPr(findings);
  const pr = await git.openOrUpdatePullRequest({
    repo,
    branch,
    base: 'main',
    title,
    body,
  });
  return { findings, pr: { number: pr.number, url: pr.url, branch } };
}

function dedupeFindings(rows: SweepFinding[]): SweepFinding[] {
  const seen = new Set<string>();
  const out: SweepFinding[] = [];
  for (const row of rows) {
    const key = `${row.kind}:${row.path}:${row.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
