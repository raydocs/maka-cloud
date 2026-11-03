import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';
import { type CommandRunner, LayeredStore } from '../layered-workspace.js';
import {
  createWorkspaceStore,
  GitCloneStore,
  initLocalRepo,
  workspaceModeFromEnv,
} from '../workspace.js';

const run = promisify(execFile);

const SPEC_BASE = { tenantId: 't', repoUrl: '' };

async function fixtureRepo(): Promise<string> {
  return initLocalRepo({
    'package.json': '{"name":"fixture"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'src/index.js': 'export const a = 1;\n',
    '.gitignore': 'node_modules/\n',
  });
}

/** Simulated install: writes a small node_modules, once per base build. */
const INSTALL = 'mkdir -p node_modules/dep && echo "dep v1" > node_modules/dep/index.js';

interface Counted {
  runner: CommandRunner;
  calls: Array<{ file: string; args: readonly string[] }>;
}

function countingRunner(): Counted {
  const calls: Counted['calls'] = [];
  const runner: CommandRunner = async (file, args, options) => {
    calls.push({ file, args });
    return run(file, [...args], { cwd: options?.cwd, maxBuffer: 64 * 1024 * 1024 });
  };
  return { runner, calls };
}

async function tempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-layered-test-'));
  t.after(async () => {
    // Tests that never release leave overlay mounts under the root.
    const mounts = await readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
    for (const line of mounts.split('\n')) {
      const mountPoint = line.split(' ')[4];
      if (mountPoint?.startsWith(root)) await run('umount', [mountPoint]).catch(() => {});
    }
    // Bases and layers are read-only: restore directory write bits first.
    await run('find', [root, '-type', 'd', '-exec', 'chmod', 'u+w', '{}', '+']).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('workspaceModeFromEnv defaults to clone and treats unknown values as clone', () => {
  assert.equal(workspaceModeFromEnv({}), 'clone');
  assert.equal(workspaceModeFromEnv({ MAKA_CLOUD_WORKSPACE: '' }), 'clone');
  assert.equal(workspaceModeFromEnv({ MAKA_CLOUD_WORKSPACE: 'clone' }), 'clone');
  assert.equal(workspaceModeFromEnv({ MAKA_CLOUD_WORKSPACE: 'worktree' }), 'clone');
  assert.equal(workspaceModeFromEnv({ MAKA_CLOUD_WORKSPACE: 'layered' }), 'layered');
  assert.equal(workspaceModeFromEnv({ MAKA_CLOUD_WORKSPACE: ' Layered ' }), 'layered');
});

test('createWorkspaceStore keeps clone as the default and layered only on request', async (t) => {
  assert.equal(createWorkspaceStore() instanceof GitCloneStore, true);
  assert.equal(createWorkspaceStore({ mode: 'clone' }) instanceof GitCloneStore, true);
  const root = await tempRoot(t);
  const layered = createWorkspaceStore({ mode: 'layered', root });
  assert.equal(layered instanceof LayeredStore, true);
  assert.equal(layered.kind, 'layered');
  assert.equal(createWorkspaceStore({ layerfs: true, mode: 'layered' }).kind, 'layerfs');
});

test('a second prepare on the same base neither fetches nor installs again', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const { runner, calls } = countingRunner();
  const store = new LayeredStore({ root, installCommand: INSTALL, overlay: 'off', runner });
  const spec = { ...SPEC_BASE, repoUrl: repo, workerId: 'a' };
  const first = await store.prepare(spec);
  const touchesRepo = () => calls.filter((c) => c.args.includes(repo) && c.args.includes('clone'));
  const installs = () => calls.filter((c) => c.file === 'sh');
  assert.equal(touchesRepo().length, 1);
  assert.equal(installs().length, 1);
  const second = await store.prepare({ ...spec, workerId: 'b' });
  assert.equal(touchesRepo().length, 1, 'no new clone of the repo');
  assert.equal(installs().length, 1, 'no new install');
  assert.equal(first.layer, 'clone-shared');
  assert.equal(
    await readFile(join(second.dir as string, 'node_modules/dep/index.js'), 'utf8'),
    'dep v1\n',
  );
  assert.equal(
    await readFile(join(second.dir as string, 'src/index.js'), 'utf8'),
    'export const a = 1;\n',
  );
});

test('concurrent prepares of one key build the base once', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const { runner, calls } = countingRunner();
  const store = new LayeredStore({ root, installCommand: INSTALL, overlay: 'off', runner });
  const spec = { ...SPEC_BASE, repoUrl: repo };
  const handles = await Promise.all(
    ['a', 'b', 'c', 'd'].map((workerId) => store.prepare({ ...spec, workerId })),
  );
  assert.equal(new Set(handles.map((h) => h.dir)).size, 4);
  assert.equal(calls.filter((c) => c.file === 'sh').length, 1);
  assert.equal(calls.filter((c) => c.args.includes(repo) && c.args.includes('clone')).length, 1);
});

test('a changed lockfile builds a new base', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const { runner, calls } = countingRunner();
  const store = new LayeredStore({ root, installCommand: INSTALL, overlay: 'off', runner });
  const spec = { ...SPEC_BASE, repoUrl: repo, workerId: 'a' };
  const one = await store.ensureBase(spec);
  assert.equal(await store.ensureBase(spec), one);
  await writeFile(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  await run('git', ['-C', repo, 'commit', '-qam', 'bump lockfile']);
  const two = await store.ensureBase(spec);
  assert.notEqual(two, one);
  assert.equal(calls.filter((c) => c.file === 'sh').length, 2);
});

test('the base is read-only after build (except under user-mode fuse)', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const store = new LayeredStore({ root, installCommand: INSTALL, overlay: 'off' });
  const base = await store.ensureBase({ repoUrl: repo });
  for (const file of ['package.json', 'node_modules/dep/index.js', '.git/HEAD']) {
    assert.equal(((await stat(join(base, file))).mode & 0o222) === 0, true, `${file} is read-only`);
  }
});

test('two layers on one base do not see each other, and the base stays clean', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const store = new LayeredStore({ root, installCommand: INSTALL });
  const spec = { ...SPEC_BASE, repoUrl: repo };
  const a = await store.prepare({ ...spec, workerId: 'a' });
  const b = await store.prepare({ ...spec, workerId: 'b' });
  const base = await store.ensureBase(spec);
  const dirA = a.dir as string;
  const dirB = b.dir as string;
  await writeFile(join(dirA, 'src/index.js'), 'export const a = 2;\n');
  await writeFile(join(dirA, 'only-a.txt'), 'a\n');
  assert.equal(await readFile(join(dirB, 'src/index.js'), 'utf8'), 'export const a = 1;\n');
  await assert.rejects(stat(join(dirB, 'only-a.txt')));
  assert.equal(await readFile(join(base, 'src/index.js'), 'utf8'), 'export const a = 1;\n');
  const branches = await Promise.all(
    [dirA, dirB].map((dir) => run('git', ['-C', dir, 'branch', '--show-current'])),
  );
  assert.deepEqual(
    branches.map((r) => r.stdout.trim()),
    ['worker/a', 'worker/b'],
  );
});

test('an in-place write to a hard-linked dependency does not reach the base', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const store = new LayeredStore({ root, installCommand: INSTALL, overlay: 'off' });
  const handle = await store.prepare({ ...SPEC_BASE, repoUrl: repo, workerId: 'a' });
  const base = await store.ensureBase({ repoUrl: repo });
  const dep = join(handle.dir as string, 'node_modules/dep/index.js');
  // Replacing the file (unlink + create, as npm does) is always safe.
  await rm(dep);
  await writeFile(dep, 'dep v2\n');
  assert.equal(await readFile(join(base, 'node_modules/dep/index.js'), 'utf8'), 'dep v1\n');
  // New files in a copied dependency directory work.
  await writeFile(join(handle.dir as string, 'node_modules/dep/extra.js'), 'x\n');
  await assert.rejects(stat(join(base, 'node_modules/dep/extra.js')));
});

test('snapshot then restore returns a clone-shared layer to the snapshot', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const store = new LayeredStore({ root, installCommand: INSTALL, overlay: 'off' });
  const handle = await store.prepare({ ...SPEC_BASE, repoUrl: repo, workerId: 'a' });
  const dir = handle.dir as string;
  await writeFile(join(dir, 'phase1.txt'), 'one\n');
  const snap = await store.snapshot(handle);
  await writeFile(join(dir, 'phase1.txt'), 'two\n');
  await writeFile(join(dir, 'phase2.txt'), 'later\n');
  await store.restore(handle, snap);
  assert.equal(await readFile(join(dir, 'phase1.txt'), 'utf8'), 'one\n');
  await assert.rejects(stat(join(dir, 'phase2.txt')));
  const patch = await store.exportPatch(handle);
  assert.equal(patch.includes('phase1.txt'), true);
  assert.equal(patch.includes('phase2.txt'), false);
  // dependencies are not part of snapshots or patches
  assert.equal(patch.includes('node_modules'), false);
  assert.equal(await readFile(join(dir, 'node_modules/dep/index.js'), 'utf8'), 'dep v1\n');
});

test('exportPatch shows only the layer own change, including new files', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const store = new LayeredStore({ root, installCommand: INSTALL });
  const spec = { ...SPEC_BASE, repoUrl: repo };
  const a = await store.prepare({ ...spec, workerId: 'a' });
  const b = await store.prepare({ ...spec, workerId: 'b' });
  await writeFile(join(a.dir as string, 'src/index.js'), 'export const a = 3;\n');
  await writeFile(join(a.dir as string, 'new.txt'), 'new\n');
  const patch = await store.exportPatch(a);
  assert.equal(patch.includes('+export const a = 3;'), true);
  assert.equal(patch.includes('new.txt'), true);
  assert.equal(patch.includes('node_modules'), false);
  assert.equal(await store.exportPatch(b), '');
});

test('release removes the layer and keeps the base', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const { runner, calls } = countingRunner();
  const store = new LayeredStore({ root, installCommand: INSTALL, runner });
  const spec = { ...SPEC_BASE, repoUrl: repo, workerId: 'a' };
  const handle = await store.prepare(spec);
  await store.snapshot(handle);
  const base = await store.ensureBase(spec);
  await store.release(handle);
  await assert.rejects(stat(handle.dir as string));
  await assert.rejects(stat(join(root, 'layers', handle.id.replace(/[^A-Za-z0-9._-]/g, '_'))));
  assert.equal(await readFile(join(base, 'node_modules/dep/index.js'), 'utf8'), 'dep v1\n');
  // the next prepare reuses the base without installing again
  await store.prepare({ ...spec, workerId: 'b' });
  assert.equal(calls.filter((c) => c.file === 'sh').length, 1);
});

test('overlay mode: layers are overlay mounts that isolate writes', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const store = new LayeredStore({ root, installCommand: INSTALL });
  if (!(await store.overlayUsable())) {
    t.skip(
      'overlay is not usable here (needs Linux plus root or fuse-overlayfs, and mount rights)',
    );
    return;
  }
  const spec = { ...SPEC_BASE, repoUrl: repo };
  const a = await store.prepare({ ...spec, workerId: 'a' });
  const b = await store.prepare({ ...spec, workerId: 'b' });
  assert.equal(a.layer, 'overlay');
  await mkdir(join(a.dir as string, 'sub'), { recursive: true });
  await writeFile(join(a.dir as string, 'sub/only-a.txt'), 'a\n');
  await writeFile(join(a.dir as string, 'src/index.js'), 'export const a = 9;\n');
  await assert.rejects(stat(join(b.dir as string, 'sub/only-a.txt')));
  assert.equal(
    await readFile(join(b.dir as string, 'src/index.js'), 'utf8'),
    'export const a = 1;\n',
  );
  const base = await store.ensureBase(spec);
  assert.equal(await readFile(join(base, 'src/index.js'), 'utf8'), 'export const a = 1;\n');
  await store.release(a);
  await store.release(b);
  assert.equal(await readFile(join(base, 'src/index.js'), 'utf8'), 'export const a = 1;\n');
});

test('overlay mode: snapshot and restore the upper layer', async (t) => {
  const repo = await fixtureRepo();
  const root = await tempRoot(t);
  const store = new LayeredStore({ root, installCommand: INSTALL });
  if (!(await store.overlayUsable())) {
    t.skip(
      'overlay is not usable here (needs Linux plus root or fuse-overlayfs, and mount rights)',
    );
    return;
  }
  const handle = await store.prepare({ ...SPEC_BASE, repoUrl: repo, workerId: 'a' });
  const dir = handle.dir as string;
  await writeFile(join(dir, 'phase1.txt'), 'one\n');
  const snap = await store.snapshot(handle);
  await writeFile(join(dir, 'phase1.txt'), 'two\n');
  await writeFile(join(dir, 'phase2.txt'), 'later\n');
  await store.restore(handle, snap);
  assert.equal(await readFile(join(dir, 'phase1.txt'), 'utf8'), 'one\n');
  await assert.rejects(stat(join(dir, 'phase2.txt')));
  await store.release(handle);
});
