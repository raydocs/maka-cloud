import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type DutySpec, DutyEngine, LaunchRefused, type RunRequest } from '@maka-cloud/duties';
import { serverLauncher } from '../duties/launcher.js';
import { createDuties } from '../duties/runtime.js';
import { type DutyRunView, RunSettler } from '../duties/settle.js';

const SECRET = 'a-webhook-secret-of-sufficient-length';
const OWNER = 'inv_000000000001';
const DAY0 = Date.UTC(2026, 9, 20, 12, 0, 0);

const ISSUE_DUTY: DutySpec = {
  name: 'Triage issues',
  trigger: { kind: 'issue_opened' },
  instruction: 'Read the issue and report.',
  authority: 'read-only',
  runBudgetUsd: 2,
  dailyCapUsd: 20,
};

function issuePayload(number: number) {
  return {
    action: 'opened',
    issue: {
      number,
      title: 'It breaks',
      body: 'Steps',
      html_url: `https://github.com/acme/widgets/issues/${number}`,
      user: { login: 'alice', type: 'User' },
    },
    repository: { full_name: 'acme/widgets' },
    installation: { id: 7 },
    sender: { login: 'alice', type: 'User' },
  };
}

/** An engine with one approved issue duty, and a way to claim and launch requests of it. */
async function rig(clock: { t: number }) {
  const engine = new DutyEngine({
    dbPath: ':memory:',
    webhookSecret: SECRET,
    allowProject: () => true,
    now: () => clock.t,
    proposer: () => ({
      duties: [ISSUE_DUTY],
      sets: [{ id: 'recommended', label: 'All', recommended: true, duties: [0] }],
    }),
  });
  const added = engine.addProject(OWNER, {
    repo: 'acme/widgets',
    installationId: 7,
    defaultBranch: 'main',
    selfLogins: ['maka-bot'],
  });
  assert.ok(added.ok);
  return { engine, projectId: added.project.projectId };
}

async function started(clock: { t: number }, count: number) {
  const { engine, projectId } = await rig(clock);
  const proposal = await engine.propose(OWNER, projectId, {
    inspect: async () => ({
      defaultBranch: 'main',
      workflows: [],
      openIssues: 0,
      failedRunsLast30Days: 0,
    }),
  });
  assert.ok(proposal.ok);
  const decided = engine.decideProposal({
    proposalId: proposal.proposal.proposalId,
    setId: 'recommended',
    caller: OWNER,
  });
  assert.ok(decided.ok);
  const dutyId = proposal.proposal.sets[0]?.dutyIds[0] as string;
  const requests: RunRequest[] = [];
  for (let n = 1; n <= count; n += 1) {
    const body = Buffer.from(JSON.stringify(issuePayload(n)));
    const result = engine.receive(
      {
        'x-github-event': 'issues',
        'x-github-delivery': `delivery-${n}`,
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
      body,
    );
    assert.equal(result.body.started, 1);
    const [id] = engine.due();
    const request = engine.beginLaunch(id as string);
    assert.ok(request);
    assert.ok(engine.launched(request.requestId, `cnv_${n}`));
    requests.push(request);
  }
  return { engine, projectId, dutyId, requests };
}

const run = (
  state: DutyRunView['state'],
  spentUsd = 0,
  dutyId: string | null = 'dty',
  endReason: string | null = null,
): DutyRunView => ({
  runId: 'run_1',
  dutyId,
  state,
  spentUsd,
  endReason,
});

test('a request is settled at what its run spent, on every way a run can end', async () => {
  const clock = { t: DAY0 };
  const exits: Array<[DutyRunView['state'], number, string, string | null]> = [
    ['done', 0.5, 'completed', 'delivered'],
    ['failed', 0.75, 'failed', 'setup_failed'],
    ['cancelled', 0.25, 'stopped', 'user_stop'],
    ['cancelled', 0.3, 'stopped', 'paused'],
    ['cancelled', 2, 'failed', 'budget_limit'],
    ['cancelled', 0.1, 'failed', null],
    ['interrupted', 1.5, 'failed', null],
  ];
  const { engine, dutyId, requests } = await started(clock, exits.length);
  assert.equal(
    engine.dayUsage(dutyId).reservedUsd,
    2 * exits.length,
    'each start reserved its budget',
  );
  const runs = new Map<string, DutyRunView[]>(
    requests.map((request, index) => {
      const [state, spent, , endReason] = exits[index] as (typeof exits)[number];
      return [`cnv_${index + 1}`, [run(state, spent, 'dty', endReason)]];
    }),
  );
  const settler = new RunSettler({
    engine,
    runsOf: (id) => runs.get(id) ?? [],
    now: () => clock.t,
  });
  assert.equal(settler.settle(), exits.length);
  requests.forEach((request, index) => {
    const [, spent, reason] = exits[index] as (typeof exits)[number];
    const stored = engine.request(request.requestId);
    assert.equal(stored?.state, 'done');
    assert.equal(stored?.reason, reason);
    assert.ok(spent >= 0);
  });
  const usage = engine.dayUsage(dutyId);
  assert.equal(usage.reservedUsd, 0, 'no reservation is left behind');
  assert.equal(usage.spentUsd, 0.5 + 0.75 + 0.25 + 0.3 + 2 + 0.1 + 1.5);
  assert.equal(settler.settle(), 0, 'settling again changes nothing');
  engine.close();
});

test('a run the conductor ended as model_transient is retried once; every other failed reason counts as a failure', async () => {
  const clock = { t: DAY0 };
  const { engine, dutyId, requests } = await started(clock, 3);
  const reasons = ['model_transient', 'model_error', 'budget_limit'];
  const runs = new Map<string, DutyRunView[]>(
    requests.map((_, index) => [
      `cnv_${index + 1}`,
      [run(index === 2 ? 'cancelled' : 'failed', 0.1, 'dty', reasons[index] ?? null)],
    ]),
  );
  const settler = new RunSettler({
    engine,
    runsOf: (id) => runs.get(id) ?? [],
    now: () => clock.t,
  });
  assert.equal(settler.settle(), 3);
  assert.deepEqual(
    requests.map((request) => engine.request(request.requestId)?.reason),
    ['transient', 'failed', 'failed'],
  );
  const retries = engine
    .requestsOf(dutyId)
    .filter((q) => !requests.some((request) => request.requestId === q.requestId));
  assert.equal(retries.length, 1, 'only the transient one has a retry waiting');
  assert.equal(retries[0]?.state, 'pending');
  engine.close();
});

test('runs the conductor stopped on its own count as failures, and ten in a row turn the duty off', async () => {
  const clock = { t: DAY0 };
  const { engine, projectId, dutyId, requests } = await started(clock, 10);
  const runs = new Map<string, DutyRunView[]>(
    requests.map((_, index) => [`cnv_${index + 1}`, [run('cancelled', 2, 'dty', 'budget_limit')]]),
  );
  const settler = new RunSettler({
    engine,
    runsOf: (id) => runs.get(id) ?? [],
    now: () => clock.t,
  });
  assert.equal(settler.settle(), 10);
  const duty = engine.project(OWNER, projectId)?.duties.find((d) => d.dutyId === dutyId);
  assert.equal(duty?.state, 'off');
  assert.equal(duty?.offReason, 'failures');
  engine.close();
});

test('runs a person stopped never count against the duty, however many', async () => {
  const clock = { t: DAY0 };
  const { engine, projectId, dutyId, requests } = await started(clock, 10);
  const runs = new Map<string, DutyRunView[]>(
    requests.map((_, index) => [`cnv_${index + 1}`, [run('cancelled', 0.1, 'dty', 'user_stop')]]),
  );
  const settler = new RunSettler({
    engine,
    runsOf: (id) => runs.get(id) ?? [],
    now: () => clock.t,
  });
  assert.equal(settler.settle(), 10);
  const duty = engine.project(OWNER, projectId)?.duties.find((d) => d.dutyId === dutyId);
  assert.equal(duty?.state, 'active');
  assert.equal(duty?.consecutiveFailures, 0);
  engine.close();
});

test('a run that is still open keeps its reservation', async () => {
  const clock = { t: DAY0 };
  const { engine, dutyId } = await started(clock, 3);
  const states: DutyRunView['state'][] = ['active', 'waiting', 'delivering'];
  const settler = new RunSettler({
    engine,
    runsOf: (id) => [run(states[Number(id.slice(4)) - 1] as DutyRunView['state'], 1)],
    now: () => clock.t,
  });
  assert.equal(settler.settle(), 0);
  assert.equal(engine.dayUsage(dutyId).reservedUsd, 6);
  engine.close();
});

test('a started request whose conversation never got a duty run is written off, at its whole reservation, after a day', async () => {
  const clock = { t: DAY0 };
  const { engine, dutyId, requests } = await started(clock, 1);
  // A run without a duty id is the owner's own message, not this request's run.
  const settler = new RunSettler({
    engine,
    runsOf: () => [run('done', 0.1, null)],
    now: () => clock.t,
  });
  assert.equal(settler.settle(), 0);
  clock.t += 24 * 3_600_000 - 1;
  assert.equal(settler.settle(), 0, 'not yet');
  clock.t += 1;
  assert.equal(settler.settle(), 1);
  const stored = engine.request(requests[0]?.requestId as string);
  assert.equal(stored?.reason, 'abandoned');
  // The day of the claim, not the day it was written off.
  assert.equal(
    engine.dayUsage(dutyId, '2026-10-20').spentUsd,
    2,
    'the cautious reading: all of it',
  );
  assert.equal(engine.dayUsage(dutyId, '2026-10-20').reservedUsd, 0);
  engine.close();
});

test('one request that cannot be read does not hold up the others', async () => {
  const clock = { t: DAY0 };
  const { engine, requests } = await started(clock, 2);
  const warnings: string[] = [];
  const settler = new RunSettler({
    engine,
    runsOf: (id) => {
      if (id === 'cnv_1') throw new Error('the conductor state is unreadable');
      return [run('done', 1)];
    },
    now: () => clock.t,
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(settler.settle(), 1);
  assert.equal(warnings.length, 1);
  assert.equal(engine.request(requests[0]?.requestId as string)?.state, 'started');
  assert.equal(engine.request(requests[1]?.requestId as string)?.state, 'done');
  engine.close();
});

const REQUEST: RunRequest = {
  requestId: 'req_1',
  dutyId: 'dty_1',
  dutyName: 'Triage issues',
  projectId: 'prj_1',
  owner: OWNER,
  repo: 'acme/widgets',
  brief: 'A new issue was opened.',
  external: true,
  authority: 'read-only',
  runBudgetUsd: 2,
  attempts: 1,
};

test('the launcher starts the conversation keyed by the request, with the taint and the fixed limits', async () => {
  const seen: unknown[] = [];
  const launcher = serverLauncher({
    startConversation: (input: unknown) => {
      seen.push(input);
      return { ok: true, conversationId: 'cnv_9', messageId: 'msg_1', duplicate: false };
    },
    createConversation: () => ({ ok: false, reason: 'invalid' }),
  } as never);
  const result = await launcher.start(REQUEST, new AbortController().signal);
  assert.deepEqual(result, { conversationId: 'cnv_9' });
  assert.deepEqual(seen, [
    {
      owner: OWNER,
      key: 'req_1',
      title: 'Triage issues · acme/widgets',
      text: 'A new issue was opened.',
      meta: {
        external: true,
        run: { dutyId: 'dty_1', authority: 'read-only', budgetUsd: 2 },
      },
    },
  ]);
});

test('the launcher can tell, without starting anything, whether the request already made its conversation', () => {
  const asked: unknown[] = [];
  let exists = false;
  const launcher = serverLauncher({
    startedConversation: (input: unknown) => {
      asked.push(input);
      return exists ? { conversationId: 'cnv_9' } : undefined;
    },
  } as never);
  assert.equal(launcher.begun?.(REQUEST), false);
  exists = true;
  assert.equal(launcher.begun?.(REQUEST), true);
  assert.deepEqual(asked[0], { owner: OWNER, key: 'req_1' });
});

test('a start the server refuses is refused for good, not retried', async () => {
  for (const reason of ['owner_inactive', 'invalid'] as const) {
    const launcher = serverLauncher({
      startConversation: () => ({ ok: false, reason }),
    } as never);
    await assert.rejects(
      launcher.start(REQUEST, new AbortController().signal),
      (error: unknown) => error instanceof LaunchRefused && error.message.includes(reason),
    );
  }
});

// ------------------------------------------------------------------ runtime

const FACTS = { defaultBranch: 'main', workflows: ['CI'], openIssues: 4, failedRunsLast30Days: 3 };

function runtimeRig(over: Partial<Parameters<typeof createDuties>[0]> = {}) {
  const timers: Array<{ fn: () => void; ms: number; released: boolean }> = [];
  const runtime = createDuties({
    dbPath: ':memory:',
    webhookSecret: SECRET,
    links: [{ repo: 'acme/widgets', installationId: 7, inviteId: OWNER }],
    inspector: { inspect: async () => FACTS },
    every: (fn, ms) => {
      const timer = { fn, ms, released: false };
      timers.push(timer);
      return () => {
        timer.released = true;
      };
    },
    ...over,
  });
  const started: unknown[] = [];
  const raised: unknown[] = [];
  const posted: Array<{ conversationId: string; text: string }> = [];
  const parts = {
    server: {
      startedConversation: () => undefined,
      startConversation: (input: { key: string }) => {
        started.push(input);
        return {
          ok: true as const,
          conversationId: `cnv_${started.length}`,
          messageId: 'm',
          duplicate: false,
        };
      },
      createConversation: (input: { key: string }) => ({
        ok: true as const,
        conversationId: `cnv_for_${input.key}`,
      }),
    },
    runsOf: () => [] as DutyRunView[],
    postNotice: async (conversationId: string, text: string) => {
      posted.push({ conversationId, text });
    },
    raiseProposal: (input: unknown) => {
      raised.push(input);
      return true;
    },
  };
  return { runtime, timers, started, raised, posted, parts };
}

const REGISTER = {
  repo: 'acme/widgets',
  installationId: 7,
  defaultBranch: 'main',
  selfLogins: ['maka-bot'],
};

test('a proposal is offered once the duties have started, as one item in a conversation made for it', async () => {
  const r = runtimeRig();
  const added = r.runtime.service.addProject(OWNER, REGISTER);
  assert.ok(added.ok);
  const projectId = (added.project as { projectId: string }).projectId;
  assert.deepEqual(await r.runtime.service.propose(OWNER, projectId), {
    ok: false,
    reason: 'unavailable',
  });
  r.runtime.start(r.parts as never);
  const proposed = await r.runtime.service.propose(OWNER, projectId);
  assert.ok(proposed.ok);
  assert.equal(r.raised.length, 1);
  const item = r.raised[0] as {
    conversationId: string;
    proposalId: string;
    sets: Array<{ id: string; recommended: boolean }>;
  };
  assert.match(item.conversationId, /^cnv_for_proposal:prp_/u);
  assert.equal(item.sets[0]?.id, 'recommended');
  assert.equal(item.sets.at(-1)?.id, 'none');
  await r.runtime.stop();
  r.runtime.close();
});

test('a proposal nobody can decide is not offered', async () => {
  for (const broken of ['no conversation', 'no supervisor'] as const) {
    const r = runtimeRig();
    const added = r.runtime.service.addProject(OWNER, REGISTER);
    assert.ok(added.ok);
    if (broken === 'no conversation') {
      r.parts.server.createConversation = () =>
        ({ ok: false as never, conversationId: '' }) as never;
    } else {
      r.parts.raiseProposal = () => false;
    }
    r.runtime.start(r.parts as never);
    const result = await r.runtime.service.propose(
      OWNER,
      (added.project as { projectId: string }).projectId,
    );
    assert.deepEqual(result, { ok: false, reason: 'unavailable' }, broken);
    await r.runtime.stop();
    r.runtime.close();
  }
});

test('a repository is claimed only by the invite and under the installation the operator tied it to', async () => {
  const r = runtimeRig();
  const SQUATTER = 'inv_0000000000ff';
  // Another invite names the allowlisted repository: refused, and it takes nothing from the owner.
  assert.deepEqual(r.runtime.service.addProject(SQUATTER, REGISTER), {
    ok: false,
    reason: 'not_allowed',
  });
  // The right invite under another installation id is refused too, and it squats nothing.
  assert.deepEqual(r.runtime.service.addProject(OWNER, { ...REGISTER, installationId: 8 }), {
    ok: false,
    reason: 'not_allowed',
  });
  assert.deepEqual(r.runtime.service.listProjects(SQUATTER), []);
  assert.deepEqual(r.runtime.service.listProjects(OWNER), []);
  assert.ok(r.runtime.service.addProject(OWNER, REGISTER).ok, 'the owner can still register it');
  // The repository belongs to one project: the squatter cannot take it after the owner either.
  assert.deepEqual(r.runtime.service.addProject(SQUATTER, REGISTER), {
    ok: false,
    reason: 'not_allowed',
  });
  r.runtime.close();
});

test('a project stored for one invite gets nothing once the operator ties the repository to another', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duties-host-'));
  try {
    const dbPath = join(dir, 'duties.db');
    const OTHER = 'inv_0000000000ff';
    const first = runtimeRig({ dbPath });
    const added = first.runtime.service.addProject(OWNER, REGISTER);
    assert.ok(added.ok);
    first.runtime.close();

    // The link now names another invite for the same repository and installation.
    const second = runtimeRig({
      dbPath,
      links: [{ repo: 'acme/widgets', installationId: 7, inviteId: OTHER }],
    });
    const body = Buffer.from(JSON.stringify(issuePayload(1)));
    const delivery = second.runtime.service.webhook(
      {
        'x-github-event': 'issues',
        'x-github-delivery': 'after-the-link-changed',
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
      body,
    );
    assert.equal(delivery.body.ignored, 'project_not_allowed');
    assert.equal(delivery.body.started, undefined);
    // New registration by the new invite is refused while the old project still holds the repository.
    assert.deepEqual(second.runtime.service.addProject(OTHER, REGISTER), {
      ok: false,
      reason: 'exists',
    });
    second.runtime.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only repositories the operator named can be registered, and only by the decision of the owner', async () => {
  const r = runtimeRig();
  assert.deepEqual(r.runtime.service.addProject(OWNER, { ...REGISTER, repo: 'evil/repo' }), {
    ok: false,
    reason: 'not_allowed',
  });
  assert.ok(
    r.runtime.service.addProject(OWNER, { ...REGISTER, repo: 'Acme/Widgets' }).ok,
    'case does not matter',
  );
  const none = runtimeRig({ links: [] });
  assert.equal(none.runtime.service.addProject(OWNER, REGISTER).ok, false, 'no list, no project');
  for (const caller of [undefined, 'inv_somebody_else']) {
    const proposed = await r.runtime.engine.propose(
      OWNER,
      (r.runtime.service.listProjects(OWNER)[0] as { projectId: string }).projectId,
      { inspect: async () => FACTS },
    );
    assert.ok(proposed.ok);
    assert.deepEqual(
      await r.runtime.proposals.decide(
        {
          proposalId: proposed.proposal.proposalId,
          setId: 'recommended',
          ...(caller === undefined ? {} : { caller }),
        },
        new AbortController().signal,
      ),
      { accepted: false, reason: 'forbidden' },
    );
  }
  r.runtime.close();
  none.runtime.close();
});

test('requests claimed before the start are launched by its first pass, and the timer is released on stop', async () => {
  const r = runtimeRig();
  const added = r.runtime.service.addProject(OWNER, REGISTER);
  assert.ok(added.ok);
  const projectId = (added.project as { projectId: string }).projectId;
  const proposed = await r.runtime.engine.propose(OWNER, projectId, { inspect: async () => FACTS });
  assert.ok(proposed.ok);
  assert.ok(
    r.runtime.engine.decideProposal({
      proposalId: proposed.proposal.proposalId,
      setId: 'recommended',
      caller: OWNER,
    }).ok,
  );
  const body = Buffer.from(JSON.stringify(issuePayload(1)));
  const delivery = r.runtime.service.webhook(
    {
      'x-github-event': 'issues',
      'x-github-delivery': 'd-before-start',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  );
  assert.equal(delivery.body.started, 1);
  assert.equal(r.started.length, 0, 'nothing starts a run before the start');

  r.runtime.start(r.parts as never);
  assert.throws(() => r.runtime.start(r.parts as never), /already/u);
  await eventuallyTrue(() => r.started.length === 1);
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0]?.released, false);

  await r.runtime.stop();
  assert.equal(r.timers[0]?.released, true, 'the timer is released');
  // A pass that was already due when the timer was released does nothing.
  const before = r.started.length;
  r.timers[0]?.fn();
  assert.equal(r.started.length, before);
  r.runtime.close();
});

/** Drives a project's issue duty to ten failed runs in a row, through the runtime's own passes. */
async function failTenTimes(r: ReturnType<typeof runtimeRig>) {
  const added = r.runtime.service.addProject(OWNER, REGISTER);
  assert.ok(added.ok);
  const projectId = (added.project as { projectId: string }).projectId;
  const proposed = await r.runtime.engine.propose(OWNER, projectId, { inspect: async () => FACTS });
  assert.ok(proposed.ok);
  assert.ok(
    r.runtime.engine.decideProposal({
      proposalId: proposed.proposal.proposalId,
      setId: 'recommended',
      caller: OWNER,
    }).ok,
  );
  const duty = () =>
    r.runtime.engine
      .project(OWNER, projectId)
      ?.duties.find((d) => d.trigger.kind === 'issue_opened' && d.activatedAt !== null);
  r.parts.runsOf = () => [
    {
      runId: 'run_x',
      dutyId: duty()?.dutyId ?? null,
      state: 'failed',
      spentUsd: 0,
      endReason: null,
    },
  ];
  r.runtime.start(r.parts as never);
  for (let n = 1; n <= 10; n += 1) {
    const body = Buffer.from(JSON.stringify(issuePayload(n)));
    const delivery = r.runtime.service.webhook(
      {
        'x-github-event': 'issues',
        'x-github-delivery': `d-${n}`,
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
      body,
    );
    assert.equal(delivery.body.started, 1);
    await eventuallyTrue(() => {
      r.runtime.tick();
      return (duty()?.consecutiveFailures ?? 0) === n || duty()?.state === 'off';
    });
  }
  return { duty, projectId };
}

test('a duty that turned itself off tells its owner, once, in a conversation of the project', async () => {
  const r = runtimeRig();
  const { duty, projectId } = await failTenTimes(r);
  assert.equal(duty()?.state, 'off');
  assert.equal(duty()?.offReason, 'failures');
  await eventuallyTrue(() => r.posted.length === 1);
  assert.equal(r.posted[0]?.conversationId, `cnv_for_duty-notice:${projectId}`);
  assert.match(r.posted[0]?.text ?? '', /failed 10 times in a row and has turned itself off/u);
  assert.equal(r.runtime.engine.pendingNotices().length, 0, 'and it is not owed again');
  r.runtime.tick();
  r.runtime.tick();
  await r.runtime.stop();
  assert.equal(r.posted.length, 1, 'later passes do not send it again');
  r.runtime.close();
});

test('a notice that could not be sent stays owed and goes out on a later pass; an owner who is gone is not told', async () => {
  const r = runtimeRig();
  let broken = true;
  let attempts = 0;
  r.parts.postNotice = async (conversationId, text) => {
    attempts += 1;
    if (broken) throw new Error('the conductor is not reachable');
    r.posted.push({ conversationId, text });
  };
  const { duty } = await failTenTimes(r);
  assert.equal(duty()?.state, 'off');
  await eventuallyTrue(() => attempts >= 1);
  assert.equal(r.posted.length, 0);
  assert.equal(r.runtime.engine.pendingNotices().length, 1, 'still owed after the failure');
  broken = false;
  await eventuallyTrue(() => {
    r.runtime.tick();
    return r.posted.length === 1;
  });
  await eventuallyTrue(() => r.runtime.engine.pendingNotices().length === 0);

  // An owner who is no longer active has nobody to tell: the notice is closed, not retried.
  const gone = runtimeRig();
  gone.parts.server.createConversation = (() => ({
    ok: false as const,
    reason: 'owner_inactive' as const,
  })) as never;
  await failTenTimes(gone);
  await eventuallyTrue(() => gone.runtime.engine.pendingNotices().length === 0);
  assert.equal(gone.posted.length, 0);
  await gone.runtime.stop();
  gone.runtime.close();
  await r.runtime.stop();
  r.runtime.close();
});

async function eventuallyTrue(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
