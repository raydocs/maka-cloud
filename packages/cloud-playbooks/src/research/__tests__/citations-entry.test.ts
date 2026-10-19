import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as citations from '../../citations.js';

test('the citations entry exports the pure checker and nothing that touches files or the conductor', async () => {
  for (const name of [
    'checkCitations',
    'htmlToText',
    'normalizeText',
    'parseCiteCheckLine',
    'ReportSchema',
  ]) {
    assert.ok(name in citations, name);
  }
  for (const name of ['runCiteCheck', 'researchPlaybook', 'renderReport']) {
    assert.ok(!(name in citations), name);
  }
  for (const file of ['check', 'report-schema', 'source-text', 'summary-line']) {
    const source = await readFile(new URL(`../${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"](?:node:|@maka)/, file);
  }
});
