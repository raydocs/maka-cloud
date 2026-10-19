import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_INPUT_LINES,
  MAX_INPUT_PATHS,
  parseInputRequests,
  sameConversationInputPolicy,
} from '../inputs.js';

const refusal = (brief: string): string => {
  const parsed = parseInputRequests(brief);
  assert.equal(parsed.ok, false, `expected a refusal for ${JSON.stringify(brief)}`);
  return parsed.ok ? '' : parsed.reason;
};

test('a brief with no request has none', () => {
  assert.deepEqual(parseInputRequests('# Review\n\nDo the thing.\n'), { ok: true, requests: [] });
  assert.deepEqual(parseInputRequests(''), { ok: true, requests: [] });
  // Prose that mentions the word is not a request.
  assert.deepEqual(parseInputRequests('Do it.\nsee maka-inputs: tsk_a report.json for how'), {
    ok: true,
    requests: [],
  });
});

test('requests at the start are read, with blank lines before them and CRLF line ends', () => {
  const brief =
    '\n\nmaka-inputs: tsk_a report.json sources/pages\r\nmaka-inputs: tsk_b judgments.json\r\n\r\n# Review\n';
  assert.deepEqual(parseInputRequests(brief), {
    ok: true,
    requests: [
      { source: 'tsk_a', paths: ['report.json', 'sources/pages'] },
      { source: 'tsk_b', paths: ['judgments.json'] },
    ],
  });
});

test('lines for one task are merged and a path is listed once', () => {
  const brief =
    'maka-inputs: tsk_a report.json sources\nmaka-inputs: tsk_a sources out/report.md\n';
  assert.deepEqual(parseInputRequests(brief), {
    ok: true,
    requests: [{ source: 'tsk_a', paths: ['report.json', 'sources', 'out/report.md'] }],
  });
});

test('a request line after the start is refused, however it is dressed up', () => {
  const body = 'maka-inputs: tsk_a report.json\n\n# Review\n';
  for (const extra of [
    'maka-inputs: tsk_b report.json',
    '  maka-inputs: tsk_b report.json',
    '> maka-inputs: tsk_b report.json',
    '- maka-inputs: tsk_b report.json',
    '* maka-inputs : tsk_b report.json',
    'MAKA-INPUTS: tsk_b report.json',
    '\tmaka-inputs: tsk_b report.json',
    '```\nmaka-inputs: tsk_b report.json\n```',
  ]) {
    assert.match(refusal(`${body}${extra}\n`), /only read at the very start/, extra);
  }
  assert.match(refusal('# Review\nmaka-inputs: tsk_b report.json'), /only read at the very start/);
  // A blank-separated second block is not the start either.
  assert.match(
    refusal('maka-inputs: tsk_a report.json\n\nmaka-inputs: tsk_b report.json'),
    /only read at the very start/,
  );
});

test('a malformed request line is refused, not skipped', () => {
  for (const line of [
    'maka-inputs:',
    'maka-inputs: tsk_a',
    'maka-inputs:  tsk_a report.json',
    'maka-inputs: tsk_a  report.json',
    'maka-inputs: tsk_a report.json ',
    'maka-inputs:\ttsk_a report.json',
    'maka-inputs: tsk_a\treport.json',
    'maka-inputs:tsk_a report.json',
  ]) {
    assert.match(
      refusal(`${line}\n`),
      /not "maka-inputs: <taskId> <path> ..."/,
      JSON.stringify(line),
    );
  }
});

test('task ids are plain names', () => {
  for (const id of ['../tsk_a', 'tsk/a', 'tsk.a', 'tsk%a', 'a'.repeat(129), '.', '..']) {
    assert.match(refusal(`maka-inputs: ${id} report.json\n`), /invalid task id/, id);
  }
});

test('paths are plain relative paths', () => {
  for (const path of [
    '..',
    '../x',
    'a/../b',
    '/etc/passwd',
    'a//b',
    'a/./b',
    '.hidden',
    'a/.hidden',
    'a/',
    'a\\b',
    'a;b',
    '$HOME',
    'a*',
    'x'.repeat(201),
  ]) {
    assert.match(refusal(`maka-inputs: tsk_a ${path}\n`), /not a plain relative path/, path);
  }
});

test('the number of lines and paths is capped', () => {
  const lines = Array.from(
    { length: MAX_INPUT_LINES + 1 },
    (_, i) => `maka-inputs: tsk_${i} a.json`,
  );
  assert.match(refusal(`${lines.join('\n')}\n`), /more than \d+ maka-inputs: lines/);
  const paths = Array.from({ length: MAX_INPUT_PATHS + 1 }, (_, i) => `p${i}`);
  assert.match(refusal(`maka-inputs: tsk_a ${paths.join(' ')}\n`), /more than \d+ input paths/);
  const ok = Array.from({ length: MAX_INPUT_PATHS }, (_, i) => `p${i}`);
  assert.equal(parseInputRequests(`maka-inputs: tsk_a ${ok.join(' ')}\n`).ok, true);
});

test('the conversation policy: same conversation and finished only', () => {
  const roots: Record<string, string> = {
    tsk_t: 'root_1',
    tsk_done: 'root_1',
    tsk_busy: 'root_1',
    tsk_far: 'root_2',
  };
  const states: Record<string, 'succeeded' | 'failed' | 'cancelled' | 'running' | 'queued'> = {
    tsk_done: 'succeeded',
    tsk_busy: 'running',
    tsk_far: 'succeeded',
    tsk_t: 'running',
  };
  const policy = sameConversationInputPolicy({
    rootSessionOfTask: (id) => roots[id],
    taskStateOf: (id) => states[id],
  });
  const check = (source: string, target = 'tsk_t') => policy.check({ target, source });
  assert.equal(check('tsk_done'), undefined);
  states.tsk_done = 'failed';
  assert.equal(check('tsk_done'), undefined, 'a failed task still has its files');
  states.tsk_done = 'cancelled';
  assert.equal(check('tsk_done'), undefined);
  assert.match(String(check('tsk_busy')), /has not finished/);
  assert.match(String(check('tsk_far')), /not part of this conversation/);
  assert.match(String(check('tsk_nobody')), /not part of this conversation/);
  assert.match(String(check('tsk_t')), /own files/);
  assert.match(String(check('tsk_done', 'tsk_nobody')), /not part of this conversation/);
  // A task the orchestrator knows by root but has no state for is not finished.
  roots.tsk_ghost = 'root_1';
  assert.match(String(check('tsk_ghost')), /has not finished/);
});
