import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewLinksOf } from '../reviewer.js';

test('a brief that asks for judgments names the tasks whose runner must differ; one that uses them names theirs', () => {
  assert.deepEqual(
    reviewLinksOf('maka-inputs: tsk_a report.json sources\nmaka-artifacts: judgments.json\nGo.'),
    { others: ['tsk_a'], sources: ['tsk_a'] },
  );
  assert.deepEqual(
    reviewLinksOf(
      'maka-inputs: tsk_a report.json sources\nmaka-inputs: tsk_b judgments.json\nmaka-artifacts: out/report.json\nGo.',
    ),
    { others: ['tsk_b'], sources: ['tsk_a', 'tsk_b'] },
  );
  assert.deepEqual(reviewLinksOf('maka-artifacts: out/report.md\nGo.'), {
    others: [],
    sources: [],
  });
  assert.deepEqual(reviewLinksOf('Go.'), { others: [], sources: [] });
  // Where the file is does not matter, nor how its name is spelled.
  assert.deepEqual(
    reviewLinksOf('maka-inputs: tsk_a report.json\nmaka-artifacts: out/Judgments.JSON\nGo.'),
    { others: ['tsk_a'], sources: ['tsk_a'] },
  );
  assert.deepEqual(reviewLinksOf('maka-inputs: tsk_b out/judgments.json\nGo.'), {
    others: ['tsk_b'],
    sources: ['tsk_b'],
  });
});

test('only the leading directives count: a request lower in the brief is text', () => {
  assert.deepEqual(
    reviewLinksOf('Go.\nmaka-inputs: tsk_a judgments.json\nmaka-artifacts: judgments.json'),
    { others: [], sources: [] },
  );
  assert.deepEqual(reviewLinksOf('\n\nmaka-inputs: tsk_a judgments.json\r\nGo.'), {
    others: ['tsk_a'],
    sources: ['tsk_a'],
  });
});
