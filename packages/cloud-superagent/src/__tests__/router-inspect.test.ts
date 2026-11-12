import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeRouterInspect, inspectNotes, LocalRouterInspect } from '../router-inspect.js';
import { initLocalRepo } from '../workspace.js';

test('FakeRouterInspect is read-only and inspectNotes formats git log plus CI', async () => {
  const inspect = new FakeRouterInspect('abc fix', 'CI: success');
  const notes = await inspectNotes(inspect, {
    eventId: 'e',
    tenantId: 't',
    source: 'github',
    type: 'pr_opened',
    subject: {
      kind: 'pull_request',
      tenantId: 't',
      key: 'pr:t:acme/app#1',
      repo: 'acme/app',
      number: 1,
    },
    idempotencyKey: 'k',
    actor: { login: 'alice', kind: 'user' },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'opened',
    fields: [],
    closesSubject: false,
  });
  assert.match(notes, /git_log=abc fix/);
  assert.match(notes, /ci=CI: success/);
});

test('LocalRouterInspect reads git log from a real repo', async () => {
  const dir = await initLocalRepo({ 'a.txt': 'one\n' });
  const inspect = new LocalRouterInspect((repo, ref) => `https://example.test/${repo}/${ref}`);
  const log = await inspect.gitLog({ repoDir: dir, n: 1 });
  assert.ok(log.length > 0);
  const ci = await inspect.ciStatus({ repo: 'acme/app', ref: 'main' });
  assert.match(ci, /acme\/app/);
});
