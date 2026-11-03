import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  MemoryOutboxStore,
  Outbox,
  type OutboxHandler,
  type OutboxItem,
  type OutboxStore,
  outboxBackoffMs,
  PermanentOutboxError,
  SqliteOutboxStore,
} from '../outbox.js';

const T0 = 1_000_000;

function input(sessionKey: string, n: number, kind = 'comment') {
  return {
    tenantId: 't1',
    sessionKey,
    kind,
    payload: JSON.stringify({ n }),
    idempotencyKey: `${sessionKey}:${n}`,
  };
}

function make(
  store: OutboxStore = new MemoryOutboxStore(),
  extra: Partial<ConstructorParameters<typeof Outbox>[0]> = {},
) {
  let ids = 0;
  return new Outbox({
    store,
    now: () => T0,
    random: () => 0.5,
    newId: () => `id-${++ids}`,
    ...extra,
  });
}

function recorder() {
  const seen: string[] = [];
  const handler: OutboxHandler = async (item) => {
    seen.push(item.idempotencyKey);
  };
  return { seen, handler };
}

test('enqueue is idempotent per tenant and key', () => {
  const outbox = make();
  const first = outbox.enqueue(input('s1', 1));
  const again = outbox.enqueue({ ...input('s1', 1), payload: '{"changed":true}' });
  assert.equal(again.id, first.id);
  assert.equal(again.payload, first.payload);
  assert.equal(outbox.list().length, 1);
  const other = outbox.enqueue({ ...input('s1', 1), tenantId: 't2' });
  assert.notEqual(other.id, first.id);
  assert.equal(first.state, 'pending');
  assert.equal(first.attempts, 0);
  assert.equal(first.nextAt, T0);
});

test('items of one session are delivered oldest first', async () => {
  const outbox = make();
  for (const n of [1, 2, 3]) outbox.enqueue(input('s1', n));
  const { seen, handler } = recorder();
  const result = await outbox.drain({ comment: handler }, T0);
  assert.deepEqual(seen, ['s1:1', 's1:2', 's1:3']);
  assert.equal(result.delivered, 3);
  assert.deepEqual(
    outbox.list().map((item) => item.state),
    ['done', 'done', 'done'],
  );
  assert.equal(outbox.list()[0]?.doneAt, T0);
});

test('a failing head blocks only its own session', async () => {
  const outbox = make();
  outbox.enqueue(input('s1', 1));
  outbox.enqueue(input('s1', 2));
  outbox.enqueue(input('s2', 1));
  outbox.enqueue(input('s2', 2));
  const seen: string[] = [];
  const handler: OutboxHandler = async (item) => {
    if (item.idempotencyKey === 's1:1') throw new Error('github 502');
    seen.push(item.idempotencyKey);
  };
  const result = await outbox.drain({ comment: handler }, T0);
  assert.deepEqual(seen, ['s2:1', 's2:2']);
  assert.equal(result.failed, 1);
  const s1 = outbox.list({ sessionKey: 's1' });
  assert.equal(s1[0]?.state, 'pending');
  assert.equal(s1[0]?.attempts, 1);
  assert.equal(s1[0]?.lastError, 'github 502');
  assert.equal(s1[1]?.state, 'pending');
  assert.equal(s1[1]?.attempts, 0);

  // Before nextAt nothing of s1 runs, not even the second item.
  const early = await outbox.drain({ comment: handler }, T0 + 10);
  assert.equal(early.delivered, 0);
  assert.deepEqual(seen, ['s2:1', 's2:2']);

  // Once due and healthy again, the head goes first, then the rest.
  const healthy = recorder();
  await outbox.drain({ comment: healthy.handler }, T0 + 750);
  assert.deepEqual(healthy.seen, ['s1:1', 's1:2']);
});

test('a kind without a handler stays pending and blocks its session', async () => {
  const outbox = make();
  outbox.enqueue(input('s1', 1, 'push'));
  outbox.enqueue(input('s1', 2, 'comment'));
  const { seen, handler } = recorder();
  const result = await outbox.drain({ comment: handler }, T0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(seen, []);
  assert.equal(outbox.list()[0]?.attempts, 0);
});

test('backoff doubles from one second with a fixed jitter', async () => {
  let now = T0;
  const outbox = make(new MemoryOutboxStore(), { maxAttempts: 20 });
  const item = outbox.enqueue(input('s1', 1));
  const failing: OutboxHandler = async () => {
    throw new Error('down');
  };
  // random() = 0.5 scales the delay to 0.75 of the raw value.
  const expected = [750, 1500, 3000, 6000, 12000, 24000, 48000, 96000, 192000, 225000];
  const raws = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000];
  for (const [i, delay] of expected.entries()) {
    await outbox.drain({ comment: failing }, now);
    const row = outbox.get(item.id);
    assert.equal(row?.attempts, i + 1);
    assert.equal(row?.nextAt, now + delay, `retry ${i + 1}`);
    assert.equal(
      outboxBackoffMs(i + 1, () => 0.5),
      delay,
    );
    assert.equal(
      outboxBackoffMs(i + 1, () => 0),
      raws[i]! / 2,
    );
    assert.equal(
      outboxBackoffMs(i + 1, () => 1),
      raws[i],
    );
    now = row?.nextAt ?? now;
  }
});

test('backoff is capped at five minutes', () => {
  for (const attempts of [10, 11, 30, 500]) {
    assert.equal(
      outboxBackoffMs(attempts, () => 1),
      300_000,
    );
    assert.equal(
      outboxBackoffMs(attempts, () => 0),
      150_000,
    );
  }
});

test('an item goes dead after maxAttempts and onDead fires once', async () => {
  const dead: OutboxItem[] = [];
  const outbox = make(new MemoryOutboxStore(), {
    maxAttempts: 3,
    onDead: (item) => {
      dead.push(item);
    },
  });
  outbox.enqueue(input('s1', 1));
  outbox.enqueue(input('s1', 2));
  const calls: string[] = [];
  const handler: OutboxHandler = async (item) => {
    calls.push(item.idempotencyKey);
    if (item.idempotencyKey === 's1:1') throw new Error('still down');
  };
  let now = T0;
  for (let i = 0; i < 3; i += 1) {
    await outbox.drain({ comment: handler }, now);
    now += 10 * 60_000;
  }
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.idempotencyKey, 's1:1');
  assert.equal(dead[0]?.state, 'dead');
  assert.equal(dead[0]?.attempts, 3);
  assert.equal(dead[0]?.lastError, 'still down');
  assert.equal(outbox.list()[0]?.state, 'dead');
  // The dead head stops blocking: the later item is delivered, the dead one is not retried.
  assert.equal(outbox.list()[1]?.state, 'done');
  assert.deepEqual(calls, ['s1:1', 's1:1', 's1:1', 's1:2']);
  await outbox.drain({ comment: handler }, now);
  assert.equal(calls.length, 4);
  assert.equal(dead.length, 1);
});

test('a permanent error is dead on the first attempt', async () => {
  const dead: OutboxItem[] = [];
  const outbox = make(new MemoryOutboxStore(), { onDead: (item) => void dead.push(item) });
  outbox.enqueue(input('s1', 1));
  const result = await outbox.drain(
    {
      comment: async () => {
        throw new PermanentOutboxError('422 validation failed');
      },
    },
    T0,
  );
  assert.equal(result.dead, 1);
  assert.equal(outbox.list()[0]?.state, 'dead');
  assert.equal(outbox.list()[0]?.attempts, 1);
  assert.equal(dead[0]?.lastError, '422 validation failed');
});

test('an onDead failure is reported and the item stays dead', async () => {
  const outbox = make(new MemoryOutboxStore(), {
    onDead: () => {
      throw new Error('card store down');
    },
  });
  outbox.enqueue(input('s1', 1));
  const result = await outbox.drain(
    {
      comment: async () => {
        throw new PermanentOutboxError('nope');
      },
    },
    T0,
  );
  assert.deepEqual(result.callbackErrors, ['card store down']);
  assert.equal(outbox.list()[0]?.state, 'dead');
});

test('done items are never redelivered', async () => {
  const outbox = make();
  outbox.enqueue(input('s1', 1));
  const { seen, handler } = recorder();
  await outbox.drain({ comment: handler }, T0);
  await outbox.drain({ comment: handler }, T0 + 60_000);
  assert.deepEqual(seen, ['s1:1']);
  // Enqueueing the same key again does not revive it.
  const again = outbox.enqueue(input('s1', 1));
  assert.equal(again.state, 'done');
  await outbox.drain({ comment: handler }, T0 + 120_000);
  assert.deepEqual(seen, ['s1:1']);
});

test('sqlite store keeps the same behaviour', async () => {
  const db = new DatabaseSync(':memory:');
  const outbox = make(new SqliteOutboxStore(db));
  const first = outbox.enqueue(input('s1', 1));
  assert.equal(outbox.enqueue(input('s1', 1)).id, first.id);
  outbox.enqueue(input('s1', 2));
  outbox.enqueue(input('s2', 1));
  const handler: OutboxHandler = async (item) => {
    if (item.idempotencyKey === 's1:1') throw new Error('boom');
  };
  await outbox.drain({ comment: handler }, T0);
  const rows = outbox.list();
  assert.deepEqual(
    rows.map((row) => [row.idempotencyKey, row.state, row.attempts]),
    [
      ['s1:1', 'pending', 1],
      ['s1:2', 'pending', 0],
      ['s2:1', 'done', 1],
    ],
  );
  assert.equal(rows[0]?.nextAt, T0 + 750);
  assert.equal(rows[0]?.lastError, 'boom');
  assert.ok(rows.every((row, i) => i === 0 || row.seq > (rows[i - 1]?.seq ?? 0)));
  db.close();
});

test('sqlite outbox survives a restart and delivers once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    const file = join(dir, 'super.db');
    const db1 = new DatabaseSync(file);
    const before = make(new SqliteOutboxStore(db1));
    before.enqueue(input('s1', 1));
    before.enqueue(input('s1', 2));
    before.enqueue(input('s2', 1));
    // One failed attempt is persisted too.
    await before.drain(
      {
        comment: async (item) => {
          if (item.idempotencyKey === 's2:1') throw new Error('offline');
        },
      },
      T0,
    );
    db1.close();

    const db2 = new DatabaseSync(file);
    const after = make(new SqliteOutboxStore(db2));
    const { seen, handler } = recorder();
    // s2:1 is not due yet; its retry time survived the restart.
    await after.drain({ comment: handler }, T0 + 100);
    assert.deepEqual(seen, []);
    // s1 was delivered before the restart, so only s2:1 is left.
    assert.equal(after.list({ state: 'pending' }).length, 1);
    await after.drain({ comment: handler }, T0 + 750);
    assert.deepEqual(seen, ['s2:1']);
    await after.drain({ comment: handler }, T0 + 10_000);
    assert.deepEqual(seen, ['s2:1']);
    assert.deepEqual(
      after.list().map((row) => row.state),
      ['done', 'done', 'done'],
    );
    db2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite outbox delivers pending items after a restart without redelivering done ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    const file = join(dir, 'super.db');
    const db1 = new DatabaseSync(file);
    const before = make(new SqliteOutboxStore(db1));
    before.enqueue(input('s1', 1));
    before.enqueue(input('s1', 2));
    await before.drain(
      {
        comment: async (item) => {
          if (item.idempotencyKey === 's1:2') throw new Error('crash');
        },
      },
      T0,
    );
    db1.close();

    const db2 = new DatabaseSync(file);
    const after = make(new SqliteOutboxStore(db2));
    assert.equal(after.enqueue(input('s1', 1)).state, 'done');
    const { seen, handler } = recorder();
    await after.drain({ comment: handler }, T0 + 1_000);
    assert.deepEqual(seen, ['s1:2']);
    db2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('opening the sqlite store twice keeps rows and does not bump user_version', () => {
  const db = new DatabaseSync(':memory:');
  const before = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  make(new SqliteOutboxStore(db)).enqueue(input('s1', 1));
  const reopened = make(new SqliteOutboxStore(db));
  assert.equal(reopened.list().length, 1);
  const after = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(after, before);
  db.close();
});
