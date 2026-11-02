import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

test('a Super-agent code change on this branch also updates CHANGELOG.md', async () => {
  let base = 'origin/main';
  try {
    const merged = await run('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: ROOT });
    base = merged.stdout.trim() || 'origin/main';
  } catch {
    const merged = await run('git', ['merge-base', 'main', 'HEAD'], { cwd: ROOT });
    base = merged.stdout.trim() || 'main';
  }
  const { stdout } = await run('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: ROOT });
  const files = stdout
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  const codeChanged = files.some((file) => file.startsWith('packages/cloud-superagent/'));
  if (!codeChanged) return;
  assert.equal(
    files.includes('docs/superagent/CHANGELOG.md'),
    true,
    'packages/cloud-superagent changed without docs/superagent/CHANGELOG.md in the same branch diff',
  );
});
