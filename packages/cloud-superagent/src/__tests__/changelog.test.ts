import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const CHANGELOG = 'docs/superagent/CHANGELOG.md';

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
