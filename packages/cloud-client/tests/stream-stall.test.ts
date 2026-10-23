import { expect, test } from 'vitest';
import { CloudClient, readEvents, StreamStalled } from '../src/client';

const frame = (id: number) =>
  `id: ${id}\nevent: message.posted\ndata: {"conversationId":"c","messageId":"${id}","role":"user","text":"hi","at":0}\n\n`;

/** A response that sends `chunks` (a string now, a number waits that many ms) and stays open unless told to close. */
function streaming(chunks: Array<string | number>, close = false) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          if (typeof chunk === 'number') await new Promise((r) => setTimeout(r, chunk));
          else controller.enqueue(encoder.encode(chunk));
        }
        if (close) controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test('a stream that goes silent without closing is given up, after what it did deliver', async () => {
  const seen: number[] = [];
  await expect(
    readEvents(streaming([': stream open\n\n', frame(1)]), (event) => seen.push(event.id), {
      idleMs: 50,
    }),
  ).rejects.toBeInstanceOf(StreamStalled);
  expect(seen).toEqual([1]);
});

test('heartbeats alone keep a quiet stream open, and every chunk is counted', async () => {
  let bytes = 0;
  await readEvents(
    streaming(
      [': stream open\n\n', 30, ': keep-alive\n\n', 30, ': keep-alive\n\n', 30, frame(2)],
      true,
    ),
    () => {},
    { idleMs: 50, onBytes: () => bytes++ },
  );
  expect(bytes).toBe(4);
});

test('a stalled subscription reconnects from the last event, and says Live only once bytes arrive', async () => {
  const abort = new AbortController();
  const lastIds: (string | null)[] = [];
  const statuses: string[] = [];
  let calls = 0;
  const client = new CloudClient('t', {
    streamIdleMs: 50,
    fetcher: (async (_url, options) => {
      lastIds.push(new Headers(options?.headers).get('Last-Event-ID'));
      calls += 1;
      // First: headers and then nothing at all. Second: open, one event, then silence forever.
      // Third: the next event, then close.
      if (calls === 1) return streaming([]);
      return calls === 2
        ? streaming([': stream open\n\n', frame(71)])
        : streaming([': stream open\n\n', frame(93)], true);
    }) as typeof fetch,
  });
  const received: number[] = [];
  await client.subscribe(
    'c',
    (event) => {
      received.push(event.id);
      if (event.id === 93) abort.abort();
    },
    (value) => statuses.push(value.state),
    abort.signal,
  );
  expect(received).toEqual([71, 93]);
  expect(lastIds).toEqual([null, null, '71']);
  // A connection that never brought a byte was never called Live.
  expect(statuses).toEqual(['reconnecting', 'live', 'reconnecting', 'live']);
});
