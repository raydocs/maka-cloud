import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmailCodes, type Mailer, NonceStore, normalizeEmail } from '../challenges.js';

test('a nonce is good once, and not after ten minutes, and not if it was never given out', () => {
  let now = 1_000;
  const nonces = new NonceStore(() => now);
  const a = nonces.issue();
  const b = nonces.issue();
  assert.notEqual(a, b);
  assert.equal(nonces.consume('made-up'), false);
  assert.equal(nonces.consume(a), true);
  assert.equal(nonces.consume(a), false, 'replayed');
  now += 10 * 60 * 1000 + 1;
  assert.equal(nonces.consume(b), false, 'expired');
});

test('addresses are compared lower case and only plain ones are mailed', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  for (const bad of [
    '',
    'ada',
    'ada@',
    '@example.com',
    'ada@example',
    'a b@example.com',
    'ada@example.com, bob@example.com',
    '"ada"@example.com',
    'ada@example.com\r\nBcc: bob@example.com',
    'ada@exa mple.com',
    'ada@ex<ample>.com',
    `${'a'.repeat(65)}@example.com`,
    `ada@${'a'.repeat(250)}.com`,
    'ada@exаmple.com',
  ]) {
    assert.equal(normalizeEmail(bad), undefined, JSON.stringify(bad));
  }
});

function mail() {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const state = { fail: false };
  const mailer: Mailer = {
    async send(message) {
      if (state.fail) throw new Error('smtp down');
      sent.push(message);
    },
  };
  const codeOf = (index = sent.length - 1) =>
    /\b(\d{6})\b/.exec(sent[index]?.text ?? '')?.[1] ?? '';
  return { sent, state, mailer, codeOf };
}

async function ask(codes: EmailCodes, address = 'ada@example.com') {
  const result = await codes.request(address);
  assert.ok(result.ok, JSON.stringify(result));
  return result.challenge;
}

test('the code reaches only the mail, and with the challenge and device secret it works once', async () => {
  const { sent, mailer, codeOf } = mail();
  const codes = new EmailCodes(mailer);
  const challenge = await ask(codes, ' Ada@Example.com');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, 'ada@example.com');
  assert.match(codeOf(), /^\d{6}$/);
  assert.equal(JSON.stringify(challenge).includes(codeOf()), false, 'the code is not in the reply');
  assert.equal(
    codes.redeem(challenge.challengeId, challenge.deviceSecret, codeOf()),
    'ada@example.com',
  );
  assert.equal(
    codes.redeem(challenge.challengeId, challenge.deviceSecret, codeOf()),
    undefined,
    'reused',
  );
});

test('the code from the mail is no use from another device', async () => {
  const { mailer, codeOf } = mail();
  const codes = new EmailCodes(mailer);
  const mine = await ask(codes);
  assert.equal(codes.redeem(mine.challengeId, 'a-secret-that-is-not-mine', codeOf()), undefined);
  assert.equal(codes.redeem('chl_other', mine.deviceSecret, codeOf()), undefined);
  // the guesses above counted, but one right try is still in time
  assert.equal(codes.redeem(mine.challengeId, mine.deviceSecret, codeOf()), 'ada@example.com');
});

test('five wrong tries end the challenge, even for the right code afterwards', async () => {
  const { mailer, codeOf } = mail();
  const codes = new EmailCodes(mailer);
  const c = await ask(codes);
  const wrong = codeOf() === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i += 1)
    assert.equal(codes.redeem(c.challengeId, c.deviceSecret, wrong), undefined);
  assert.equal(codes.redeem(c.challengeId, c.deviceSecret, codeOf()), undefined);
});

test('a code is good for ten minutes', async () => {
  let now = 1_000;
  const { mailer, codeOf } = mail();
  const codes = new EmailCodes(mailer, () => now);
  const c = await ask(codes);
  now += 10 * 60 * 1000 + 1;
  assert.equal(codes.redeem(c.challengeId, c.deviceSecret, codeOf()), undefined);
});

test('asking again does not cancel an earlier code, and mail is not sent faster or more often than allowed', async () => {
  let now = 1_000;
  const { sent, mailer, codeOf } = mail();
  const codes = new EmailCodes(mailer, () => now);
  const first = await ask(codes);
  const firstCode = codeOf();
  assert.deepEqual(await codes.request('ada@example.com'), { ok: false, reason: 'slow_down' });
  assert.equal(sent.length, 1);
  now += 31_000;
  // someone else asks for a code for this address: the owner's challenge still works
  const other = await ask(codes);
  assert.equal(
    codes.redeem(other.challengeId, other.deviceSecret, firstCode),
    undefined,
    'their secret, my code',
  );
  assert.equal(codes.redeem(first.challengeId, first.deviceSecret, firstCode), 'ada@example.com');
  for (let i = 0; i < 3; i += 1) {
    now += 31_000;
    await ask(codes);
  }
  assert.equal(sent.length, 5);
  now += 31_000;
  assert.deepEqual(
    await codes.request('ada@example.com'),
    { ok: false, reason: 'slow_down' },
    'six in an hour',
  );
  now += 61 * 60 * 1000;
  await ask(codes);
  // another address is not held up by the first
  await ask(codes, 'bob@example.com');
});

test('the server as a whole sends a bounded amount of mail an hour, and recovers after it', async () => {
  let now = 1_000;
  const { sent, mailer } = mail();
  const codes = new EmailCodes(mailer, () => now, 3);
  for (const who of ['a', 'b', 'c']) await ask(codes, `${who}@example.com`);
  assert.deepEqual(await codes.request('d@example.com'), { ok: false, reason: 'slow_down' });
  assert.equal(sent.length, 3);
  now += 60 * 60 * 1000 + 1;
  await ask(codes, 'd@example.com');
});

test('expired challenges are forgotten, and a full nonce table clears what has expired before anything else', async () => {
  let now = 1_000;
  const { mailer } = mail();
  const codes = new EmailCodes(mailer, () => now);
  await ask(codes);
  now += 11 * 60 * 1000;
  await ask(codes, 'bob@example.com');
  const nonces = new NonceStore(() => now);
  const stale: string[] = [];
  for (let i = 0; i < 10_000; i += 1) stale.push(nonces.issue());
  now += 11 * 60 * 1000;
  const fresh = nonces.issue();
  const live = [fresh];
  for (let i = 0; i < 9_999; i += 1) live.push(nonces.issue());
  assert.equal(nonces.consume(stale[0] ?? ''), false, 'expired');
  assert.equal(nonces.consume(fresh), true, 'every nonce issued after the sweep is still good');
  assert.equal(nonces.consume(live[9_999] ?? ''), true);
});

test('a bad address is refused and a failing mailer leaves nothing to redeem', async () => {
  const { mailer, state, codeOf } = mail();
  const codes = new EmailCodes(mailer);
  assert.deepEqual(await codes.request('not an address'), { ok: false, reason: 'invalid' });
  state.fail = true;
  assert.deepEqual(await codes.request('ada@example.com'), { ok: false, reason: 'mail_failed' });
  state.fail = false;
  assert.equal(codeOf(), '');
});
