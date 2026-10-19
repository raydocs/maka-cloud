import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PATCH_LIMITS, cloneAt, collectPatch } from '../sandbox-ops.js';
import { BASE_SHA, FakeSandbox, changesOutput } from './fakes.js';

async function collect(
  options: ConstructorParameters<typeof FakeSandbox>[0],
  limits = DEFAULT_PATCH_LIMITS,
) {
  const sandbox = new FakeSandbox(options);
  const ws = await sandbox.open();
  return collectPatch(ws, BASE_SHA, limits, new AbortController().signal);
}

test('a change is read as a patch with its file list and a checksum', async () => {
  const patch = 'x'.repeat(500_000);
  const result = await collect({
    log: [],
    patch,
    files: [{ path: 'a/b.py' }, { path: 'c.py', status: 'D' }],
  });
  assert.ok(!('reason' in result));
  assert.equal(result.patch, patch, 'chunks are put back together');
  assert.deepEqual(result.files, ['a/b.py', 'c.py']);
});

test('refused: symlinks, submodules, odd modes, unsafe paths, empty and oversized changes', async () => {
  const cases: [Parameters<typeof collect>[0], RegExp][] = [
    [{ log: [], files: [{ path: 'l', mode: '120000' }] }, /symlink/u],
    [{ log: [], files: [{ path: 's', mode: '160000' }] }, /nested repository/u],
    [{ log: [], files: [{ path: 'p', mode: '100664' }] }, /unsupported file mode/u],
    [{ log: [], files: [{ path: '../escape' }] }, /unsafe path/u],
    [{ log: [], files: [{ path: '.git/hooks/pre-commit' }] }, /unsafe path/u],
    [{ log: [], files: [] }, /no change/u],
    [
      { log: [], files: [{ path: 'big', size: DEFAULT_PATCH_LIMITS.maxFileBytes + 1 }] },
      /more than/u,
    ],
    [{ log: [], files: Array.from({ length: 301 }, (_, i) => ({ path: `f${i}` })) }, /301 files/u],
    [{ log: [], changesStdout: 'ERR add fatal' }, /git could not list/u],
    [{ log: [], changesStdout: changesOutput([{ path: 'a' }], 2 * 1024 * 1024) }, /patch is/u],
  ];
  for (const [options, reason] of cases) {
    const result = await collect(options);
    assert.ok('reason' in result, String(reason));
    assert.match(result.reason, reason);
  }
});

test('a deleted symlink is fine: only what remains is checked', async () => {
  const result = await collect({ log: [], files: [{ path: 'gone', mode: '000000', status: 'D' }] });
  assert.ok(!('reason' in result));
});

test('a clone answers with the full sha, or the reason it failed', async () => {
  const ok = await new FakeSandbox({ log: [] }).open();
  assert.equal(
    await cloneAt(ok, 'https://example/r.git', 'main', new AbortController().signal),
    BASE_SHA,
  );
  const bad = await new FakeSandbox({ log: [], cloneStdout: 'CLONE_FAILED\nnot found' }).open();
  await assert.rejects(
    cloneAt(bad, 'https://example/r.git', 'main', new AbortController().signal),
    /not found/u,
  );
});
