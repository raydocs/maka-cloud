import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '../../scripts/layerfs-gates.mjs');
const doc = readFileSync(join(here, '../../../../docs/fork/design/layerfs.md'), 'utf8');

test('the LayerFS gate harness documents and locally runs the four gates without Instabox', () => {
  assert.match(doc, /0\. Device/u);
  assert.match(doc, /1\. Isolation/u);
  assert.match(doc, /2\. Gain/u);
  assert.match(doc, /3\. Correctness/u);
  assert.match(doc, /layerfs-gates\.mjs/u);
  assert.equal(
    doc.includes('--live'),
    true,
    'the design page says --live is owner-only on Instabox',
  );
  const out = execFileSync(process.execPath, [script, '--local'], { encoding: 'utf8' });
  assert.match(out, /gate 0: SKIP/u);
  assert.match(out, /gate 1: SKIP/u);
  assert.match(out, /gate 2: SKIP/u);
  assert.match(out, /gate 3: PASS/u);
});
