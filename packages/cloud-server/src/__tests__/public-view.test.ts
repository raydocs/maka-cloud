import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toPublicItem } from '../public-view.js';

test("an approval item's ask reaches the client exactly as the approval binds it; other asks are scrubbed (T15)", () => {
  const card =
    'Allow open_pull_request(taskId: "tsk_1", title: "Fix ｃodex login")? It cannot be undone.\n\nRepository: acme/codex-secrets';
  assert.deepEqual(toPublicItem({ kind: 'approval', ask: card }), { kind: 'approval', ask: card });
  assert.deepEqual(toPublicItem({ kind: 'blocked', ask: 'Codex failed on ｃlaude.' }), {
    kind: 'blocked',
    ask: 'assistant failed on assistant.',
  });
});
