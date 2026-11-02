import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RustHostEngine } from '../rust-host.js';
import { TsInProcessEngine } from '../ts-in-process.js';

const unusedBackend = {
  prepare: async () => ({
    providerStateIdentity: `sha256:${'0'.repeat(64)}` as const,
    build: () => {
      throw new Error('backend should not run in this test');
    },
  }),
};

test('TsInProcessEngine creates a session over SQLite stores and recovers none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-engine-ts-'));
  const engine = new TsInProcessEngine();
  assert.equal(engine.kind, 'ts-in-process');
  const runtime = engine.openSessionRuntime({ root, backend: unusedBackend });
  try {
    const session = await runtime.createSession({
      cwd: root,
      llmConnectionId: 'connection-test',
      llmConnectionSlug: 'test',
      model: 'claude-opus-5-5',
      thinkingLevel: 'high',
      permissionMode: 'bypass',
    });
    assert.match(session.id, /./);
    assert.deepEqual(await runtime.recoverInterruptedSessions(), []);
    await runtime.restart(session.id);
    assert.deepEqual(await runtime.recoverInterruptedSessions(), []);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('RustHostEngine is a stub and does not open a runtime', () => {
  const engine = new RustHostEngine({ endpoint: '/usr/bin/maka', channel: 'ipc' });
  assert.equal(engine.kind, 'rust-host');
  assert.throws(
    () =>
      engine.openSessionRuntime({
        root: '/tmp',
        backend: unusedBackend,
      }),
    /protocol stub/,
  );
});
