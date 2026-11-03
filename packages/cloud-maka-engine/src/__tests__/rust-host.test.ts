import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RUST_HOST_EVENT_MAPPING,
  RUST_HOST_FRAMING,
  RUST_HOST_METHOD_MAPPING,
  RUST_HOST_SESSION_IMPORT_MAPPING,
} from '../rust-host.js';

test('the rust-preview mapping names the methods, events and session-import calls we use', () => {
  assert.equal(RUST_HOST_FRAMING.prefix, 'u32-be-length');
  assert.deepEqual([...RUST_HOST_FRAMING.channels], ['ipc', 'websocket']);
  assert.equal(RUST_HOST_METHOD_MAPPING.createSession.method, 'create');
  assert.equal(RUST_HOST_METHOD_MAPPING.sendMessage.method, 'send');
  assert.equal(RUST_HOST_METHOD_MAPPING.stopSession.method, 'stop');
  assert.equal(RUST_HOST_METHOD_MAPPING.compactSession.method, 'compact');
  assert.equal(RUST_HOST_METHOD_MAPPING.watchEvents.method, 'watch');
  assert.equal(RUST_HOST_METHOD_MAPPING.recoverInterruptedSessions.method, null);
  assert.equal(RUST_HOST_EVENT_MAPPING.tool_start.includes('watch'), true);
  assert.equal(RUST_HOST_EVENT_MAPPING.complete.includes('watch'), true);
  assert.equal(RUST_HOST_SESSION_IMPORT_MAPPING.import.method, 'import');
  assert.equal(RUST_HOST_SESSION_IMPORT_MAPPING.catalog.method, 'imports');
});
