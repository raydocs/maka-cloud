import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SummaryModel } from '../host.js';
import { FakeHost, Gate, HOUR, MANIFEST, MINUTE, ScriptedSummary, rig, tmpDb } from './harness.js';

async function twoItems(r: Awaited<ReturnType<typeof rig>>) {
  await r.question('q1', 'taste');
  await r.question('q2', 'irreversible');
  await r.taskCreated('t', { title: 'research' });
  await r.taskEvent({ type: 'task_succeeded', taskId: 't', manifest: MANIFEST });
  return r.supervisor.listItems({ state: 'all' }).items.map((item) => item.itemId);
}

test('the digest lists every item, urgent ones first, with a template summary when there is no model', async () => {
  const r = await rig();
  const ids = await twoItems(r);
  const digest = await r.supervisor.digest();
  assert.equal(digest.items.length, ids.length);
  assert.deepEqual([...digest.items.map((item) => item.itemId)].sort(), [...ids].sort());
  assert.equal(digest.items.at(-1)?.kind, 'finished');
  assert.match(digest.summary, /2 waiting on you\. 1 finished/);
  await r.stop();
});

test('a summary model can reorder but never add, drop or repeat an item', async () => {
  for (const answer of [
    (ids: string[]) => ({ order: [...ids].reverse(), summary: 'Reversed.' }),
    (ids: string[]) => ({ order: [ids[2], 'itm_invented', ids[2]], summary: 'Partial.' }),
    () => ({ order: [], summary: 'Empty.' }),
    () => ({ order: 'not a list', summary: 7 }),
    () => null,
  ]) {
    const known: string[] = [];
    const model = new ScriptedSummary((input) => {
      known.splice(0, known.length, ...input.items.map((item) => item.id));
      return (answer as (ids: string[]) => unknown)(known);
    });
    const r = await rig({ summary: model });
    const ids = await twoItems(r);
    const digest = await r.supervisor.digest();
    assert.deepEqual([...digest.items.map((item) => item.itemId)].sort(), [...ids].sort());
    assert.equal(new Set(digest.items.map((item) => item.itemId)).size, ids.length);
    assert.equal(digest.counts.open, 2, 'the model cannot change what is waiting');
    assert.equal(r.host.interrupts.length, 2, 'nor what interrupted');
    await r.stop();
  }
});

test('a summary that throws or times out falls back to the template and warns', async () => {
  const throwing: SummaryModel = {
    summarize: async () => {
      throw new Error('model down');
    },
  };
  const a = await rig({ summary: throwing });
  await twoItems(a);
  const first = await a.supervisor.digest();
  assert.match(first.summary, /2 waiting on you/);
  assert.ok(a.host.warnings.some((message) => message.includes('digest summary failed')));
  await a.stop();

  const hanging: SummaryModel = {
    summarize: (_input, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  };
  const b = await rig({ summary: hanging, summaryTimeoutMs: 5 });
  await twoItems(b);
  // AbortSignal.timeout does not keep the event loop alive, so hold it open while the timeout runs.
  const keepAlive = setInterval(() => {}, 1000);
  const second = await b.supervisor.digest().finally(() => clearInterval(keepAlive));
  assert.match(second.summary, /2 waiting on you/);
  assert.equal(second.items.length, 3);
  await b.stop();
});

test('an on-request digest is stored and published once', async () => {
  const r = await rig();
  await twoItems(r);
  const digest = await r.supervisor.digest();
  const published = r.host.published.filter((event) => event.kind === 'inbox.digest');
  assert.equal(published.length, 1);
  assert.equal(published[0]?.data.digestId, digest.digestId);
  await r.supervisor.tick();
  assert.equal(r.host.published.filter((event) => event.kind === 'inbox.digest').length, 1);
  await r.stop();
});

test('the daily slot is claimed once across ticks and restarts', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const model = new ScriptedSummary((input) => ({
    order: input.items.map((item) => item.id),
    summary: 'Daily.',
  }));
  const first = await rig({ host, dbPath, summary: model, settings: { digestAt: '08:00' } });
  await twoItems(first);
  await first.supervisor.tick();
  await first.supervisor.tick();
  assert.equal(model.calls, 1);
  await first.stop();

  const second = await rig({
    host,
    dbPath,
    clock: first.clock,
    summary: model,
    settings: { digestAt: '08:00' },
  });
  await second.supervisor.tick();
  assert.equal(model.calls, 1, 'the same slot is not built again after a restart');
  assert.equal(host.published.filter((event) => event.kind === 'inbox.digest').length, 1);

  second.clock.advance(24 * HOUR);
  await second.supervisor.tick();
  assert.equal(model.calls, 2, 'the next day has its own slot');
  await second.stop();
});

test('a slot claimed by a process that stopped mid-build is completed after the restart, once', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const entered = new Gate();
  const stuck: SummaryModel = {
    summarize: (_input, signal) => {
      entered.resolve();
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('stopped'))),
      );
    },
  };
  const first = await rig({ host, dbPath, summary: stuck, settings: { digestAt: '08:00' } });
  await twoItems(first);
  const ticking = first.supervisor.tick();
  await entered.promise;
  await first.stop();
  await ticking;
  assert.equal(host.published.filter((event) => event.kind === 'inbox.digest').length, 0);

  const model = new ScriptedSummary((input) => ({
    order: input.items.map((item) => item.id),
    summary: 'Recovered.',
  }));
  const second = await rig({
    host,
    dbPath,
    clock: first.clock,
    summary: model,
    settings: { digestAt: '08:00' },
  });
  await second.supervisor.tick();
  await second.supervisor.tick();
  assert.equal(model.calls, 1);
  const published = host.published.filter((event) => event.kind === 'inbox.digest');
  assert.equal(published.length, 1);
  assert.equal(published[0]?.data.summary, 'Recovered.');
  await second.stop();
});

test('before the digest time nothing is built', async () => {
  const model = new ScriptedSummary(() => ({ order: [], summary: 'x' }));
  const r = await rig({ summary: model, settings: { digestAt: '23:30' } });
  await twoItems(r);
  r.clock.advance(MINUTE);
  await r.supervisor.tick();
  assert.equal(model.calls, 0);
  await r.stop();
});

function ownedHost(owners: Record<string, string>): FakeHost {
  const host = new FakeHost();
  host.ownerOf = (conversationId) => owners[conversationId];
  return host;
}

async function itemsOf(r: Awaited<ReturnType<typeof rig>>, conversation: string, id: string) {
  await r.question(id, 'taste', conversation);
}

test('with owners, each owner gets a digest of their own items, summarized by a call that is theirs', async () => {
  const host = ownedHost({ cnv_a: 'inv_a', cnv_b: 'inv_b' });
  const model = new ScriptedSummary((input) => ({
    order: input.items.map((item) => item.id),
    summary: `Summary of ${input.items.length}.`,
  }));
  const r = await rig({ host, summary: model, settings: { digestAt: '08:00' } });
  await itemsOf(r, 'cnv_a', 'qa1');
  await itemsOf(r, 'cnv_a', 'qa2');
  await itemsOf(r, 'cnv_b', 'qb1');
  await itemsOf(r, 'cnv_x', 'qx1'); // nobody owns it
  const idsOf = (conversation: string) =>
    r.supervisor
      .listItems({ state: 'all', conversations: [conversation] })
      .items.map((item) => item.itemId)
      .sort();
  r.clock.advance(9 * HOUR);
  await r.supervisor.tick();

  const byOwner = new Map(model.seen.map((call) => [call.owner, call.ids.sort()]));
  assert.deepEqual(
    [...byOwner.keys()].sort(),
    ['inv_a', 'inv_b'],
    'the unowned digest asks no model',
  );
  assert.deepEqual(byOwner.get('inv_a'), idsOf('cnv_a'), 'only their own items reach their call');
  assert.deepEqual(byOwner.get('inv_b'), idsOf('cnv_b'));
  const published = host.published.filter((event) => event.kind === 'inbox.digest');
  assert.equal(published.length, 3, 'one for each owner and one for what nobody owns');
  const unowned = published.find((event) => event.data.items.length === 1);
  assert.match(unowned?.data.summary ?? '', /1 waiting on you/u, 'the template, not a model');
  await r.stop();
});

test('items nobody owns get the template and no model call, when the host knows owners', async () => {
  const model = new ScriptedSummary(() => ({ order: [], summary: 'x' }));
  const r = await rig({ host: ownedHost({}), summary: model });
  await itemsOf(r, 'cnv_x', 'qx1');
  const digest = await r.supervisor.digest();
  assert.equal(digest.items.length, 1);
  assert.deepEqual(model.seen, [], 'no model call: nobody owns these items');
  assert.match(digest.summary, /1 waiting on you/u);
  await r.stop();
});

test('one owner whose summary is refused gets the template; another owner still gets their summary', async () => {
  const host = ownedHost({ cnv_a: 'inv_capped', cnv_b: 'inv_open' });
  const model: SummaryModel = {
    summarize: async (input, _signal, owner) => {
      if (owner === 'inv_capped')
        throw new Error('this invite’s daily limit cannot cover this request');
      return { order: input.items.map((item) => item.id), summary: 'Model summary.' };
    },
  };
  const r = await rig({ host, summary: model });
  await itemsOf(r, 'cnv_a', 'qa');
  await itemsOf(r, 'cnv_b', 'qb');
  const capped = await r.supervisor.digest('inv_capped');
  const open = await r.supervisor.digest('inv_open');
  assert.match(capped.summary, /1 waiting on you/u);
  assert.equal(open.summary, 'Model summary.');
  assert.equal(capped.items.length, 1);
  assert.ok(host.warnings.some((message) => message.includes('digest summary failed')));
  await r.stop();
});

test('each owner’s daily slot is claimed once across ticks and restarts, and the next day has its own', async () => {
  const dbPath = tmpDb();
  const host = ownedHost({ cnv_a: 'inv_a', cnv_b: 'inv_b' });
  const model = new ScriptedSummary((input) => ({
    order: input.items.map((item) => item.id),
    summary: 'Daily.',
  }));
  const first = await rig({ host, dbPath, summary: model, settings: { digestAt: '08:00' } });
  await itemsOf(first, 'cnv_a', 'qa');
  await itemsOf(first, 'cnv_b', 'qb');
  first.clock.advance(9 * HOUR);
  await first.supervisor.tick();
  await first.supervisor.tick();
  assert.equal(model.calls, 2);
  await first.stop();

  const second = await rig({
    host,
    dbPath,
    clock: first.clock,
    summary: model,
    settings: { digestAt: '08:00' },
  });
  await second.supervisor.tick();
  assert.equal(model.calls, 2, 'a restart builds nothing again');
  second.clock.advance(24 * HOUR);
  await second.supervisor.tick();
  assert.equal(model.calls, 4);
  await second.stop();
});

test('a digest stopped mid-build keeps its owner, and the restart completes it for that owner', async () => {
  const dbPath = tmpDb();
  const host = ownedHost({ cnv_a: 'inv_a' });
  const entered = new Gate();
  const stuck: SummaryModel = {
    summarize: (_input, signal) => {
      entered.resolve();
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('stopped'))),
      );
    },
  };
  const first = await rig({ host, dbPath, summary: stuck, settings: { digestAt: '08:00' } });
  await itemsOf(first, 'cnv_a', 'qa');
  first.clock.advance(9 * HOUR);
  const ticking = first.supervisor.tick();
  await entered.promise;
  await first.stop();
  await ticking;

  const model = new ScriptedSummary((input) => ({
    order: input.items.map((item) => item.id),
    summary: 'Recovered.',
  }));
  const second = await rig({
    host,
    dbPath,
    clock: first.clock,
    summary: model,
    settings: { digestAt: '08:00' },
  });
  await second.supervisor.tick();
  assert.deepEqual(
    model.seen.map((call) => call.owner),
    ['inv_a'],
  );
  await second.stop();
});

test('a supervisor database from before digests had owners is upgraded in place and keeps its digests', async () => {
  const dbPath = tmpDb();
  const first = await rig({ dbPath });
  await twoItems(first);
  const before = await first.supervisor.digest();
  await first.stop();
  // Put the file back to schema 3, as an older build left it.
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('ALTER TABLE digests DROP COLUMN owner');
  old.exec('PRAGMA user_version = 3');
  old.close();
  const second = await rig({ dbPath, clock: first.clock });
  const after = await second.supervisor.digest();
  assert.equal(after.items.length, before.items.length);
  await second.stop();
});
