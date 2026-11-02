import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sequentialIds } from '../ids.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ADD_BROKEN,
  ADD_FIXED,
  CodingLoopHandler,
  FakeCoder,
  FakeGitHost,
  NodeFileTestPort,
  mergeAction,
  mayPush,
  scratchFiles,
  workerBranch,
} from '../loop.js';
import { Superagent } from '../runtime.js';
import { FakeSandbox } from '../sandbox.js';
import { actMandate, observeMandate } from '../types.js';
import { initLocalRepo } from '../workspace.js';
import { github, prPayload, commentPayload, REPO, TENANT } from './harness.js';

async function loopRig(intensity: 'act' | 'observe' = 'act') {
  const repoDir = await initLocalRepo(scratchFiles());
  const git = new FakeGitHost();
  const sandbox = new FakeSandbox();
  const handler = new CodingLoopHandler({
    coder: new FakeCoder(),
    tests: new NodeFileTestPort(),
    git,
    sandbox,
    repoUrl: repoDir,
  });
  const agent = new Superagent({
    handler,
    sandbox,
    ids: sequentialIds(200),
    admission: { allowActors: ['alice', 'bob'] },
    judge: {
      async decide(event) {
        const repos = event.subject?.repo ? [event.subject.repo] : [REPO];
        return {
          action: 'spawn',
          mandate: intensity === 'act' ? actMandate(repos, 'explicit') : observeMandate(repos),
          title: 'loop',
        };
      },
    },
  });
  return { agent, git, sandbox, repoDir, handler };
}

test('act worker clones, fixes tests, pushes a worker branch and opens a PR with evidence', async () => {
  const { agent, git, sandbox, repoDir, handler } = await loopRig('act');
  const opened = await agent.ingest(
    github(TENANT, 'loop-1', 'pull_request', prPayload('opened', 3)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.mandate.intensity, 'act');
  assert.equal(mayPush(worker!), true);
  assert.equal(git.pushes.length, 1);
  assert.equal(git.pushes[0]?.branch, workerBranch(opened.workerId));
  assert.equal(git.pullRequests.length, 1);
  assert.match(git.pullRequests[0]?.body ?? '', /Evidence/);
  assert.ok((worker?.evidence ?? []).some((row) => row.kind === 'test'));
  assert.ok((worker?.evidence ?? []).some((row) => row.kind === 'patch'));
  assert.ok((worker?.evidence ?? []).some((row) => row.label === 'box-upload'));
  assert.ok((worker?.evidence ?? []).some((row) => row.label === 'box-edit'));
  assert.ok((worker?.evidence ?? []).some((row) => row.label === 'box-diff'));
  assert.ok((worker?.evidence ?? []).some((row) => /exit=0/.test(row.body)));
  assert.equal(await readFile(join(repoDir, 'add.js'), 'utf8'), ADD_BROKEN);
  assert.ok(handler.lastPublishDir);
  assert.equal(await readFile(join(handler.lastPublishDir, 'add.js'), 'utf8'), ADD_FIXED);
  assert.match(handler.lastPatch, /return a \+ b/);
  assert.ok(handler.lastExecs.some((row) => row.cmd === 'node add.test.js' && row.exitCode === 0));
  assert.ok(
    (worker?.evidence ?? []).some((row) => row.kind === 'artifact' && /checks/.test(row.body)),
  );
  assert.ok(
    sandbox.commands.some((row) => row.cmd.includes('src.tgz') || row.cmd.includes('tar ')),
  );
  assert.ok(sandbox.commands.some((row) => row.cmd === 'node add.test.js'));
  assert.ok(!sandbox.commands.some((row) => row.cmd.startsWith('echo loop-verify')));
  assert.ok(worker?.workspaceRef);
});

test('observe worker does not push', async () => {
  const { agent, git } = await loopRig('observe');
  const opened = await agent.ingest(
    github(TENANT, 'loop-obs', 'pull_request', prPayload('opened', 4)),
  );
  assert.equal(opened.result, 'spawned');
  assert.equal(git.pushes.length, 0);
  assert.equal(git.pullRequests.length, 0);
});

test('CI failure and review comment resume the same worker without a Router call', async () => {
  const { agent, git } = await loopRig('act');
  const opened = await agent.ingest(
    github(TENANT, 'loop-2', 'pull_request', prPayload('opened', 5)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const before = git.pushes.length;
  const ci = await agent.ingest(
    github(TENANT, 'loop-2-ci', 'workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 9,
        name: 'test',
        head_sha: 'abc',
        conclusion: 'failure',
        pull_requests: [{ number: 5 }],
      },
      repository: { full_name: REPO },
      sender: { login: 'github-actions[bot]', type: 'Bot' },
    }),
  );
  assert.equal(ci.result, 'passthrough');
  assert.equal(ci.judgeCalls, 0);
  const review = await agent.ingest(
    github(TENANT, 'loop-2-c', 'issue_comment', commentPayload(5, 'please rename the helper')),
  );
  assert.equal(review.result, 'passthrough');
  assert.ok(git.pushes.length >= before);
});

test('merge stays held until the owner approves the exact bound text', async () => {
  const { agent, git } = await loopRig('act');
  const opened = await agent.ingest(
    github(TENANT, 'loop-3', 'pull_request', prPayload('opened', 6)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const pr = git.pullRequests[0];
  assert.ok(pr);
  const action = mergeAction(REPO, pr.number);
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  const held = agent.safety.gate(worker, action, Date.now());
  assert.equal(held.allowed, false);
  if (held.allowed || held.reason !== 'held') return;
  const ok = await agent.approve(TENANT, held.approvalId, action.boundText);
  assert.equal(ok.ok, true);
  assert.deepEqual(git.merged, [pr.number]);
});
