import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { eventually, newConversation, openStream, postJson, startHarness } from './harness.js';

async function say(
  h: Awaited<ReturnType<typeof startHarness>>,
  conversationId: string,
  text: string,
) {
  const res = await postJson(h, `/v1/conversations/${conversationId}/messages`, { text });
  assert.equal(res.status, 202);
}

test('events arrive in order with increasing ids and the right kinds', async (t) => {
  const h = await startHarness(t);
  const stream = await openStream(t, h);
  assert.equal(stream.status, 200);
  const conversationId = await newConversation(h);
  await say(h, conversationId, 'one');
  await say(h, conversationId, 'two');
  const events = await stream.until(3);
  assert.deepEqual(
    events.map((e) => e.event),
    ['conversation.created', 'message.posted', 'message.posted'],
  );
  assert.deepEqual(
    events.map((e) => e.data.text),
    [undefined, 'one', 'two'],
  );
  assert.ok(events.every((e, i) => i === 0 || e.id > (events[i - 1]?.id ?? 0)));
  assert.ok(events.every((e) => e.data.conversationId === conversationId));
});

test('resuming from Last-Event-ID or ?after= returns exactly the events that were missed', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  for (let i = 0; i < 5; i += 1) await say(h, conversationId, `m${i}`);
  const all = await openStream(t, h);
  const known = await all.until(6);
  all.close();

  const fromHeader = await openStream(t, h, '', { 'last-event-id': String(known[2]?.id) });
  assert.deepEqual(
    (await fromHeader.until(3)).map((e) => e.id),
    known.slice(3).map((e) => e.id),
  );
  const fromQuery = await openStream(t, h, `?after=${known[2]?.id}`);
  assert.deepEqual(
    (await fromQuery.until(3)).map((e) => e.id),
    known.slice(3).map((e) => e.id),
  );
  // The header wins when both are given.
  const both = await openStream(t, h, `?after=${known[0]?.id}`, {
    'last-event-id': String(known[4]?.id),
  });
  assert.deepEqual(
    (await both.until(1)).map((e) => e.id),
    [known[5]?.id],
  );
  // A marker after everything: the resumed streams must deliver it next and nothing extra before it.
  await say(h, conversationId, 'marker');
  assert.deepEqual(
    (await fromHeader.until(4)).map((e) => e.data.text),
    ['m2', 'm3', 'm4', 'marker'],
  );
  assert.deepEqual(
    (await both.until(2)).map((e) => e.data.text),
    ['m4', 'marker'],
  );
});

test('an event appended while a stream replays is neither lost nor sent twice', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  for (let i = 0; i < 250; i += 1) await say(h, conversationId, `old ${i}`);
  const stream = await openStream(t, h, '', {});
  // Posting while the 251 stored events are still being replayed.
  for (let i = 0; i < 50; i += 1) await say(h, conversationId, `new ${i}`);
  await say(h, conversationId, 'marker');
  await stream.until(302);
  const ids = stream.events.map((e) => e.id);
  assert.equal(ids.length, 302);
  assert.equal(new Set(ids).size, 302);
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => a - b),
  );
  const texts = stream.events.filter((e) => e.event === 'message.posted').map((e) => e.data.text);
  assert.equal(texts.length, 301);
  assert.equal(texts.at(-2), 'new 49');
  assert.equal(texts.at(-1), 'marker');
});

test('a stream scoped to a conversation carries only that conversation', async (t) => {
  const h = await startHarness(t);
  const a = await newConversation(h, 'a');
  const b = await newConversation(h, 'b');
  const scoped = await openStream(t, h, `?conversation=${a}`);
  await say(h, a, 'for a');
  await say(h, b, 'for b');
  await say(h, a, 'again a');
  await say(h, a, 'marker');
  // The feed is ordered, so anything from b would sit in front of the marker.
  await scoped.until(4);
  assert.deepEqual(
    scoped.events.map((e) => [e.event, e.data.conversationId, e.data.text]),
    [
      ['conversation.created', a, undefined],
      ['message.posted', a, 'for a'],
      ['message.posted', a, 'again a'],
      ['message.posted', a, 'marker'],
    ],
  );
});

test('a heartbeat keeps an idle stream alive', async (t) => {
  const h = await startHarness(t, { http: { heartbeatMs: 20 } });
  const url = `${h.server.url}/v1/events`;
  const abort = new AbortController();
  t.after(() => abort.abort());
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${h.token}` },
    signal: abort.signal,
  });
  const reader = res.body?.getReader();
  assert.ok(reader);
  let text = '';
  const deadline = Date.now() + 2000;
  while (!text.includes('keep-alive') && Date.now() < deadline) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
  }
  assert.ok(text.includes(': keep-alive'));
});

test('open streams are limited per invite and in total, and a closed stream frees its slot', async (t) => {
  const h = await startHarness(t, { http: { streamsPerInvite: 2, streamsTotal: 3 } });
  const first = await openStream(t, h);
  const second = await openStream(t, h);
  const third = await openStream(t, h);
  assert.deepEqual([first.status, second.status, third.status], [200, 200, 429]);
  await eventually(() => h.server.openStreams() === 2, 'two streams');

  const other = h.server.invites.create('other');
  const fourth = await openStream(t, h, '', {}, other.token);
  assert.equal(fourth.status, 200);
  const fifth = await openStream(t, h, '', {}, other.token);
  assert.equal(fifth.status, 429, 'the total of 3 is reached');

  first.close();
  await eventually(() => h.server.openStreams() === 2, 'slot freed');
  const sixth = await openStream(t, h);
  assert.equal(sixth.status, 200);
});

test('a client that stops reading is dropped after the drain timeout and can resume', async (t) => {
  const h = await startHarness(t, { http: { drainTimeoutMs: 150 } });
  const conversationId = await newConversation(h);
  const big = 'x'.repeat(30_000);
  for (let i = 0; i < 400; i += 1) await say(h, conversationId, `${i} ${big}`);

  const socket = net.connect(Number(new URL(h.server.url).port), '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.pause();
  socket.write(
    `GET /v1/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${h.token}\r\nAccept: text/event-stream\r\n\r\n`,
  );
  await eventually(() => h.server.openStreams() === 1, 'stream opened');
  await eventually(() => h.server.openStreams() === 0, 'slow stream dropped', 5000);

  // A well-behaved client still gets everything from the start.
  const resumed = await openStream(t, h);
  await resumed.until(401);
});
