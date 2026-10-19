import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineSplitter } from '../lines.js';
import { collect, notes, setup, terminal } from './harness.js';

test('a line without a newline is dropped at the cap and the next line is read', () => {
  const lines: string[] = [];
  let drops = 0;
  const splitter = new LineSplitter(
    1_000,
    (line) => lines.push(line),
    () => drops++,
  );
  splitter.push('first\nsecond');
  for (let i = 0; i < 200; i++) {
    splitter.push('x'.repeat(1_000_000));
    assert.ok(splitter.pending <= 1_000, 'the buffer never grows past the cap');
  }
  splitter.push('tail of the flood\nthird\nfourth');
  splitter.end();
  assert.deepEqual(lines, ['first', 'third', 'fourth']);
  assert.equal(drops, 1, 'one dropped line, reported once');
});

test('a line that arrives whole but over the cap is dropped too', () => {
  const lines: string[] = [];
  let drops = 0;
  const splitter = new LineSplitter(
    10,
    (line) => lines.push(line),
    () => drops++,
  );
  splitter.push(`${'y'.repeat(50)}\nok\n`);
  assert.deepEqual(lines, ['ok']);
  assert.equal(drops, 1);
});

test('newline-free output is capped: the run still ends, with a short reason', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('floodfail');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_flood1')));
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  const reason = last?.type === 'failed' ? last.reason : '';
  assert.match(reason, /claude exited with code 1/);
  assert.ok(reason.length <= 2_100, `reason is ${reason.length} characters`);
  assert.ok(
    notes(events).some((note) => /dropped/.test(note)),
    'the drop is noted',
  );
});

test('a long line of stderr is quoted in the failure reason only up to a cap', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('longfail');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_long')));
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  const reason = last?.type === 'failed' ? last.reason : '';
  assert.match(reason, /claude exited with code 1: y{100}/);
  assert.ok(reason.length <= 400, `reason is ${reason.length} characters`);
});

test('a flooded line does not stop later events from being read', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('flood');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_flood2')));
  assert.equal(terminal(events)?.type, 'finished');
  assert.ok(notes(events).includes('working on it'));
});
