import { expect, test } from 'vitest';
import { CloudClient, readEvents } from '../src/client';
import { displayJson, displayText, publicLink } from '../src/presentation';
import type { FeedEvent } from '../src/contract';

test('SSE parses split UTF-8, CRLF, comments and multiline data, discarding an unfinished frame', async () => {
  const text =
    ': heartbeat\r\nid: 19\r\nevent: message.posted\r\ndata: {"conversationId":"a",\r\ndata: "messageId":"m","role":"user","text":"café ☀","at":3}\r\n\r\nid: 20\ndata: {"unfinished":true}';
  const bytes = new TextEncoder().encode(text);
  const result: FeedEvent[] = [];
  await readEvents(
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
    ),
    (event) => result.push(event),
  );
  expect(result).toEqual([
    {
      id: 19,
      kind: 'message.posted',
      data: { conversationId: 'a', messageId: 'm', role: 'user', text: 'café ☀', at: 3 },
    },
  ]);
});

test('resume uses feed ID, suppresses replay duplicates and keeps invite out of URLs', async () => {
  const abort = new AbortController();
  const calls: { url: string; headers: Headers }[] = [];
  let count = 0;
  const client = new CloudClient('fake-invite', (async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options?.headers) });
    count++;
    return new Response(
      (count === 1 ? [71] : [71, 93])
        .map(
          (id) =>
            `id: ${id}\nevent: message.posted\ndata: {"conversationId":"c","messageId":"${id}","role":"user","text":"hello","at":0}\n\n`,
        )
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch);
  const received: number[] = [];
  await client.subscribe(
    'c',
    (event) => {
      received.push(event.id);
      if (event.id === 93) abort.abort();
    },
    () => {},
    abort.signal,
  );
  expect(received).toEqual([71, 93]);
  expect(calls[1].headers.get('Last-Event-ID')).toBe('71');
  expect(calls[1].headers.get('Authorization')).toBe('Bearer fake-invite');
  expect(calls[1].url).toBe('/v1/events?conversation=c');
});

test('task pagination uses server cursors, not number of tasks returned', async () => {
  const paths: string[] = [];
  const client = new CloudClient('fake', (async (url) => {
    paths.push(String(url));
    return Response.json(
      paths.length === 1
        ? { tasks: [{ taskId: 'one' }], next: 87 }
        : { tasks: [{ taskId: 'two' }] },
    );
  }) as typeof fetch);
  expect((await client.listTasks('a/b')).map((task) => task.taskId)).toEqual(['one', 'two']);
  expect(paths).toEqual([
    '/v1/conversations/a%2Fb/tasks?after=0&limit=200',
    '/v1/conversations/a%2Fb/tasks?after=87&limit=200',
  ]);
});

test('links cannot execute code, expose blocked names or smuggle credentials', () => {
  expect(displayText('Ｃｌａｕｄｅ Open\u200bAI codex GPT-5 Anthropic')).toBe(
    'assistant assistant assistant assistant-5 assistant',
  );
  for (const url of [
    'javascript:alert(1)',
    'https://openai.com',
    'https://example.com/%43laude',
    'https://user:secret@example.com',
    'file:///tmp/report',
  ])
    expect(publicLink(url)).toBeUndefined();
  expect(publicLink('https://github.com/example/project/pull/17')).toBe(
    'https://github.com/example/project/pull/17',
  );
});

test('outside text loses control, direction and invisible characters; a held call shows them as escapes', () => {
  expect(displayText('Open the \u202Ekcol\u202C pull\u0007 request?\u2028\u3164It is safe.')).toBe(
    'Open the kcol pull request?\nIt is safe.',
  );
  const args = { title: 'Fix \u202Etxt.terces\u2066\u200B' };
  const shown = displayJson(args);
  expect(shown).toBe('{"title":"Fix \\u202etxt.terces\\u2066\\u200b"}');
  expect(JSON.parse(shown)).toEqual(args);
  expect(displayText(shown)).toBe(shown);
});
