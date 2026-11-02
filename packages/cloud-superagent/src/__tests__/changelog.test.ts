import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const CHANGELOG = 'docs/superagent/CHANGELOG.md';
const HEADING_RE = /^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (M[SD]T) — \S+(?: — ([0-9a-f]{7,40})\b)?/;
const FIVE_MINUTES_MS = 5 * 60_000;

function lines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
}

function touchesSuperagent(files: readonly string[]): boolean {
  return files.some((file) => file.startsWith('packages/cloud-superagent/'));
}

async function mergeBase(): Promise<string> {
  try {
    const merged = await run('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: ROOT });
    return merged.stdout.trim() || 'origin/main';
  } catch {
    const merged = await run('git', ['merge-base', 'main', 'HEAD'], { cwd: ROOT });
    return merged.stdout.trim() || 'main';
  }
}

async function filesOf(rev: string): Promise<string[]> {
  const { stdout } = await run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', rev], {
    cwd: ROOT,
  });
  return lines(stdout);
}

test('a Super-agent code change on this branch also updates CHANGELOG.md', async () => {
  const base = await mergeBase();
  const { stdout } = await run('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: ROOT });
  const files = lines(stdout);
  if (!touchesSuperagent(files)) return;
  assert.equal(
    files.includes(CHANGELOG),
    true,
    'packages/cloud-superagent changed without docs/superagent/CHANGELOG.md in the same branch diff',
  );
});

test('after CHANGELOG exists, each Super-agent commit updates it in the same commit', async () => {
  const base = await mergeBase();
  const { stdout } = await run('git', ['log', '--format=%H', '--reverse', `${base}..HEAD`], {
    cwd: ROOT,
  });
  const commits = lines(stdout);
  let required = false;
  for (const sha of commits) {
    const files = await filesOf(sha);
    if (files.includes(CHANGELOG)) required = true;
    if (!required) continue;
    if (!touchesSuperagent(files)) continue;
    assert.equal(
      files.includes(CHANGELOG),
      true,
      `${sha.slice(0, 10)} changes packages/cloud-superagent without ${CHANGELOG} in the same commit`,
    );
  }
});

function headingMs(date: string, time: string, zone: string): number {
  const offset = zone === 'MDT' ? '-06:00' : '-07:00';
  return Date.parse(`${date}T${time}:00${offset}`);
}

test('each CHANGELOG heading time matches its first SHA committer date within 5 minutes', async () => {
  const text = await readFile(resolve(ROOT, CHANGELOG), 'utf8');
  const headings = text.split('\n').filter((line) => line.startsWith('## '));
  assert.ok(headings.length > 0, 'CHANGELOG has no headings');
  for (const [index, line] of headings.entries()) {
    const match = HEADING_RE.exec(line);
    assert.ok(match, `heading must be '## YYYY-MM-DD HH:MM M[SD]T — branch — sha': ${line}`);
    const [, date, time, zone, sha] = match;
    if (!sha) {
      assert.equal(index, 0, `only the newest unpublished entry may omit a sha: ${line}`);
      continue;
    }
    const { stdout } = await run('git', ['show', '-s', '--format=%cI', sha], { cwd: ROOT });
    const committed = Date.parse(stdout.trim());
    assert.equal(Number.isNaN(committed), false, `${sha} has no committer date`);
    const stamped = headingMs(date as string, time as string, zone as string);
    const delta = Math.abs(stamped - committed);
    assert.ok(
      delta <= FIVE_MINUTES_MS,
      `${line} is ${Math.round(delta / 1000)}s from git show -s --format=%cI ${sha} (${stdout.trim()})`,
    );
  }
});

test('uncommitted Super-agent edits also change CHANGELOG.md', async () => {
  const { stdout } = await run('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT });
  const files = lines(stdout);
  if (!touchesSuperagent(files)) return;
  assert.equal(
    files.includes(CHANGELOG),
    true,
    'uncommitted packages/cloud-superagent changes must update docs/superagent/CHANGELOG.md in the same work',
  );
});
