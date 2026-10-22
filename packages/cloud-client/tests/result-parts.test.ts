import { expect, test } from 'vitest';
import { pullRequestName, resultParts } from '../src';

test('a finished card is read back into title, outcome and check', () => {
  expect(
    resultParts({
      kind: 'finished',
      ask: '“Fix the flaky login test” finished (not independently checked): “The login test passed 50 runs in a row.”',
    }),
  ).toEqual({
    title: 'Fix the flaky login test',
    failed: false,
    checked: false,
    detail: 'The login test passed 50 runs in a row.',
  });
  expect(
    resultParts({
      kind: 'finished',
      ask: '“Weekly report” finished (independently checked): “Ready.”',
    })?.checked,
  ).toBe(true);
  expect(
    resultParts({ kind: 'finished', ask: '“Weekly report” finished: “Ready.”' })?.checked,
  ).toBe(undefined);
  expect(resultParts({ kind: 'finished', ask: '“Build” failed: “npm ci timed out”' })).toEqual({
    title: 'Build',
    failed: true,
    checked: undefined,
    detail: 'npm ci timed out',
  });
});

test('anything not in that shape is left to be shown as sent', () => {
  expect(resultParts({ kind: 'finished', ask: 'Something else entirely' })).toBeUndefined();
  expect(resultParts({ kind: 'decision', ask: '“A” finished: “B”' } as never)).toBeUndefined();
  // Text after the closing quote is not dropped silently.
  expect(resultParts({ kind: 'finished', ask: '“A” finished: “B” and more' })).toBeUndefined();
});

test('a GitHub pull request link is named by its number, nothing else is', () => {
  expect(pullRequestName('https://github.com/acme/widgets/pull/42')).toBe('Pull request #42');
  expect(pullRequestName('https://github.com/acme/widgets/pull/42/files')).toBe('Pull request #42');
  expect(pullRequestName('https://github.com/acme/widgets/issues/42')).toBeUndefined();
  expect(pullRequestName('https://evil.example/github.com/a/b/pull/1')).toBeUndefined();
  expect(pullRequestName(undefined)).toBeUndefined();
});
