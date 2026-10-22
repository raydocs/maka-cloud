import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTaskFile, REPRO_FILE, REVIEW_FILE, refusedScriptEnv } from '../task.js';

test('the files the runner names itself are plain task files', () => {
  for (const name of [
    REPRO_FILE,
    REVIEW_FILE,
    'change.patch',
    'failure_brief.json',
    'attempt-1.patch',
  ]) {
    assert.equal(isTaskFile(name), true, name);
    assert.equal(refusedScriptEnv({ MAKA_FILE: name }), undefined, name);
  }
});

test('a script is not run with a file name that leaves the task directory or hides in it', () => {
  for (const name of [
    '../x',
    'handoff/../x',
    '/etc/passwd',
    '.hidden',
    'handoff/.publish.abc',
    'a//b',
    'a/',
    '',
    'x\ny',
    'x y',
    '$(id)',
    'x;y',
    'x\0y',
  ]) {
    assert.equal(isTaskFile(name), false, JSON.stringify(name));
    assert.match(refusedScriptEnv({ MAKA_FILE: name }) ?? '', /MAKA_FILE/u, JSON.stringify(name));
  }
});

test('the files to keep are repository paths, one per line', () => {
  assert.equal(refusedScriptEnv({ MAKA_KEEP: '' }), undefined);
  assert.equal(refusedScriptEnv({ MAKA_KEEP: 'tests/a.test.ts\n.github/x.yml' }), undefined);
  for (const keep of [
    '/etc/passwd',
    '../x',
    'a/../b',
    'a\n../b',
    'a\n\nb',
    '.git/config',
    'a\0b',
  ]) {
    assert.match(refusedScriptEnv({ MAKA_KEEP: keep }) ?? '', /MAKA_KEEP/u, JSON.stringify(keep));
  }
});
