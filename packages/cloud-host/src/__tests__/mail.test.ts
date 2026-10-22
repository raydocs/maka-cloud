import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpMailer } from '../mail.js';

function mailer(answer: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const send = createHttpMailer({
    apiUrl: 'https://mail.example.test/send',
    apiKey: 'mail-key-secret-0123456789',
    from: 'Maka <login@maka.example>',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return answer();
    }) as typeof fetch,
  });
  return { send, calls };
}

test('mail goes to the owner’s service as JSON with the bearer key, and no redirect is followed', async () => {
  const { send, calls } = mailer(() => new Response(null, { status: 200 }));
  await send.send({ to: 'ada@example.com', subject: 'Code', text: 'Your code is 123456.' });
  assert.equal(calls[0]?.url, 'https://mail.example.test/send');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.init.redirect, 'error');
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer mail-key-secret-0123456789');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    from: 'Maka <login@maka.example>',
    to: ['ada@example.com'],
    subject: 'Code',
    text: 'Your code is 123456.',
  });
});

test('a refusal or a failure is an error that carries neither the key nor what the service said', async () => {
  const refused = mailer(
    () => new Response('bad key mail-key-secret-0123456789 for ada@example.com', { status: 401 }),
  );
  await assert.rejects(
    refused.send.send({ to: 'ada@example.com', subject: 's', text: 't' }),
    (error: Error) => {
      assert.match(error.message, /answered 401/u);
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.message.includes('ada@'), false);
      return true;
    },
  );
  const down = mailer(() => {
    throw new Error('connect ECONNREFUSED mail-key-secret-0123456789');
  });
  await assert.rejects(
    down.send.send({ to: 'ada@example.com', subject: 's', text: 't' }),
    (error: Error) => error.message === 'The mail service could not be reached',
  );
});
