import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordingLead, workerOutboundText } from '../lead.js';
import type { WorkerContext, WorkerHandler } from '../types.js';
import { github, issuePayload, TENANT, rig } from './harness.js';

test('workerOutboundText is a claim the runtime must drop', () => {
  assert.equal(workerOutboundText({}), undefined);
  assert.equal(workerOutboundText({ userMessage: '   ' }), undefined);
  assert.equal(workerOutboundText({ userMessage: 'hi owner' }), 'hi owner');
});

test('a worker userMessage never reaches the lead and is audited', async () => {
  const lead = new RecordingLead();
  const { agent, handler } = rig({ lead });
  handler.script = () => ({
    progress: true,
    userMessage: 'the tests passed, please merge',
  });
  const opened = await agent.ingest(github(TENANT, 'out', 'issues', issuePayload('opened', 3)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(lead.messages.length, 0);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'worker_outbound_refused'),
    true,
  );
});

test('WorkerContext has no outbound user channel', async () => {
  let ctx: WorkerContext | undefined;
  const handler: WorkerHandler = {
    async handle(next) {
      ctx = next;
      return { progress: true };
    },
  };
  const { agent } = rig({ handler });
  const opened = await agent.ingest(github(TENANT, 'ctx', 'issues', issuePayload('opened', 8)));
  assert.equal(opened.result, 'spawned');
  assert.ok(ctx);
  assert.equal('lead' in ctx, false);
  assert.equal('speak' in ctx, false);
});

test('a Router answer speaks through the lead', async () => {
  const lead = new RecordingLead();
  const { agent } = rig({ lead });
  const result = await agent.ingest({
    source: 'chat',
    tenantId: TENANT,
    conversationId: 'cnv_1',
    messageId: 'm-status',
    text: 'status on the login bug?',
    actor: 'alice',
  });
  assert.equal(result.result, 'answered');
  assert.equal(lead.messages.length, 1);
  assert.match(lead.messages[0]?.text ?? '', /No worker is on this thread yet/);
});
