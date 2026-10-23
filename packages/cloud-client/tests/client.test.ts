import { expect, test } from 'vitest';
import { CloudClient, readEvents } from '../src/client';
import { displayJson, displayText, publicLink } from '../src/presentation';
import type { FeedEvent } from '../src/contract';
import { applyEvent, emptyState } from '../src/state';

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
    // Written so a parser that finds no user name would still let it through.
    'https:paypal.com@evil.example/x/pull/1',
    'https://paypal.com\\@evil.example/',
    'https://paypal.com@evil.example/',
    ' https://github.com/example/project/pull/17',
    'https://github.com\t/example',
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

const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);

test('a file the server sends as a picture is a picture; nothing else ever is', async () => {
  const reply = (type: string, body: NonNullable<ConstructorParameters<typeof Response>[0]>) =>
    new CloudClient(
      'fake',
      (async () =>
        new Response(body, {
          headers: {
            'content-type': type,
            'content-disposition': 'attachment; filename="proof.png"',
          },
        })) as typeof fetch,
    );
  const picture = await reply('image/png', PNG_BYTES).readArtifact('t', 0);
  expect(picture.kind).toBe('image');
  expect(picture.kind === 'image' && picture.blob.type).toBe('image/png');
  expect(picture.kind === 'image' && picture.blob.size).toBe(PNG_BYTES.length);
  for (const type of [
    'image/svg+xml',
    'text/html',
    'image/x-icon',
    'application/octet-stream',
    'text/plain; charset=utf-8',
  ]) {
    const read = await reply(type, '<svg onload="alert(1)"/>').readArtifact('t', 0);
    expect(read, type).toEqual({
      kind: 'text',
      name: 'proof.png',
      text: '<svg onload="alert(1)"/>',
    });
  }
});

test('sources are listed by the server and their images come through it, in the allowed types only', async () => {
  const paths: string[] = [];
  const client = new CloudClient('fake', (async (url) => {
    paths.push(String(url));
    if (String(url).endsWith('/image')) {
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/svg+xml' } });
    }
    return Response.json({
      sources: [{ index: 0, url: 'https://docs.example/a', site: 'docs.example', label: 'docs' }],
      total: 1,
    });
  }) as typeof fetch);
  expect((await client.listSources('tsk/1')).sources[0]?.site).toBe('docs.example');
  await expect(client.sourceImage('tsk/1', 0)).rejects.toThrow();
  expect(paths).toEqual(['/v1/tasks/tsk%2F1/sources', '/v1/tasks/tsk%2F1/sources/0/image']);
});

test('a fetch that refuses a foreign `this` (as a browser’s does) still works', async () => {
  const platformFetch = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(Response.json({ conversations: [] }));
  } as unknown as typeof fetch;
  const client = new CloudClient('fake', { fetcher: platformFetch });
  await expect(client.listConversations()).resolves.toEqual({ conversations: [] });
});

test('a restarted task shows the restart text as its latest note, once, and keeps running', () => {
  const frame = (id: number, event: unknown, at = id): FeedEvent =>
    ({ id, kind: 'task.event', data: { conversationId: 'c', seq: id, at, event } }) as FeedEvent;
  let state = emptyState();
  state = applyEvent(
    state,
    frame(1, { type: 'task_created', taskId: 't', sessionId: 's', mode: 'async' }),
  );
  state = applyEvent(state, frame(2, { type: 'task_started', taskId: 't' }));
  state = applyEvent(
    state,
    frame(3, { type: 'task_progress', taskId: 't', note: 'reading the repo' }),
  );
  state = applyEvent(
    state,
    frame(4, { type: 'task_restarted', taskId: 't', epoch: 2, text: 'The server restarted.' }),
  );
  const task = state.tasks.t;
  expect(task?.state).toBe('running');
  expect(task?.progress).toEqual(['reading the repo', 'The server restarted.']);
});

test('suggestion switches are read and set on the project, and a server without them is unsupported for that feature only', async () => {
  const seen: Array<{ url: string; method: string; body?: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body as string });
    if (String(input).includes('/nope/')) return Response.json({}, { status: 404 });
    if (init?.method === 'PATCH') return Response.json({ kind: 'fix_main_ci', enabled: false });
    return Response.json({ suggestions: { kinds: [{ kind: 'fix_main_ci', enabled: true }] } });
  };
  const client = new CloudClient('t', fetcher);
  expect((await client.listSuggestions('p 1')).kinds).toHaveLength(1);
  await client.setSuggestionKind('p 1', 'fix_main_ci', false);
  expect(seen[0]?.url).toBe('/v1/projects/p%201/suggestions');
  expect(seen[1]).toMatchObject({
    url: '/v1/projects/p%201/suggestions',
    method: 'PATCH',
    body: JSON.stringify({ kind: 'fix_main_ci', enabled: false }),
  });
  await expect(client.listSuggestions('nope')).rejects.toThrow();
  expect(client.unsupported.has('suggestions')).toBe(true);
  expect(client.unsupported.has('projects')).toBe(false);
});

test('the person’s language is read and set on the settings route; an older server is unsupported', async () => {
  const calls: string[] = [];
  let language = 'zh-Hans';
  const fetcher = (async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)} ${String(init?.body ?? '')}`.trim());
    if (init?.method === 'PATCH')
      language = (JSON.parse(String(init.body)) as { language: string }).language;
    return Response.json({ language });
  }) as typeof fetch;
  const client = new CloudClient('mks_a.b', { fetcher });
  expect(await client.settings()).toEqual({ language: 'zh-Hans' });
  expect(await client.setLanguage('en')).toEqual({ language: 'en' });
  expect(await client.setLanguage('zh-Hant')).toEqual({ language: 'zh-Hant' });
  expect(calls).toEqual([
    'GET /v1/settings',
    'PATCH /v1/settings {"language":"en"}',
    'PATCH /v1/settings {"language":"zh-Hant"}',
  ]);
  const old = new CloudClient('mks_a.b', {
    fetcher: (async () => new Response('{}', { status: 404 })) as typeof fetch,
  });
  await expect(old.settings()).rejects.toThrow('not available');
  expect(old.unsupported.has('settings')).toBe(true);
});
