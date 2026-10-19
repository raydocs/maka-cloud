import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkBreakpoints,
  checkHistory,
  checkThinking,
  contentPrefixDivergence,
  strictPrefixDivergence,
} from '../checks.js';
import type {
  EmittedThinking,
  RecordedRequest,
  WireBlock,
  WireMessage,
} from '../fake-anthropic.js';

const CONTEXT = 'Runtime Host environment for this turn:\n{}';
const options = {
  isRequestOnlyBlock: (block: WireBlock) =>
    block.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.startsWith('Runtime Host'),
};
const marker = { type: 'ephemeral' };

function request(
  index: number,
  messages: WireMessage[],
  extra: Record<string, unknown> = {},
): RecordedRequest {
  const body = { messages, ...extra };
  return { index, kind: 'main', raw: JSON.stringify(body), body, turn: index + 1 };
}

const user = (...content: WireBlock[]): WireMessage => ({ role: 'user', content });
const assistant = (...content: WireBlock[]): WireMessage => ({ role: 'assistant', content });
const text = (value: string, cacheControl?: unknown): WireBlock => ({
  type: 'text',
  text: value,
  ...(cacheControl ? { cache_control: cacheControl } : {}),
});
const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig-1' };

describe('prefix checks', () => {
  test('an append-only extension has no divergence', () => {
    const first = request(0, [user(text('hi'))]);
    const second = request(1, [
      user(text('hi')),
      assistant(thinking, text('ok')),
      user(text('next')),
    ]);
    assert.equal(strictPrefixDivergence(first, second, options), undefined);
    assert.equal(contentPrefixDivergence(first, second, options), undefined);
  });

  test('a moved cache marker breaks the strict prefix only', () => {
    const first = request(0, [user(text('hi', marker))]);
    const second = request(1, [user(text('hi')), assistant(text('ok', marker))]);
    assert.equal(strictPrefixDivergence(first, second, options)?.cause, 'cache_control_moved');
    assert.equal(contentPrefixDivergence(first, second, options), undefined);
  });

  test('a dropped request-only block breaks the strict prefix only', () => {
    const first = request(0, [user(text('hi'), text(CONTEXT))]);
    const second = request(1, [
      user(text('hi')),
      assistant(text('ok')),
      user(text('more'), text(CONTEXT)),
    ]);
    const strict = strictPrefixDivergence(first, second, options);
    assert.equal(strict?.cause, 'request_only_context');
    assert.equal(strict?.messageIndex, 0);
    assert.equal(contentPrefixDivergence(first, second, options), undefined);
  });

  test('a rewritten earlier message is reported with its path', () => {
    const first = request(0, [
      user(text('hi')),
      assistant(thinking, text('ok')),
      user(text('next')),
    ]);
    const second = request(1, [user(text('hi')), assistant(text('ok')), user(text('next'))]);
    const content = contentPrefixDivergence(first, second, options);
    assert.equal(content?.cause, 'rewrite');
    assert.equal(content?.messageIndex, 1);
    assert.equal(content?.path, '.content[0].type');
    assert.equal(strictPrefixDivergence(first, second, options)?.cause, 'rewrite');
  });

  test('a shorter history is reported as shrunk', () => {
    const first = request(0, [user(text('a')), assistant(text('b')), user(text('c'))]);
    const second = request(1, [user(text('summary'))]);
    assert.equal(contentPrefixDivergence(first, second, options)?.cause, 'rewrite');
    const third = request(2, [user(text('a'))]);
    assert.equal(strictPrefixDivergence(first, third, options)?.cause, 'history_shrunk');
  });
});

describe('thinking check', () => {
  const emitted: EmittedThinking[] = [
    { requestIndex: 0, block: { type: 'thinking', thinking: 'plan', signature: 'sig-1' } },
  ];

  test('passes when the block comes back unchanged at the same position', () => {
    const later = [
      request(1, [user(text('hi')), assistant(thinking, text('ok')), user(text('next'))]),
      request(2, [
        user(text('hi')),
        assistant(thinking, text('ok')),
        user(text('next')),
        assistant(text('x')),
        user(text('y')),
      ]),
    ];
    assert.deepEqual(checkThinking(later, emitted).failures, []);
  });

  test('reports a dropped block', () => {
    const later = [request(1, [user(text('hi')), assistant(text('ok')), user(text('next'))])];
    assert.equal(checkThinking(later, emitted).failures[0]?.kind, 'missing');
  });

  test('reports a changed signature', () => {
    const later = [
      request(1, [
        user(text('hi')),
        assistant({ ...thinking, signature: 'other' }),
        user(text('n')),
      ]),
    ];
    const failure = checkThinking(later, emitted).failures[0];
    assert.equal(failure?.kind, 'altered');
    assert.match(failure?.detail ?? '', /signature changed/);
  });

  test('reports a block that moves', () => {
    const later = [
      request(1, [user(text('hi')), assistant(thinking, text('ok')), user(text('n'))]),
      request(2, [
        user(text('summary')),
        user(text('hi')),
        assistant(thinking, text('ok')),
        user(text('n')),
      ]),
    ];
    assert.equal(checkThinking(later, emitted).failures[0]?.kind, 'moved');
  });
});

describe('breakpoint check', () => {
  test('accepts one marker on the last durable block, moving forward', () => {
    const requests = [
      request(0, [user(text('hi', marker), text(CONTEXT))], { cache_control: marker }),
      request(
        1,
        [user(text('hi')), assistant(text('ok')), user(text('n', marker), text(CONTEXT))],
        {
          cache_control: marker,
        },
      ),
    ];
    assert.deepEqual(checkBreakpoints(requests, options).failures, []);
  });

  test('flags a marker that is not on the last durable block, or moves backwards', () => {
    const requests = [
      request(0, [user(text('a')), assistant(text('b')), user(text('c', marker))]),
      request(1, [
        user(text('a', marker)),
        assistant(text('b')),
        user(text('c')),
        assistant(text('d')),
      ]),
    ];
    const kinds = checkBreakpoints(requests, options).failures.map((failure) => failure.kind);
    assert.deepEqual(kinds, ['not_on_last_durable_block', 'moved_backwards']);
  });

  test('flags more than four markers', () => {
    const blocks = Array.from({ length: 5 }, (_, index) => text(`b${index}`, marker));
    const kinds = checkBreakpoints([request(0, [user(...blocks)])], options).failures.map(
      (f) => f.kind,
    );
    assert.ok(kinds.includes('over_limit'));
  });
});

test('checkHistory skips summary requests and counts system and tool changes', () => {
  const requests: RecordedRequest[] = [
    request(0, [user(text('hi', marker))], { system: 'a', tools: [{ name: 't' }] }),
    { ...request(1, [user(text('summarize'))]), kind: 'summary' },
    request(2, [user(text('hi')), assistant(text('ok')), user(text('n', marker))], {
      system: 'b',
      tools: [{ name: 't' }],
    }),
  ];
  const report = checkHistory(requests, [], options);
  assert.equal(report.requests, 2);
  assert.deepEqual(report.systemChanges, [{ from: 0, to: 2 }]);
  assert.deepEqual(report.toolsChanges, []);
});
