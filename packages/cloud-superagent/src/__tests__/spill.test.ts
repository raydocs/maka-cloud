import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INLINE_MEMORY_CHARS, recallMemory, spillMemory } from '../spill.js';
import { github, issuePayload, rig, TENANT } from './harness.js';

test('overflow memory is spilled and recall concatenates it', () => {
  const long = 'abcdefghij'.repeat(800);
  assert.ok(long.length > INLINE_MEMORY_CHARS);
  const spilled = spillMemory(long, [], 9);
  assert.equal(spilled.inline.length, INLINE_MEMORY_CHARS);
  assert.equal(spilled.spills.length > 0, true);
  assert.equal(recallMemory({ memory: spilled.inline, spills: spilled.spills }), long);
});

test('a worker that writes a long memory keeps an inline window in sqlite-shaped state', async () => {
  const { agent, handler } = rig();
  const long = `note ${'x'.repeat(5_000)}`;
  handler.script = () => ({ memory: long, progress: true });
  const opened = await agent.ingest(github(TENANT, 'spill', 'issues', issuePayload('opened', 5)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  assert.ok(worker.memory.length <= INLINE_MEMORY_CHARS);
  assert.ok((worker.spills ?? []).length > 0);
  assert.equal(recallMemory(worker), long);
});
