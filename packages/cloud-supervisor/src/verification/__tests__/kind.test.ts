import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SignalManifest } from '../../events.js';
import { acceptedKindOf, refsFor, verificationKindOf } from '../kind.js';

function listing(...artifacts: string[]): SignalManifest {
  return { summary: 's', confidence: 'high', artifacts } as SignalManifest;
}

test("only a manifest made entirely of one check's own files is accepted for it", () => {
  assert.equal(acceptedKindOf(listing('out/change.patch', 'out/changes.json')), 'coding');
  assert.equal(
    acceptedKindOf(listing('changes.json', 'change.patch', 'out/verification.json')),
    'coding',
  );
  assert.equal(
    acceptedKindOf(
      listing('out/change.patch', 'out/changes.json', 'out/verification.json', 'out/review.md'),
    ),
    'coding',
    'the review of a change is one of the coding files',
  );
  assert.equal(
    acceptedKindOf(listing('/out/report.md', 'out/report.json', 'out/verification.json')),
    'research',
  );
  for (const rejected of [
    listing('out/changes.json', 'out/report.json'),
    listing('out/report.json', 'out/review.md'),
    listing('out/review.md'),
    listing('out/changes.json', 'out/Review.md'),
    listing('out/changes.json', 'https://example.com/review.md'),
    listing('out/changes.json', 'out/report.md'),
    listing('out/report.json', 'out/notes.txt'),
    listing('out/report.json', 'out/report.json.md'),
    listing('out/report.json', 'https://example.com/report.json'),
    listing('out/report.json', 'out/rеport.json'),
    listing('out/report.json', 'out/Report.md'),
    listing('out/report.json', 'out/report.md/'),
    listing('out/report.json', 'out//report.md'),
    listing('out/report.json', 'out/./report.md'),
    listing('out/report.json', 'out/a b/report.md'),
    listing('out/report.md'),
    listing('out/verification.json'),
    listing(),
  ]) {
    assert.equal(acceptedKindOf(rejected), undefined, JSON.stringify(rejected.artifacts));
  }
});

test('something that resembles a change or a report is never classified as nothing to check', () => {
  for (const artifacts of [
    ['out/changes.json', 'out/notes.txt'],
    ['out/report.json.md', 'out/changes.json'],
    ['out/Report.MD'],
    ['https://example.com/report.json?download=1'],
    ['out/%72eport.json'],
    ['out/report.md'],
    ['out/verification.json'],
  ]) {
    assert.ok(verificationKindOf(listing(...artifacts)) !== undefined, artifacts.join());
  }
  for (const artifacts of [[], ['notes.txt'], ['https://example.com/a.md'], ['out/rеport.json']]) {
    assert.equal(verificationKindOf(listing(...artifacts)), undefined, artifacts.join());
  }
});

test('a name is found only by its exact plain spelling', () => {
  const manifest = listing('out/report.json', 'out/Report.json', 'https://x.test/report.json');
  assert.deepEqual(refsFor(manifest, 'report.json'), ['out/report.json']);
});
