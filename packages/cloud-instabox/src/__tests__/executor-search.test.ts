import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setup, type Harness } from './harness.js';

const hasRipgrep = (() => {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('InstaboxWorkspaceExecutor.globFiles', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    for (const [path, content] of Object.entries({
      'a.ts': '',
      'b.js': '',
      'src/c.ts': '',
      'src/deep/d.ts': '',
      'src/deep/e.md': '',
      '.hidden/f.ts': '',
      'node_modules/pkg/g.ts': '',
    })) {
      await fs.mkdir(join(h.work, path, '..'), { recursive: true });
      await fs.writeFile(join(h.work, path), content);
    }
    await fs.symlink(h.outside, join(h.work, 'link'));
    await fs.writeFile(join(h.outside, 'leak.ts'), '');
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const glob = (pattern: string, limit?: number) =>
    h.executor.globFiles({ cwd: h.work, pattern, ...(limit === undefined ? {} : { limit }) });

  it('matches like node-glob: ** crosses directories, * does not, dot directories are skipped', async () => {
    assert.deepEqual((await glob('**/*.ts')).files, [
      'a.ts',
      'node_modules/pkg/g.ts',
      'src/c.ts',
      'src/deep/d.ts',
    ]);
    assert.deepEqual((await glob('*.ts')).files, ['a.ts']);
    assert.deepEqual((await glob('src/*')).files, ['src/c.ts', 'src/deep']);
  });

  it('supports braces and returns directories that match', async () => {
    assert.deepEqual((await glob('src/deep/*.{ts,md}')).files, ['src/deep/d.ts', 'src/deep/e.md']);
  });

  it('does not follow symlinks out of the tree', async () => {
    const { files } = await glob('**/*.ts');
    assert.ok(!files.some((file) => file.includes('leak')));
  });

  it('limits the result and reports truncation only when more matched', async () => {
    const limited = await glob('**/*.ts', 2);
    assert.equal(limited.files.length, 2);
    assert.equal(limited.truncated, true);
    const exact = await glob('**/*.ts', 4);
    assert.equal(exact.files.length, 4);
    assert.equal(exact.truncated, false);
  });

  it('walks only the literal directory prefix of the pattern', async () => {
    await glob('src/deep/*.ts');
    const list = h.fake.execRequests.at(-1)?.body.envs;
    assert.equal(list.MAKA_SUB, 'src/deep');
    await glob('**/*.ts');
    assert.equal(h.fake.execRequests.at(-1)?.body.envs.MAKA_SUB, '.');
  });

  it('returns nothing for a pattern with no matches and errors for a missing cwd', async () => {
    assert.deepEqual(await glob('nothing/**'), { files: [], truncated: false });
    await assert.rejects(
      h.executor.globFiles({ cwd: join(h.work, 'missing'), pattern: '*' }),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  it('refuses to guess when the sandbox listing was cut off', async () => {
    // 6000 names of ~200 characters overflow the 1 MiB response.
    await fs.mkdir(join(h.work, 'many'));
    const long = 'n'.repeat(200);
    await Promise.all(
      Array.from({ length: 6000 }, (_, i) => fs.writeFile(join(h.work, 'many', `${long}${i}`), '')),
    );
    await assert.rejects(glob('many/**'), /more entries than one sandbox response/);
  });
});

describe('InstaboxWorkspaceExecutor.grepFiles', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    await fs.mkdir(join(h.work, 'src'));
    await fs.writeFile(join(h.work, 'src', 'a.ts'), 'const needle = 1;\nother\nneedle again\n');
    await fs.writeFile(join(h.work, 'src', 'b.md'), 'needle in docs\n');
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const grep = (extra: Record<string, unknown> = {}) =>
    h.executor.grepFiles({
      cwd: h.work,
      pattern: 'needle',
      path: h.work,
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 20_000,
      ...extra,
    });

  it('returns ripgrep matches in the local executor format', { skip: !hasRipgrep }, async () => {
    const result = await grep();
    assert.equal(result.matchedLines, 3);
    assert.equal(result.truncated, false);
    assert.deepEqual([...result.matches].sort(), [
      `${join(h.work, 'src', 'a.ts')}:1:const needle = 1;`,
      `${join(h.work, 'src', 'a.ts')}:3:needle again`,
      `${join(h.work, 'src', 'b.md')}:1:needle in docs`,
    ]);
  });

  it('applies glob, per-file and total limits', { skip: !hasRipgrep }, async () => {
    assert.equal((await grep({ glob: '*.md' })).matchedLines, 1);
    const perFile = await grep({ maxCountPerFile: 1 });
    assert.equal(perFile.returnedLines, 2);
    assert.equal(perFile.omittedLines, 1);
    const total = await grep({ limit: 1 });
    assert.equal(total.returnedLines, 1);
    assert.equal(total.truncated, true);
  });

  it('reports no matches as an empty result', { skip: !hasRipgrep }, async () => {
    const result = await grep({ pattern: 'zzz-not-here' });
    assert.deepEqual(result, {
      matches: [],
      matchedLines: 0,
      returnedLines: 0,
      omittedLines: 0,
      truncated: false,
    });
  });

  it('passes a hostile pattern as data, not shell syntax', { skip: !hasRipgrep }, async () => {
    await grep({ pattern: "'; touch pwned; echo '" });
    await assert.rejects(fs.stat(join(h.work, 'pwned')));
  });

  it('reports an invalid regex as a grep failure', { skip: !hasRipgrep }, async () => {
    await assert.rejects(grep({ pattern: '(' }), /Grep failed/);
  });

  it('says ripgrep is missing when the sandbox has no rg', async () => {
    const bare = await setup({ execPath: join(h.root, 'empty-bin') });
    try {
      await assert.rejects(
        bare.executor.grepFiles({
          cwd: bare.work,
          pattern: 'x',
          path: bare.work,
          maxCountPerFile: 5,
          limit: 5,
          timeoutMs: 5000,
        }),
        /ripgrep \(rg\) is not installed in the instabox sandbox/,
      );
    } finally {
      await bare.cleanup();
    }
  });

  it('maps a sandbox timeout to a grep timeout', async () => {
    h.fake.onExec = undefined;
    const bin = join(h.root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(join(bin, 'rg'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const slow = await setup({ execPath: `${bin}:${process.env.PATH}` });
    try {
      await assert.rejects(
        slow.executor.grepFiles({
          cwd: slow.work,
          pattern: 'x',
          path: slow.work,
          maxCountPerFile: 5,
          limit: 5,
          timeoutMs: 1000,
        }),
        /Grep timed out/,
      );
    } finally {
      await slow.cleanup();
    }
  });

  it('treats an aborted search as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(grep({ abortSignal: controller.signal }), /cancelled/);
  });
});
