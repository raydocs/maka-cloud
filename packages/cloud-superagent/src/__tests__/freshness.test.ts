import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLeadReport, freshnessOf } from '../freshness.js';
import { RecordingLead } from '../lead.js';
import { github, issuePayload, TENANT, rig } from './harness.js';

test('freshnessOf flags a moved head, changed CI, a merge, and an old cache', () => {
  const now = 1_000_000;
  const moved = freshnessOf(
    { sha: 'bbbb', ci: 'success', prMerged: true, at: now },
    { sha: 'aaaa', ci: 'pending', prMerged: false, at: now - 1000 },
    now,
  );
  assert.equal(moved.stale, true);
  assert.equal(moved.reasons.length >= 3, true);
  const old = freshnessOf({ sha: 'aaaa', at: now }, { sha: 'aaaa', at: now - 20 * 60_000 }, now);
  assert.equal(old.stale, true);
  const fresh = freshnessOf(
    { sha: 'aaaa', ci: 'success', at: now },
    { sha: 'aaaa', ci: 'success', at: now },
    now,
  );
  assert.equal(fresh.stale, false);
  assert.match(
    formatLeadReport({
      workerId: 'wrk_1',
      live: { sha: 'bbbb', ci: 'success', prMerged: true, at: now },
      freshness: moved,
      plan: 'merge when green',
    }),
    /STALE/,
  );
});

test('reportToLead re-reads live PR/CI and does not trust the cached worker report', async () => {
  const lead = new RecordingLead();
  let sha = 'oldold01';
  let ci = 'pending';
  const { agent } = rig({
    lead,
    liveFacts: async () => ({ sha, ci, prMerged: false }),
  });
  const opened = await agent.ingest(github(TENANT, 'f1', 'issues', issuePayload('opened', 21)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const first = await agent.reportToLead(TENANT, opened.workerId);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.stale, false);
  assert.match(first.text, /oldold01/);
  sha = 'newnew02';
  ci = 'success';
  const second = await agent.reportToLead(TENANT, opened.workerId);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.stale, true);
  assert.match(second.text, /STALE/);
  assert.match(second.text, /newnew02/);
  assert.equal(lead.messages.at(-1)?.stale, true);
  assert.equal(
    agent.store
      .audit(TENANT)
      .some((row) => row.kind === 'lead_report' && row.detail.stale === true),
    true,
  );
});
