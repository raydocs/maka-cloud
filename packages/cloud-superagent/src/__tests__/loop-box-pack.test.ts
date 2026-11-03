import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { packTar } from '../loop-box.js';

const run = promisify(execFile);

test('packTar never ships AppleDouble ._ files, even for files with extended attributes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pack-'));
  await writeFile(join(dir, 'add.js'), 'x\n');
  // macOS: give the file extended attributes, as downloaded or sandbox-made files have.
  await run('xattr', ['-w', 'user.test', 'x', join(dir, 'add.js')]).catch(() => undefined);
  // Raw archive bytes: macOS `tar -t` folds AppleDouble entries back into metadata.
  const raw = gunzipSync(await packTar(dir)).toString('latin1');
  assert.ok(raw.includes('add.js'));
  assert.equal(raw.includes('._add.js'), false, 'AppleDouble entry in the archive');
  assert.equal(raw.includes('LIBARCHIVE.xattr'), false, 'xattr PAX header in the archive');
});
