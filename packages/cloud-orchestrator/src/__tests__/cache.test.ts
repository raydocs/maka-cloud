import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedCache } from '../cache.js';

test('the least recently used entry goes first and a read refreshes an entry', () => {
  const cache = new BoundedCache<string, number>({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('the byte ceiling evicts old entries and skips an entry that can never fit', () => {
  const cache = new BoundedCache<string, string>({ maxEntries: 10, maxBytes: 10 }, (v) => v.length);
  cache.set('a', '1234');
  cache.set('b', '1234');
  cache.set('c', '1234');
  assert.equal(cache.get('a'), undefined);
  assert.ok(cache.bytes <= 10);
  cache.set('huge', 'x'.repeat(11));
  assert.equal(cache.get('huge'), undefined);
  assert.equal(cache.size, 2);
});

test('replacing and deleting keep the byte count exact', () => {
  const cache = new BoundedCache<string, string>({ maxEntries: 5, maxBytes: 100 }, (v) => v.length);
  cache.set('a', '12345');
  cache.set('a', '123');
  assert.equal(cache.bytes, 3);
  cache.delete('a');
  cache.delete('a');
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
});

test('zero entries turns the cache off', () => {
  const cache = new BoundedCache<string, number>({ maxEntries: 0 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});
