import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scrubSecretText } from '@maka-cloud/orchestrator';
import {
  applySkillProposal,
  formatLessonPrefix,
  learningSettingsFrom,
  LESSON_PREFIX_HEADER,
  reviewBounceOf,
  stripLessonPrefix,
} from '../lessons.js';
import { normalize } from '../events.js';
import { Superagent } from '../runtime.js';
import { actMandate } from '../types.js';
import { DatabaseSync } from 'node:sqlite';
import { SqliteSuperagentStore } from '../sqlite-store.js';
import {
  github,
  issuePayload,
  prPayload,
  reviewPayload,
  REPO,
  rig,
  TENANT,
  workflowPayload,
} from './harness.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345';

function learningRig() {
  return rig({
    learning: { enabled: true, distillAfter: 99 },
    judge: {
      async decide() {
        return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'learn' };
      },
    },
  });
}

test('learning stays off unless the host passes enabled, and env is ignored', () => {
  const prev = process.env.MAKA_CLOUD_LEARNING;
  process.env.MAKA_CLOUD_LEARNING = '1';
  try {
    const agent = new Superagent();
    assert.equal(agent.learning.enabled, false);
    assert.deepEqual(learningSettingsFrom(), {
      enabled: false,
      scrub: agent.learning.scrub,
      injectBudget: agent.learning.injectBudget,
      distillAfter: agent.learning.distillAfter,
    });
    assert.equal(learningSettingsFrom({ enabled: true }).enabled, true);
  } finally {
    if (prev === undefined) delete process.env.MAKA_CLOUD_LEARNING;
    else process.env.MAKA_CLOUD_LEARNING = prev;
  }
});

test('a changes_requested review records a scrubbed lesson and never writes skills', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-lessons-'));
  const { agent } = learningRig();
  const opened = await agent.ingest(github(TENANT, 'les-pr', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const review = await agent.ingest(
    github(
      TENANT,
      'les-rv',
      'pull_request_review',
      reviewPayload('changes_requested', 12, `token ${SECRET} please rename the helper`),
    ),
  );
  assert.equal(review.result, 'passthrough');
  const rows = agent.lessons(TENANT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.cause, 'review_changes');
  assert.equal(rows[0]?.triggerEventId, review.eventId);
  assert.equal(rows[0]?.mistake.includes(SECRET), false);
  assert.equal(scrubSecretText(`token ${SECRET}`).includes(SECRET), false);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'lesson_recorded'),
    true,
  );
  const files = await readdir(dir);
  assert.deepEqual(files, []);
  await rm(dir, { recursive: true, force: true });
});

test('denied speculative work, CI fail-then-fix, and watchdog correction record lessons', async () => {
  const { agent, handler, time } = learningRig();
  handler.script = (event) => {
    if (event.type === 'approval_granted') return { progress: true };
    return { action: { kind: 'deploy', boundText: 'Deploy prod' }, progress: true };
  };
  const opened = await agent.ingest(
    github(TENANT, 'les-deny', 'pull_request', prPayload('opened', 21)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const approvalId = agent.store.pendingApprovals(TENANT, opened.workerId)[0]?.approvalId as string;
  const denied = await agent.deny(TENANT, approvalId, 'Deploy prod');
  assert.equal(denied.ok, true);
  assert.equal(
    agent.lessons(TENANT).some((row) => row.cause === 'approval_denied'),
    true,
  );

  const { agent: ciAgent, handler: ciHandler } = learningRig();
  ciHandler.script = (event) => {
    if (event.type === 'ci_failed') return { progress: true, memory: 'fixing ci' };
    if (event.type === 'ci_passed') return { progress: true, memory: 'ci green' };
    return { progress: true, memory: 'pushed abcdef1234567 pr=https://example/1' };
  };
  const ciOpen = await ciAgent.ingest(
    github(TENANT, 'les-ci', 'pull_request', prPayload('opened', 22)),
  );
  assert.equal(ciOpen.result, 'spawned');
  if (ciOpen.result !== 'spawned') return;
  assert.equal(ciAgent.worker(TENANT, ciOpen.workerId)?.lastPushSha, 'abcdef1234567');
  const failed = await ciAgent.ingest(
    github(TENANT, 'les-ci-fail', 'workflow_run', workflowPayload('failure', 22)),
  );
  assert.equal(failed.result, 'passthrough');
  assert.equal(
    ciAgent.lessons(TENANT).some((row) => row.cause === 'ci_failed_then_fixed'),
    false,
  );
  const passed = await ciAgent.ingest(
    github(TENANT, 'les-ci-pass', 'workflow_run', workflowPayload('success', 22)),
  );
  assert.equal(passed.result, 'passthrough');
  const ciLesson = ciAgent.lessons(TENANT).find((row) => row.cause === 'ci_failed_then_fixed');
  assert.ok(ciLesson);
  assert.equal(ciLesson.triggerEventId, failed.eventId);

  const { agent: wd, store, time: wdTime } = learningRig();
  const wdOpen = await wd.ingest(github(TENANT, 'les-wd', 'issues', issuePayload('opened', 23)));
  assert.equal(wdOpen.result, 'spawned');
  if (wdOpen.result !== 'spawned') return;
  const worker = wd.worker(TENANT, wdOpen.workerId);
  assert.ok(worker);
  store.putWorker({
    ...worker,
    state: 'running',
    lastProgressAt: wdTime.now - 5,
    lastHeartbeatAt: wdTime.now,
  });
  wdTime.advance(20 * 60_000);
  const nudged = await wd.tick();
  assert.equal(
    nudged.some((row) => row.action === 'nudge'),
    true,
  );
  assert.equal(
    wd.lessons(TENANT).some((row) => row.cause === 'watchdog_correct'),
    true,
  );
  time.advance(1);
});

test('accepted lessons inject as an append-only prefix; over budget keeps only refs', async () => {
  const { agent } = learningRig();
  const first = await agent.ingest(
    github(TENANT, 'les-inj-1', 'pull_request', prPayload('opened', 30)),
  );
  assert.equal(first.result, 'spawned');
  if (first.result !== 'spawned') return;
  await agent.ingest(
    github(
      TENANT,
      'les-inj-rv',
      'pull_request_review',
      reviewPayload('changes_requested', 30, 'please add a test'),
    ),
  );
  const recorded = agent.lessons(TENANT)[0];
  assert.ok(recorded);
  const accepted = agent.acceptLesson(TENANT, recorded.lessonId);
  assert.equal(accepted.ok, true);

  const second = await agent.ingest(
    github(TENANT, 'les-inj-2', 'pull_request', prPayload('opened', 31)),
  );
  assert.equal(second.result, 'spawned');
  if (second.result !== 'spawned') return;
  const injected = agent.worker(TENANT, second.workerId);
  assert.ok(injected);
  assert.ok(injected.lessonPrefix?.startsWith(LESSON_PREFIX_HEADER));
  assert.ok(injected.lessonPrefix?.includes(`[${recorded.lessonId}]`));
  assert.deepEqual(injected.lessonRefs, [recorded.lessonId]);
  const recalled = agent.recallLesson(TENANT, recorded.lessonId);
  assert.ok(recalled?.includes(recorded.mistake));

  const tight = formatLessonPrefix(
    [
      {
        ...recorded,
        summary: 'x'.repeat(200),
      },
    ],
    40,
  );
  assert.equal(tight.refsOnly, true);
  assert.equal(tight.prefix.includes(recorded.lessonId), true);
  assert.equal(tight.prefix.includes('x'.repeat(20)), false);

  const next = agent.acceptLesson(TENANT, recorded.lessonId);
  assert.equal(next.ok, true);
  const third = await agent.ingest(
    github(TENANT, 'les-inj-3', 'pull_request', prPayload('opened', 32)),
  );
  if (third.result !== 'spawned') return;
  const later = agent.worker(TENANT, third.workerId);
  assert.equal(later?.lessonPrefix?.startsWith(injected.lessonPrefix ?? 'nope'), true);
  assert.equal(
    stripLessonPrefix(injected.lessonPrefix ?? '', `${injected.lessonPrefix ?? ''}handler notes`),
    'handler notes',
  );
});

test('distill proposes a skill diff and accept never applies it', async () => {
  const { agent } = learningRig();
  const opened = await agent.ingest(
    github(TENANT, 'les-dist', 'pull_request', prPayload('opened', 40)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  await agent.ingest(
    github(
      TENANT,
      'les-dist-rv',
      'pull_request_review',
      reviewPayload('rejected', 40, 'this approach is wrong'),
    ),
  );
  const distilled = agent.distillLessons(TENANT, REPO);
  assert.match(distilled.document, /Lessons/);
  assert.equal(distilled.proposals.length > 0, true);
  const proposal = distilled.proposals[0];
  assert.ok(proposal);
  assert.match(proposal.diff, /^--- /);
  assert.equal(applySkillProposal(proposal).reason, 'never_auto_apply');
  const accepted = agent.acceptProposal(TENANT, proposal.proposalId);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ok && accepted.proposal.status, 'accepted');
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'lesson_proposed'),
    true,
  );
  assert.equal(
    agent.store
      .audit(TENANT)
      .some((row) => row.kind === 'lesson_accepted' && row.detail.applied === false),
    true,
  );
  const rejected = agent.rejectLesson(TENANT, agent.lessons(TENANT)[0]?.lessonId ?? '');
  assert.equal(rejected.ok, true);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'lesson_rejected'),
    true,
  );
});

test('review events expose state, and sqlite audit rebuilds the book', async () => {
  const parsed = normalize(
    github(TENANT, 'st', 'pull_request_review', reviewPayload('CHANGES_REQUESTED')),
    10,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(reviewBounceOf({ ...parsed.event, eventId: 'evt' }), 'review_changes');

  const dir = await mkdtemp(join(tmpdir(), 'sa-lesson-db-'));
  const path = join(dir, 'superagent.db');
  const store = SqliteSuperagentStore.open(path);
  const agent = new Superagent({
    store,
    learning: { enabled: true, distillAfter: 99 },
    judge: {
      async decide() {
        return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'db' };
      },
    },
  });
  const opened = await agent.ingest(
    github(TENANT, 'db-pr', 'pull_request', prPayload('opened', 50)),
  );
  assert.equal(opened.result, 'spawned');
  await agent.ingest(
    github(
      TENANT,
      'db-rv',
      'pull_request_review',
      reviewPayload('changes_requested', 50, 'please fix'),
    ),
  );
  assert.equal(agent.lessons(TENANT).length, 1);
  agent.close();
  const reopened = new Superagent({
    store: SqliteSuperagentStore.open(path),
    learning: { enabled: true, distillAfter: 99 },
  });
  assert.equal(reopened.lessons(TENANT).length, 1);
  assert.equal(reopened.lessons(TENANT)[0]?.cause, 'review_changes');
  reopened.close();
  const db = new DatabaseSync(path);
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  db.close();
  assert.equal(version, 2);
  await rm(dir, { recursive: true, force: true });
});
