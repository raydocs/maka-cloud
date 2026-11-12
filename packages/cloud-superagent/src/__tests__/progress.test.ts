import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordingLead } from '../lead.js';
import {
  DEFAULT_PHASE_MS,
  DEFAULT_PROGRESS,
  applyProgressPatch,
  encodeProgressSse,
  estimatePhaseMs,
  formatLeadProgress,
  formatProgressBar,
  formatProgressLine,
  formatStatusText,
  historicalPhaseMs,
  ledgerFallbackMs,
  looksStuck,
  nextLeadKind,
  startProgress,
  statusSnapshotOf,
  viewOf,
  wantsProgressSse,
} from '../progress.js';
import { isStatusAsk, isStatusAskText } from '../router.js';
import { handleProgressRequest, runStatusCli } from '../status.js';
import { actMandate } from '../types.js';
import { reportsWaiting } from '../watchdog.js';
import { commentPayload, github, issuePayload, REPO, rig, TENANT } from './harness.js';

const watchdog = { heartbeatAfterMs: 2 * 60_000, stallAfterMs: 15 * 60_000 };

test('phase k/N, percent, and ETA use samples then ledger then defaults', () => {
  const at = 1_000;
  const started = startProgress(at, ['materialize', 'edit', 'test']);
  const { progress } = applyProgressPatch(
    started,
    { phase: 'edit', activity: 'model step' },
    at + 10,
  );
  assert.equal(progress.phase, 'edit');
  assert.equal(progress.index, 1);
  assert.equal(progress.samples?.materialize?.[0], 10);

  const { agent, store } = rig();
  store.putWorker({
    workerId: 'wrk_hist',
    tenantId: TENANT,
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:1', number: 1 },
    state: 'retired',
    generation: 1,
    mandate: actMandate([REPO]),
    memory: '',
    spills: [],
    plan: '',
    transcriptPointer: null,
    sandboxRef: null,
    workspaceRef: null,
    lastEventId: null,
    lastProgressAt: at,
    lastHeartbeatAt: at,
    lastStepSignature: null,
    stepRepeats: 0,
    usage: { tokens: 0, usdMicros: 0, wallMs: 0 },
    evidence: [],
    createdAt: at,
    updatedAt: at,
    retiredAt: at,
    progress: {
      ...startProgress(at, ['edit']),
      samples: { edit: [4_000, 6_000] },
    },
  });
  assert.equal(historicalPhaseMs(store, TENANT, 'edit'), 5_000);
  assert.equal(estimatePhaseMs(store, TENANT, 'edit'), 5_000);
  assert.equal(estimatePhaseMs(store, TENANT, 'push'), DEFAULT_PHASE_MS.push);
  assert.equal(ledgerFallbackMs([], 'test'), undefined);
  assert.equal(
    ledgerFallbackMs(
      [
        { tenantId: TENANT, workerId: 'a', tokens: 1, usdMicros: 1, wallMs: 2_000, at: 1 },
        { tenantId: TENANT, workerId: 'b', tokens: 1, usdMicros: 1, wallMs: 4_000, at: 2 },
        { tenantId: TENANT, workerId: 'c', tokens: 1, usdMicros: 1, wallMs: 6_000, at: 3 },
      ],
      'push',
    ) !== undefined,
    true,
  );
  assert.ok(agent);
});

test('waiting on CI is not stuck, even past the ETA', () => {
  const at = 10_000;
  const worker = {
    state: 'running' as const,
    lastHeartbeatAt: at - 60_000,
    lastProgressAt: at - 60_000,
    progress: {
      ...startProgress(at - 60_000, ['ci-wait']),
      phase: 'ci-wait' as const,
      index: 0,
      waiting: { kind: 'ci' as const, detail: 'https://ci' },
    },
  };
  assert.equal(
    looksStuck(worker, at + DEFAULT_PHASE_MS['ci-wait'] * 3, {
      ...watchdog,
      phaseEtaMs: DEFAULT_PHASE_MS['ci-wait'],
      stuckMargin: 0.5,
    }),
    false,
  );
  assert.equal(reportsWaiting({ ...fakeWorker(at), progress: worker.progress }), true);
});

test('no heartbeat past ETA plus margin looks stuck and is distinct from waiting', () => {
  const started = 1_000;
  const progress = startProgress(started, ['edit']);
  const worker = {
    state: 'running' as const,
    lastHeartbeatAt: started,
    lastProgressAt: started,
    progress,
  };
  const eta = DEFAULT_PHASE_MS.edit;
  assert.equal(
    looksStuck(worker, started + eta, {
      ...watchdog,
      phaseEtaMs: eta,
      stuckMargin: 0.5,
    }),
    false,
  );
  assert.equal(
    looksStuck(worker, started + eta + eta * 0.5 + 1, {
      heartbeatAfterMs: 1,
      stallAfterMs: 1,
      phaseEtaMs: eta,
      stuckMargin: 0.5,
    }),
    true,
  );
});

test('lead speaks on phase change, still every 5 minutes, and looks-stuck once', async () => {
  const lead = new RecordingLead();
  const { agent, handler, time } = rig({
    lead,
    progress: { stillEveryMs: 5 * 60_000, stuckMargin: 0.5 },
    watchdog: { stallAfterMs: 1_000, heartbeatAfterMs: 1_000, loopRepeat: 9 },
  });
  handler.script = () => ({
    progress: true,
    progressUpdate: { phase: 'edit', activity: 'node add.test.js' },
  });
  const opened = await agent.ingest(github(TENANT, 'p1', 'issues', issuePayload('opened', 31)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const phaseNotes = lead.messages.filter(
    (row) => /edit 2\/9/.test(row.text) || /edit \d+\/\d+/.test(row.text),
  );
  assert.ok(phaseNotes.length >= 1, 'phase change speaks');
  const afterPhase = lead.messages.length;

  handler.script = () => ({
    progress: true,
    progressUpdate: { activity: 'still compiling' },
  });
  time.advance(30_000);
  await agent.ingest(
    github(TENANT, 'p1c', 'issue_comment', commentPayload(31, 'please keep going', false, 1)),
  );
  assert.equal(lead.messages.length, afterPhase, 'quiet inside the still window');

  time.advance(5 * 60_000);
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  agent.store.putWorker({
    ...worker,
    state: 'running',
    lastProgressAt: time.now - 10,
    lastHeartbeatAt: time.now - 10,
    progress: {
      ...(worker.progress ?? startProgress(time.now)),
      phase: 'edit',
      phaseStartedAt: time.now - 5 * 60_000,
      lastActivity: 'node add.test.js',
      lastLeadAt: time.now - 5 * 60_000,
    },
  });
  await agent.tick();
  assert.ok(
    lead.messages.some((row) => /still edit, did node add.test.js/.test(row.text)),
    lead.messages.map((row) => row.text).join(' | '),
  );

  const live = agent.worker(TENANT, opened.workerId);
  assert.ok(live);
  agent.store.putWorker({
    ...live,
    state: 'running',
    lastProgressAt: time.now - 20 * 60_000,
    lastHeartbeatAt: time.now - 20 * 60_000,
    progress: {
      ...(live.progress ?? startProgress(time.now)),
      phase: 'edit',
      phaseStartedAt: time.now - 30 * 60_000,
      heartbeatAt: time.now - 20 * 60_000,
      lastActivity: 'node add.test.js',
      stuckSpoken: false,
    },
  });
  time.advance(2_000);
  await agent.tick();
  const stuck = lead.messages.filter((row) => /looks stuck/.test(row.text));
  assert.equal(stuck.length, 1);
  await agent.tick();
  assert.equal(
    lead.messages.filter((row) => /looks stuck/.test(row.text)).length,
    1,
    'stuck is spoken once',
  );
});

test('statusSnapshot is live store state the lead can read', async () => {
  const { agent, handler } = rig();
  handler.script = () => ({
    progress: true,
    progressUpdate: { phase: 'test', activity: 'node add.test.js' },
  });
  const opened = await agent.ingest(github(TENANT, 'p2', 'issues', issuePayload('opened', 32)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const snap = agent.statusSnapshot(TENANT);
  assert.equal(snap.workers.length, 1);
  assert.equal(snap.workers[0]?.phase, 'test');
  assert.equal(snap.workers[0]?.lastActivity, 'node add.test.js');
  assert.match(formatProgressLine(snap.workers[0]!), /test/);
  const persisted = agent.worker(TENANT, opened.workerId)?.progress;
  assert.equal(persisted?.phase, 'test');
});

test('a status question on a live worker answers from progress, not a new spawn', async () => {
  const lead = new RecordingLead();
  const { agent, handler } = rig({ lead });
  handler.script = () => ({
    progress: true,
    progressUpdate: { phase: 'install', activity: 'npm ci' },
  });
  const opened = await agent.ingest(github(TENANT, 'p3', 'issues', issuePayload('opened', 33)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const asked = await agent.ingest(
    github(TENANT, 'p3s', 'issue_comment', commentPayload(33, 'how is it going', false, 4)),
  );
  assert.equal(asked.result, 'answered');
  if (asked.result !== 'answered') return;
  assert.match(asked.text, /install/);
  assert.match(asked.text, /fresh|STALE/);
  assert.equal(agent.workers(TENANT).filter((row) => row.state !== 'retired').length, 1);
});

test('isStatusAsk distinguishes how-is-it-going from new work', () => {
  assert.equal(isStatusAskText('how is it going'), true);
  assert.equal(isStatusAskText('please fix the login'), false);
  assert.equal(
    isStatusAsk({
      eventId: 'e',
      tenantId: TENANT,
      source: 'chat',
      type: 'user_message',
      subject: null,
      idempotencyKey: 'k',
      actor: { login: 'a', kind: 'user' },
      occurredAt: 1,
      receivedAt: 1,
      summary: '',
      fields: [['text', 'any update']],
      closesSubject: false,
    }),
    true,
  );
});

test('CLI status prints a bar; JSON and SSE encode the same snapshot', async () => {
  const snapshot = statusSnapshotOf(rig().store, 1, DEFAULT_PROGRESS, watchdog, TENANT);
  const empty: string[] = [];
  const code = await runStatusCli({
    snapshot: {
      at: 1,
      workers: [
        {
          workerId: 'wrk_1',
          tenantId: TENANT,
          state: 'running',
          phase: 'edit',
          k: 2,
          n: 9,
          percent: 20,
          elapsedMs: 90_000,
          etaMs: 600_000,
          lastActivity: 'model step',
          heartbeatAt: 1,
          look: 'running',
        },
      ],
    },
    argv: [],
    stdout: (text) => empty.push(text),
  });
  assert.equal(code, 0);
  assert.match(empty[0] ?? '', /wrk_1/);
  assert.match(empty[0] ?? '', /\[#+\.+\]/);
  assert.equal(formatProgressBar(50, 10), '[#####.....]');
  assert.equal(formatStatusText(snapshot), 'no live workers');

  const json = handleProgressRequest({
    method: 'GET',
    url: '/v1/superagent/progress',
    snapshot: { at: 1, workers: [] },
  });
  assert.equal(json.status, 200);
  assert.equal(json.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(json.body).workers.length, 0);

  const sse = handleProgressRequest({
    method: 'GET',
    url: '/v1/superagent/progress?stream=1',
    accept: 'text/event-stream',
    snapshot: { at: 2, workers: [] },
  });
  assert.equal(sse.headers['content-type'], 'text/event-stream');
  assert.match(sse.body, /^id: 1\nevent: progress\ndata: /);
  assert.equal(wantsProgressSse('/v1/superagent/progress', 'text/event-stream'), true);
  assert.match(encodeProgressSse({ at: 3, workers: [] }), /event: progress/);
});

test('W2 still skips a progress.waiting worker', async () => {
  const { agent, store, time } = rig({
    watchdog: { stallAfterMs: 1_000, heartbeatAfterMs: 60_000, loopRepeat: 9 },
  });
  const opened = await agent.ingest(github(TENANT, 'w2', 'issues', issuePayload('opened', 34)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  store.putWorker({
    ...worker,
    state: 'running',
    lastProgressAt: time.now - 5,
    lastHeartbeatAt: time.now,
    progress: {
      ...startProgress(time.now, ['review-wait']),
      waiting: { kind: 'review', detail: 'reviewer' },
    },
  });
  time.advance(2_000);
  const findings = await agent.tick();
  assert.equal(
    findings.some((row) => row.workerId === opened.workerId),
    false,
  );
});

function fakeWorker(at: number) {
  return {
    workerId: 'wrk',
    tenantId: TENANT,
    subject: { kind: 'issue' as const, tenantId: TENANT, key: 'k', number: 1 },
    state: 'running' as const,
    generation: 1,
    mandate: actMandate([REPO]),
    memory: '',
    spills: [],
    plan: '',
    transcriptPointer: null,
    sandboxRef: null,
    workspaceRef: null,
    lastEventId: null,
    lastProgressAt: at,
    lastHeartbeatAt: at,
    lastStepSignature: null,
    stepRepeats: 0,
    usage: { tokens: 0, usdMicros: 0, wallMs: 0 },
    evidence: [],
    createdAt: at,
    updatedAt: at,
    retiredAt: null,
  };
}

test('a held approval is merge-held / waiting on human, not stuck', async () => {
  const { agent, handler } = rig({
    judge: {
      async decide(event) {
        const repos = event.subject?.repo ? [event.subject.repo] : [REPO];
        return { action: 'spawn', mandate: actMandate(repos), title: 'act' };
      },
    },
  });
  handler.script = () => ({
    progress: true,
    action: { kind: 'push_protected', boundText: 'Push main on acme/app' },
  });
  const opened = await agent.ingest(github(TENANT, 'hold', 'issues', issuePayload('opened', 35)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.state, 'awaiting_approval');
  assert.equal(worker?.progress?.waiting?.kind, 'human');
  const snap = agent.statusSnapshot(TENANT);
  assert.equal(snap.workers[0]?.look, 'waiting');
  assert.equal(reportsWaiting(worker!), true);
});

test('viewOf marks waiting vs running vs stuck', () => {
  const { store } = rig();
  const at = 50;
  const running = {
    ...fakeWorker(at),
    progress: startProgress(at, ['edit']),
  };
  const view = viewOf(running, at + 10, store, DEFAULT_PROGRESS, watchdog);
  assert.equal(view.look, 'running');
  assert.equal(view.k, 1);
});
