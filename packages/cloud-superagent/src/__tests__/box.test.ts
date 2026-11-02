import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BOX_REPO,
  BoxWorkspace,
  applyBoxPatch,
  assertSafeCloneTarget,
  isPublicCloneUrl,
} from '../loop-box.js';
import { ADD_BROKEN, ADD_FIXED, scratchFiles } from '../loop.js';
import { FakeSandbox } from '../sandbox.js';
import { initLocalRepo } from '../workspace.js';

test('public clone URLs refuse credentials', () => {
  assert.equal(isPublicCloneUrl('https://github.com/acme/app.git'), true);
  assert.equal(isPublicCloneUrl('https://user:token@github.com/acme/app.git'), false);
  assert.throws(() => assertSafeCloneTarget('https://x:y@github.com/acme/app.git'), /credentials/);
  assert.equal(assertSafeCloneTarget('/tmp/repo'), '/tmp/repo');
});

test('FakeSandbox materialize uploads a tarball, applies edits, and runs tests in the box', async () => {
  const hostDir = await initLocalRepo(scratchFiles());
  const sandbox = new FakeSandbox();
  const box = new BoxWorkspace(sandbox, 'loop');
  const kind = await box.materialize({ hostDir });
  assert.equal(kind, 'upload');
  await box.writeFiles({ 'add.js': ADD_FIXED });
  const tested = await box.run('node add.test.js');
  assert.equal(tested.exitCode, 0, tested.stderr || tested.stdout);
  const patch = await box.pullPatch();
  assert.match(patch, /add\.js/);
  assert.ok(sandbox.commands.some((row) => row.cmd.includes('src.tgz')));
  assert.ok(sandbox.commands.some((row) => row.cmd.includes('tar -xzf')));
  assert.ok(sandbox.commands.some((row) => row.cmd === 'node add.test.js'));
  const root = sandbox.roots.get('loop');
  assert.ok(root);
  assert.equal(await readFile(join(root, BOX_REPO, 'add.js'), 'utf8'), ADD_FIXED);
});

test('FakeSandbox clones a local path inside the box with no host token on argv', async () => {
  const hostDir = await initLocalRepo(scratchFiles(false));
  const sandbox = new FakeSandbox();
  const box = new BoxWorkspace(sandbox, 'clone');
  const kind = await box.materialize({ clone: hostDir });
  assert.equal(kind, 'clone');
  const tested = await box.run('node add.test.js');
  assert.equal(tested.exitCode, 0, tested.stderr || tested.stdout);
  assert.ok(sandbox.commands.some((row) => row.cmd.includes('git clone')));
  assert.ok(sandbox.commands.every((row) => !/github_pat_|INSTABOX|ANTHROPIC/.test(row.cmd)));
});

test('applyBoxPatch writes the box cached diff onto a clean checkout, including extra box files', async () => {
  const source = await initLocalRepo(scratchFiles());
  const publish = await initLocalRepo(scratchFiles());
  const sandbox = new FakeSandbox();
  const box = new BoxWorkspace(sandbox, 'patch');
  await box.materialize({ hostDir: source });
  await box.writeFiles({ 'add.js': ADD_FIXED, 'note.txt': 'from-box\n' });
  const tested = await box.run('node add.test.js');
  assert.equal(tested.exitCode, 0, tested.stderr || tested.stdout);
  const patch = await box.pullPatch();
  assert.match(patch, /add\.js/);
  assert.match(patch, /note\.txt/);
  assert.equal(await readFile(join(publish, 'add.js'), 'utf8'), ADD_BROKEN);
  await applyBoxPatch(publish, patch);
  assert.equal(await readFile(join(publish, 'add.js'), 'utf8'), ADD_FIXED);
  assert.equal(await readFile(join(publish, 'note.txt'), 'utf8'), 'from-box\n');
  assert.ok(box.execs.every((row) => typeof row.exitCode === 'number'));
  assert.ok(box.execs.some((row) => row.cmd === 'node add.test.js' && row.exitCode === 0));
});
