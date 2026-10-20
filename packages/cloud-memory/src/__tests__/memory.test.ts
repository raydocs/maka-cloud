import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MAX_FACT_LENGTH, MAX_FACTS, MemoryStore } from '../index.js';

test('facts and task summaries persist, but every read and mutation is invite-scoped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-test-'));
  const path = join(dir, 'memory.db');
  let db = new DatabaseSync(path);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let memory = new MemoryStore(db);
  const alice = memory.add('alice', 'Prefer small pull requests.');
  const bob = memory.add('bob', 'Prefer detailed design notes.');
  memory.remember('alice', { id: 'same-id', conversationId: 'a', text: 'Fixed parser.' });
  memory.remember('bob', { id: 'same-id', conversationId: 'b', text: 'Updated migration.' });
  assert.equal(memory.fact('bob', alice.id), undefined);
  assert.equal(memory.edit('bob', alice.id, 'stolen'), undefined);
  assert.equal(memory.delete('bob', alice.id), false);
  assert.deepEqual(
    memory.profile('alice').facts.map((row) => [row.id, row.text]),
    [[alice.id, alice.text]],
  );
  assert.deepEqual(
    memory.profile('bob').facts.map((row) => [row.id, row.text]),
    [[bob.id, bob.text]],
  );
  assert.equal(memory.profile('alice').summaries[0]?.text, 'Fixed parser.');
  assert.equal(memory.profile('bob').summaries[0]?.text, 'Updated migration.');
  assert.deepEqual(memory.profile('unknown'), { facts: [], summaries: [] });

  assert.equal(
    memory.edit('alice', alice.id, 'Prefer focused patches.')?.text,
    'Prefer focused patches.',
  );
  memory.delete('alice', alice.id);
  db.close();
  db = new DatabaseSync(path);
  memory = new MemoryStore(db);
  assert.deepEqual(memory.profile('alice').facts, []);
  assert.throws(() => memory.add('alice', '  PREFER   FOCUSED PATCHES.  '), /forgotten_fact/);
  assert.throws(() => memory.add('alice', alice.text), /forgotten_fact/);
  assert.deepEqual(
    memory.profile('bob').facts.map((row) => [row.id, row.text]),
    [[bob.id, bob.text]],
  );
  // A tombstone belongs only to the invite that deleted it.
  assert.equal(memory.add('bob', alice.text).text, alice.text);
});

test('edited and deleted facts cannot return through replayed or new summary excerpts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const memory = new MemoryStore(db);
    const fact = memory.add('a', 'Use SQLite for local tools.');
    const duplicate = memory.add('a', 'Another preference.');
    memory.edit('a', duplicate.id, fact.text);
    memory.remember('a', {
      id: 'old',
      conversationId: 'c',
      text: `${'x'.repeat(590)} ${fact.text}`,
    });
    assert.equal(memory.profile('a').summaries.length, 1);
    memory.edit('a', fact.id, 'Use Postgres for hosted tools.');
    assert.deepEqual(
      memory.profile('a').facts.map((row) => [row.id, row.text]),
      [[fact.id, 'Use Postgres for hosted tools.']],
    );
    assert.deepEqual(memory.profile('a').summaries, [], 'even a truncated old fact is removed');
    memory.remember('a', { id: 'replayed', conversationId: 'c', text: `Earlier: ${fact.text}` });
    assert.deepEqual(memory.profile('a').summaries, []);
    memory.delete('a', fact.id);
    memory.remember('a', {
      id: 'new',
      conversationId: 'c',
      text: 'USE POSTGRES FOR HOSTED TOOLS. Done.',
    });
    assert.deepEqual(memory.profile('a'), { facts: [], summaries: [] });
    assert.ok(!memory.context('a').includes('Postgres'));
  } finally {
    db.close();
  }
});

test('profile size is bounded, additions deduplicate, and summary delivery retries are idempotent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const memory = new MemoryStore(db);
    const first = memory.add('a', 'Preference 0');
    assert.equal(memory.add('a', '  PREFERENCE   0 ').id, first.id);
    assert.throws(() => memory.add('a', ' '), /invalid_fact/);
    assert.throws(() => memory.add('a', 'x'.repeat(MAX_FACT_LENGTH + 1)), /invalid_fact/);
    memory.add('b', 'x'.repeat(MAX_FACT_LENGTH));
    for (let n = 1; n < MAX_FACTS; n += 1) memory.add('a', `Preference ${n}`);
    assert.throws(() => memory.add('a', 'One too many'), /fact_limit/);
    for (let n = 0; n < 8; n += 1) {
      const summary = { id: String(n), conversationId: 'c', text: `${n}: ${'x'.repeat(800)}` };
      memory.remember('a', summary);
      memory.remember('a', { ...summary, text: 'retry must not replace the result' });
    }
    assert.deepEqual(
      memory.profile('a').summaries.map((summary) => summary.id),
      ['7', '6', '5', '4', '3'],
    );
    assert.equal(memory.profile('a').summaries[0]?.text.length, 600);
  } finally {
    db.close();
  }
});
