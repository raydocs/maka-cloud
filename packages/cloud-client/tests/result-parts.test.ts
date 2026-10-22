import { expect, test } from 'vitest';
import { pullRequestName } from '../src';

test('a GitHub pull request link is named by its number, nothing else is', () => {
  expect(pullRequestName('https://github.com/acme/widgets/pull/42')).toBe('Pull request #42');
  expect(pullRequestName('https://github.com/acme/widgets/pull/42/files')).toBe('Pull request #42');
  expect(pullRequestName('https://github.com/acme/widgets/issues/42')).toBeUndefined();
  expect(pullRequestName('https://evil.example/github.com/a/b/pull/1')).toBeUndefined();
  expect(pullRequestName(undefined)).toBeUndefined();
});
