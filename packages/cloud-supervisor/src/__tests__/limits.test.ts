import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueDigestSlot, inQuietHours, DEFAULT_SETTINGS } from '../settings.js';
import { Gate, HOUR, MINUTE, rig } from './harness.js';

const at = (hour: number, minute = 0, day = 19) => Date.UTC(2026, 9, day, hour, minute);

test('the hourly cap holds interrupts back, never the items, and releases them as one batch', async () => {
  const r = await rig({ settings: { maxInterruptsPerHour: 2 } });
  for (const id of ['q1', 'q2', 'q3', 'q4']) await r.question(id);
  assert.equal(r.host.interrupts.length, 2, 'two pushes, then the cap');
  assert.equal(r.supervisor.listItems().items.length, 4, 'every item is in the inbox');

  r.clock.advance(30 * MINUTE);
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 2, 'still inside the hour');

  r.clock.advance(31 * MINUTE);
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 3);
  const batch = r.host.interrupts[2];
  assert.equal(batch?.batch, true);
  assert.equal(batch?.items.length, 2, 'the two held items go out together');
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 3, 'nothing is pushed twice');
  await r.stop();
});

test('items arriving together cannot exceed the cap, even while a push is still being sent', async () => {
  const r = await rig({ settings: { maxInterruptsPerHour: 2 } });
  const gate = new Gate();
  r.host.script.interrupt = () => gate.promise;
  for (const id of ['q1', 'q2', 'q3']) {
    r.host.feed.append(
      'conductor.question',
      'cnv_1',
      {
        questionId: id,
        reason: 'taste',
        question: id,
        options: [{ id: 'a', label: 'A' }],
        recommended: 'a',
      },
      r.clock.t,
      { notify: false },
    );
  }
  // The first pass decides q1 and waits inside the notifier; a second pass starts meanwhile.
  const first = r.supervisor.tick();
  const second = r.supervisor.tick();
  gate.resolve();
  await Promise.all([first, second]);
  await r.supervisor.settled();
  const singles = r.host.interrupts.filter((interrupt) => !interrupt.batch);
  assert.equal(singles.length, 2, 'exactly the cap');
  assert.equal(r.supervisor.listItems().items.length, 3);
  await r.stop();
});

test('quiet hours hold the push until they end; the item is listed the whole time', async () => {
  const clock = new (await import('./harness.js')).Clock(at(23, 0));
  const r = await rig({ clock, settings: { quietHours: { start: '22:00', end: '07:00' } } });
  await r.question('q1');
  assert.equal(r.host.interrupts.length, 0);
  assert.equal(r.supervisor.listItems().items.length, 1);
  clock.t = at(6, 59, 20);
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 0);
  clock.t = at(7, 0, 20);
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 1);
  assert.equal(r.host.interrupts[0]?.batch, true);
  await r.stop();
});

test('a muted kind is listed and unblocks nothing, but never pushes, also after it is unmuted', async () => {
  const r = await rig();
  r.supervisor.setMute('budget', true);
  await r.question('q_budget', 'budget_overrun');
  await r.question('q_taste', 'taste');
  assert.equal(r.host.interrupts.length, 1, 'only the taste question pushed');
  assert.equal(r.host.interrupts[0]?.items[0]?.kind, 'decision');
  const budget = r.supervisor.listItems().items.find((item) => item.kind === 'budget');
  assert.equal(
    budget?.state,
    'open',
    'a muted budget question still blocks its conversation and is listed',
  );
  r.supervisor.setMute('budget', false);
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 1, 'unmuting does not replay what was muted');
  await r.question('q_budget2', 'budget_overrun');
  assert.equal(r.host.interrupts.length, 2, 'new budget questions push again');
  await r.stop();
});

test('a notifier that throws is reported and the item is not pushed again', async () => {
  const r = await rig();
  r.host.script.interrupt = async () => {
    throw new Error('channel down');
  };
  await r.question('q1');
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 1, 'tried once');
  assert.ok(r.host.warnings.some((message) => message.includes('Notifying')));
  assert.equal(r.supervisor.listItems().items.length, 1, 'the inbox still lists it');
  await r.stop();
});

test('settings are validated and persist', async () => {
  const r = await rig();
  assert.throws(() => r.supervisor.setSettings({ timeZone: 'Not/AZone' }));
  assert.throws(() => r.supervisor.setSettings({ digestAt: '8am' }));
  assert.throws(() => r.supervisor.setSettings({ maxInterruptsPerHour: 0 }));
  const next = r.supervisor.setSettings({
    stallAfterMinutes: 5,
    quietHours: { start: '01:00', end: '02:00' },
  });
  assert.equal(next.stallAfterMinutes, 5);
  assert.equal(r.supervisor.getSettings().quietHours?.start, '01:00');
  await r.stop();
});

test('quiet hours wrap midnight, equal bounds are never quiet, and the zone decides the hour', () => {
  const wrap = { ...DEFAULT_SETTINGS, quietHours: { start: '22:00', end: '07:00' } };
  assert.equal(inQuietHours(wrap, at(21, 59)), false);
  assert.equal(inQuietHours(wrap, at(22, 0)), true);
  assert.equal(inQuietHours(wrap, at(3, 0)), true);
  assert.equal(inQuietHours(wrap, at(7, 0)), false);
  const same = { ...DEFAULT_SETTINGS, quietHours: { start: '09:00', end: '09:00' } };
  assert.equal(inQuietHours(same, at(9, 0)), false);
  const tokyo = { ...wrap, timeZone: 'Asia/Tokyo' };
  assert.equal(inQuietHours(tokyo, at(13, 30)), true, '13:30 UTC is 22:30 in Tokyo');
  assert.equal(inQuietHours(tokyo, at(3, 0)), false, '03:00 UTC is noon in Tokyo');
});

test('the digest slot is the local date once the digest time has passed', () => {
  const settings = { ...DEFAULT_SETTINGS, digestAt: '08:00', timeZone: 'Asia/Tokyo' };
  assert.equal(dueDigestSlot(settings, at(22, 59)), undefined, '07:59 in Tokyo, the next day');
  assert.equal(dueDigestSlot(settings, at(23, 0)), '2026-10-20', '08:00 in Tokyo is the 20th');
  assert.equal(dueDigestSlot({ ...settings, digestAt: null }, at(23, 0)), undefined);
  assert.equal(HOUR, 60 * MINUTE);
});
