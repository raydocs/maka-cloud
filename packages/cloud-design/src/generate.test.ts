import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { outputs, rendered } from './generate.ts';
import { dark, light } from './tokens.ts';

test('the generated files are up to date (run npm run generate)', () => {
  const files = rendered();
  for (const key of Object.keys(outputs) as (keyof typeof outputs)[]) {
    assert.equal(readFileSync(outputs[key], 'utf8'), files[key], outputs[key]);
  }
});

test('both schemes name the same colors', () => {
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
});

test('every color is in a form the web contrast test reads', () => {
  for (const value of [...Object.values(light), ...Object.values(dark)]) {
    assert.match(value, /^(#[0-9a-f]{6}|rgb\(\d+ \d+ \d+ \/ [\d.]+\))$/u, value);
  }
});
