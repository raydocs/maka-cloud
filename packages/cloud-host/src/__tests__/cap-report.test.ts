import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapEvent } from '@maka-cloud/gateway';
import { capReporter } from '../cap-report.js';

const NOON = Date.parse('2026-10-20T12:00:00Z');

interface Rig {
  report: (event: CapEvent) => void;
  raised: { conversationId: string; taskId?: string; key: string; ask: string }[];
  notices: { conversationId: string; text: string }[];
  warnings: string[];
  clock: { now: number };
  /** Makes the next notice fail. */
  failNotice: { on: boolean };
  /** Makes raising throw. */
  failRaise: { on: boolean };
}

function rig(): Rig {
  const raised: Rig['raised'] = [];
  const notices: Rig['notices'] = [];
  const warnings: string[] = [];
  const clock = { now: NOON };
  const failNotice = { on: false };
  const failRaise = { on: false };
  const report = capReporter({
    raise: (input) => {
      if (failRaise.on) throw new Error('inbox closed');
      raised.push(input);
    },
    notice: async (conversationId, text) => {
      if (failNotice.on) throw new Error('feed closed');
      notices.push({ conversationId, text });
    },
    warn: (message) => warnings.push(message),
    now: () => clock.now,
  });
  return { report, raised, notices, warnings, clock, failNotice, failRaise };
}

const daily = (conversationId: string | undefined, inviteId = 'inv_a'): CapEvent => ({
  cap: { scope: 'invite_daily', inviteId, limitUsd: 5 },
  subject: 'task tsk_1',
  account: { inviteId },
  ...(conversationId === undefined ? {} : { conversationId }),
  taskId: 'tsk_1',
});

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a cap hit raises one budget item and tells the conversation, in words that name the limit', async () => {
  const r = rig();
  r.report(daily('cnv_1'));
  await settled();
  assert.equal(r.raised.length, 1);
  assert.equal(r.raised[0]?.conversationId, 'cnv_1');
  assert.equal(r.raised[0]?.taskId, 'tsk_1');
  assert.equal(r.raised[0]?.key, 'invite_daily:inv_a:2026-10-20');
  assert.match(r.raised[0]?.ask ?? '', /daily spending limit of \$5\.00 is used up/u);
  assert.deepEqual(r.notices, [{ conversationId: 'cnv_1', text: r.raised[0]?.ask }]);
});

test('the same limit in the same period tells a conversation once, and the next period again', async () => {
  const r = rig();
  r.report(daily('cnv_1'));
  r.report(daily('cnv_1'));
  await settled();
  assert.equal(r.notices.length, 1);
  // The item key is the same, so the supervisor opens one item for both.
  assert.equal(r.raised[0]?.key, r.raised[1]?.key);
  r.clock.now = Date.parse('2026-10-21T00:00:01Z');
  r.report(daily('cnv_1'));
  await settled();
  assert.equal(r.notices.length, 2);
  assert.equal(r.raised[2]?.key, 'invite_daily:inv_a:2026-10-21');
});

test('the monthly limit keys on the month and says when it resets', async () => {
  const r = rig();
  r.report({
    ...daily('cnv_1'),
    cap: { scope: 'invite_monthly', inviteId: 'inv_a', limitUsd: 50 },
  });
  await settled();
  assert.equal(r.raised[0]?.key, 'invite_monthly:inv_a:2026-10');
  assert.match(r.notices[0]?.text ?? '', /monthly spending limit of \$50\.00/u);
  assert.match(r.notices[0]?.text ?? '', /first of next month/u);
});

test('the server-wide limit tells each conversation and gives each its own item', async () => {
  const r = rig();
  const server = (conversationId: string, inviteId: string): CapEvent => ({
    ...daily(conversationId, inviteId),
    cap: { scope: 'server_daily', limitUsd: 25 },
  });
  r.report(server('cnv_1', 'inv_a'));
  r.report(server('cnv_2', 'inv_b'));
  await settled();
  assert.deepEqual(r.raised.map((item) => item.key).sort(), [
    'server_daily:cnv_1:2026-10-20',
    'server_daily:cnv_2:2026-10-20',
  ]);
  assert.deepEqual(r.notices.map((n) => n.conversationId).sort(), ['cnv_1', 'cnv_2']);
});

test("one invite's cap never raises an item under another invite's key", async () => {
  const r = rig();
  r.report(daily('cnv_1', 'inv_a'));
  r.report(daily('cnv_2', 'inv_b'));
  await settled();
  assert.deepEqual(r.raised.map((item) => item.key).sort(), [
    'invite_daily:inv_a:2026-10-20',
    'invite_daily:inv_b:2026-10-20',
  ]);
});

test('a cap that no conversation can be told about is warned, not thrown and not silent', async () => {
  const r = rig();
  r.report(daily(undefined));
  await settled();
  assert.deepEqual(r.raised, []);
  assert.deepEqual(r.notices, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0] ?? '', /no conversation could be told/u);
});

test('an inbox that cannot take the item still tells the conversation, and warns', async () => {
  const r = rig();
  r.failRaise.on = true;
  r.report(daily('cnv_1'));
  await settled();
  assert.equal(r.notices.length, 1);
  assert.match(r.warnings.join('\n'), /inbox item could not be raised/u);
});

test('a notice that failed is tried again by the next hit', async () => {
  const r = rig();
  r.failNotice.on = true;
  r.report(daily('cnv_1'));
  await settled();
  assert.equal(r.notices.length, 0);
  assert.match(r.warnings.join('\n'), /conversation could not be told/u);
  r.failNotice.on = false;
  r.report(daily('cnv_1'));
  await settled();
  assert.equal(r.notices.length, 1);
});
