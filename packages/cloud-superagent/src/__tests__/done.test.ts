import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { defaultDoneWorld, readDoneFile, verifyDone, type DoneWorld } from '../done.js';
import { actMandate } from '../types.js';
import { github, issuePayload, prPayload, REPO, rig, TENANT } from './harness.js';

const run = promisify(execFile);

test('verifyDone refuses an empty claim or missing evidence', async () => {
  const world: DoneWorld = {};
  const empty = await verifyDone({ signals: [], evidence: 'x' }, world);
  assert.equal(empty.ok, false);
  assert.match(empty.reasons[0] ?? '', /empty/);
  const noEvidence = await verifyDone(
    { signals: [{ kind: 'url', href: 'https://example.test' }], evidence: '  ' },
    world,
  );
  assert.equal(noEvidence.ok, false);
  assert.match(noEvidence.reasons[0] ?? '', /evidence/);
});

test('merged, closed, published, command, file and url signals are read back live', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-done-'));
  const path = join(dir, 'note.json');
  await writeFile(path, JSON.stringify({ status: 'ready' }));
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  const world: DoneWorld = {
    pull: async () => ({ merged: true, mergeSha: 'deadbeef01' }),
    issue: async () => ({ closed: true }),
    published: async (pkg, version) => pkg === '@acme/app' && version === '1.2.3',
    command: async () => ({ code: 0, stdout: 'ok 3' }),
    readFile: readDoneFile,
    fetch: async () => ({ status: 200, body: 'research brief published' }),
    unpushed: async () => [],
  };
  const ok = await verifyDone(
    {
      evidence: 'Q&A thread: sources written and the issue closed',
      workspaceDir: dir,
      signals: [
        { kind: 'merged', repo: REPO, number: 12 },
        { kind: 'closed', repo: REPO, number: 4 },
        { kind: 'published', package: '@acme/app', version: '1.2.3' },
        { kind: 'command', argv: ['true'], stdout: 'ok 3' },
        { kind: 'file', path, sha256, jsonPath: 'status', jsonEquals: 'ready' },
        { kind: 'url', href: 'https://example.test/brief', status: 200, body: 'research' },
      ],
    },
    world,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.checks.length, 6);
});

test('an unpushed workspace refuses Done even when the file signal is present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-unpushed-'));
  await run('git', ['-C', dir, 'init']);
  await run('git', ['-C', dir, 'config', 'user.email', 'sa@test']);
  await run('git', ['-C', dir, 'config', 'user.name', 'sa']);
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['-C', dir, 'add', 'a.txt']);
  await run('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  await writeFile(join(dir, 'a.txt'), 'dirty\n');
  const file = await readDoneFile(join(dir, 'a.txt'));
  const world = defaultDoneWorld();
  const result = await verifyDone(
    {
      evidence: 'wrote a.txt',
      workspaceDir: dir,
      signals: [{ kind: 'file', path: join(dir, 'a.txt'), sha256: file.sha256 }],
    },
    world,
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.reasons.some((row) => /unpushed/.test(row)),
    true,
  );
});

test('a worker Done claim on a conversation subject retires only after signals read back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-qa-'));
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'answer.md');
  await writeFile(path, '# answer\n');
  const { agent, handler } = rig({
    doneWorld: { readFile: readDoneFile, unpushed: async () => [] },
  });
  handler.script = () => ({
    progress: true,
    done: {
      evidence: 'answered the research thread; file is the deliverable',
      workspaceDir: dir,
      signals: [{ kind: 'file', path }],
    },
  });
  const opened = await agent.ingest({
    source: 'chat',
    tenantId: TENANT,
    conversationId: 'cnv-research',
    messageId: 'm-research',
    text: 'summarize the auth options',
    actor: 'alice',
  });
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'retired');
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'done_verified'),
    true,
  );
});

test('a false merged claim does not retire the PR worker', async () => {
  const { agent, handler, judge } = rig({
    doneWorld: { pull: async () => ({ merged: false }) },
  });
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'PR' };
    },
  };
  handler.script = () => ({
    progress: true,
    done: {
      evidence: 'I merged it',
      signals: [{ kind: 'merged', repo: REPO, number: 12 }],
    },
  });
  const opened = await agent.ingest(github(TENANT, 'd1', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.notEqual(agent.worker(TENANT, opened.workerId)?.state, 'retired');
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'done_refused'),
    true,
  );
});

test('an issue worker Done claim needs the issue closed live', async () => {
  let closed = false;
  const { agent, handler } = rig({
    doneWorld: { issue: async () => ({ closed }) },
  });
  handler.script = () => ({
    progress: true,
    done: {
      evidence: 'closed the question',
      signals: [{ kind: 'closed', repo: REPO, number: 4 }],
    },
  });
  const opened = await agent.ingest(github(TENANT, 'i-done', 'issues', issuePayload('opened', 4)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'sleeping');
  closed = true;
  await agent.ingest(
    github(TENANT, 'i-again', 'issue_comment', {
      action: 'created',
      issue: { number: 4, title: 'Item 4' },
      comment: { id: 2, body: 'try done again' },
      repository: { full_name: REPO },
      sender: { login: 'bob', type: 'User' },
    }),
  );
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'retired');
});
