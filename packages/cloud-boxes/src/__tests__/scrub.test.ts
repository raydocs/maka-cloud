import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { scrubScript } from '../scrub.js';

/** The script run by a real shell over a scratch tree standing in for the builder's disk. */
describe('the scrub script', () => {
  let root: string;
  let home: string;
  let work: string;
  let maka: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'maka-scrub-'));
    home = join(root, 'home');
    work = join(root, 'data-work');
    maka = join(root, 'data-maka');
    repo = join(maka, 'repos', 'app');
    for (const dir of [home, work, join(maka, 'repos', 'app')]) mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    writeFileSync(join(repo, '.env.example'), 'KEY=\n');
    writeFileSync(join(repo, '.npmrc'), 'registry=https://registry.example/\n');
    spawnSync('git', ['add', 'README.md', '.env.example', '.npmrc'], { cwd: repo });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (mode: 'clean' | 'check') =>
    spawnSync('sh', ['-c', scrubScript([work, maka], [join(maka, 'repos')])], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TMPDIR: root,
        MAKA_REPO_DIR: repo,
        MAKA_SCRUB_MODE: mode,
      },
      encoding: 'utf8',
    });

  const plant = () => {
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', 't.jsonl'), '{"a":1}');
    writeFileSync(join(home, '.npmrc'), '//registry/:_authToken=abc');
    writeFileSync(join(home, '.bash_history'), 'curl -H token');
    mkdirSync(join(work, 'task-1'), { recursive: true });
    writeFileSync(join(work, 'task-1', 'notes.txt'), 'another task');
    mkdirSync(join(maka, 'transcripts'), { recursive: true });
    writeFileSync(join(repo, '.env'), 'TOKEN=abc\n');
    writeFileSync(join(repo, '.env.local'), 'TOKEN=abc\n');
  };

  it('a check on a clean disk finds nothing and exits 0', () => {
    const result = run('check');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
  });

  it('a check lists every credential, history, task folder and untracked env file, and exits 7, removing none', () => {
    plant();
    const result = run('check');
    assert.equal(result.status, 7, result.stdout + result.stderr);
    for (const path of [
      join(home, '.ssh'),
      join(home, '.claude'),
      join(home, '.npmrc'),
      join(home, '.bash_history'),
      join(work, 'task-1'),
      join(maka, 'transcripts'),
      join(repo, '.env'),
      join(repo, '.env.local'),
    ]) {
      assert.match(
        result.stdout,
        new RegExp(`FOUND ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      );
    }
    assert.ok(existsSync(join(home, '.ssh', 'id_ed25519')), 'a check removes nothing');
  });

  it('a clean removes them, keeps the checkout and its tracked files, and the check after it passes', () => {
    plant();
    const cleaned = run('clean');
    assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
    for (const gone of [
      join(home, '.ssh'),
      join(home, '.claude'),
      join(home, '.npmrc'),
      join(home, '.bash_history'),
      join(work, 'task-1'),
      join(maka, 'transcripts'),
      join(repo, '.env'),
      join(repo, '.env.local'),
    ]) {
      assert.equal(existsSync(gone), false, `${gone} is gone`);
    }
    for (const kept of [
      join(repo, 'README.md'),
      join(repo, '.env.example'),
      join(repo, '.npmrc'),
      join(maka, 'repos'),
    ]) {
      assert.equal(existsSync(kept), true, `${kept} stays`);
    }
    const checked = run('check');
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  });

  it('removes a link to a credential without following it', () => {
    const target = join(root, 'elsewhere');
    writeFileSync(target, 'outside the scratch folders');
    symlinkSync(target, join(home, '.netrc'));
    const cleaned = run('clean');
    assert.equal(cleaned.status, 0);
    assert.equal(existsSync(join(home, '.netrc')), false);
    assert.equal(existsSync(target), true, 'the target is not touched');
  });
});
