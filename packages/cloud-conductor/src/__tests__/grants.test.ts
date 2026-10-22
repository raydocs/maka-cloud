import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { z } from 'zod';
import type { ConductorOptions, UserMessage } from '../conductor.js';
import { DEFAULT_LIMITS } from '../config.js';
import { DEFAULT_PLAYBOOKS } from '../playbooks.js';
import {
  CONDUCTOR_MIGRATIONS,
  GRANT_TTL_MS,
  migrateConductorDb,
  type QuestionRow,
} from '../state.js';
import { type ConductorToolSpec, conductorTools, type ToolHost } from '../tools.js';
import { calls, type ModelRequest, refusal, text, tool, toolResults } from './fake-model.js';
import { type Harness, makeHarness } from './harness.js';

/**
 * Scoped approvals: the owner keeps an approval beyond one call, as a grant the owner can revoke.
 * The tool is an irreversible one that names its repository and pins `draft`.
 */

const OWNER = 'inv_a';
const OTHER = 'inv_b';
const TOOL = 'open_pr';

interface Env {
  h: Harness;
  ran: Array<{ args: Record<string, unknown>; approved: string | undefined }>;
  clock: { now: number };
  /** The invites that are active, and who owns each conversation. */
  active: Set<string>;
  owners: Map<string, string>;
}

type Args = { repo: string; title: string; draft?: boolean };

async function setup(
  t: TestContext,
  options: {
    conductor?: Partial<ConductorOptions>;
    spec?: Partial<ConductorToolSpec>;
  } = {},
): Promise<Env> {
  const ran: Env['ran'] = [];
  const clock = { now: 1_800_000_000_000 };
  const active = new Set([OWNER, OTHER]);
  const owners = new Map([
    ['cnv_1', OWNER],
    ['cnv_2', OWNER],
    ['cnv_other', OTHER],
  ]);
  const spec: ConductorToolSpec = {
    name: TOOL,
    description: 'Open a pull request.',
    parameters: z.object({ repo: z.string(), title: z.string(), draft: z.boolean().optional() }),
    irreversible: true,
    effects: ['writes_outside_sandbox', 'irreversible'],
    requiresAuthority: 'open-pr',
    externalResult: false,
    approvalDetails: (args: Args) => `Repository: ${args.repo}`,
    grantScope: (args: Args) => ({ repository: args.repo, fixed: { draft: args.draft ?? false } }),
    impl: async (args, context) => {
      ran.push({ args, approved: context.approved });
      return { ok: true };
    },
    ...options.spec,
  } as ConductorToolSpec;
  const h = await makeHarness(t, {
    conductor: {
      tools: [spec],
      now: () => clock.now,
      approverAuthorized: (owner, conversationId) =>
        owner !== null && active.has(owner) && owners.get(conversationId) === owner,
      ...options.conductor,
    },
  });
  return { h, ran, clock, active, owners };
}

const verdict = (request: ModelRequest) => {
  const [result] = toolResults(request);
  return result?.isError ? (/^(\w+):/.exec(refusal(result))?.[1] ?? 'error') : 'ran';
};
const refOf = (request: ModelRequest) =>
  /actionRef "(act_\w+)"/.exec(refusal(toolResults(request)[0]))?.[1];

const idsOf = (question: QuestionRow | { options: Array<{ id: string }> }) =>
  question.options.map((option) => option.id);

/** The model calls the tool, is held, and asks. Returns the card and the held call's ref. */
async function held(
  env: Env,
  call: Args,
  conversationId = 'cnv_1',
  recommended: 'approve' | 'reject' = 'approve',
  message: { external?: boolean; run?: UserMessage['run'] } = {},
) {
  const { h } = env;
  let ref: string | undefined;
  h.model.script('conductor', calls(tool(TOOL, call)), (request) => {
    ref = refOf(request);
    assert.ok(ref, refusal(toolResults(request)[0]));
    return calls(
      tool('ask_user', {
        reason: 'irreversible',
        question: 'Open it?',
        actionRef: ref,
        recommended,
      }),
    );
  });
  const before = h.outbox.questions.length;
  await h.conductor.onUserMessage(
    {
      conversationId,
      messageId: `msg_${before}_${conversationId}`,
      text: 'Open the pull request.',
      ...message,
    },
    h.access(conversationId),
  );
  await h.conductor.idle();
  const question = h.outbox.questions[before];
  assert.ok(question && ref, 'a card was asked');
  return { question, ref };
}

/** Answers the card, then the model calls the approved call and `next` (each a call, reporting its verdict). */
async function approve(
  env: Env,
  card: { question: { questionId: string }; ref: string },
  call: Args,
  optionId: string,
  next: Args[] = [],
  conversationId = 'cnv_1',
  caller: string | null = OWNER,
): Promise<string[]> {
  const { h } = env;
  const seen: string[] = [];
  const steps = [call, ...next].map((args, index) => (request: ModelRequest) => {
    if (index > 0) seen.push(verdict(request));
    return calls(tool(TOOL, index === 0 ? { ...args, actionRef: card.ref } : args));
  });
  h.model.script('conductor', ...steps, (request) => {
    seen.push(verdict(request));
    return text('Done.');
  });
  await h.answer(conversationId, card.question.questionId, optionId, caller ?? undefined);
  await h.conductor.idle();
  return seen;
}

/** A new run in the conversation: the model calls the tool once with no actionRef and reports what happened. */
async function again(env: Env, call: Args, conversationId = 'cnv_1'): Promise<string> {
  const { h } = env;
  let result = '';
  h.model.script('conductor', calls(tool(TOOL, call)), (request) => {
    result = verdict(request);
    return text('Done.');
  });
  await h.send(conversationId, 'Another one.');
  await h.conductor.idle();
  return result;
}

const usesOf = (env: Env) =>
  env.h.conductor.state.db
    .prepare('SELECT grant_id, run_id, conversation_id, args FROM grant_uses')
    .all();

test('a tool that names its repository offers "this task" and "this repository" next to this once, and the card is unchanged', async (t) => {
  const env = await setup(t);
  const plain = await setup(t, { spec: { grantScope: undefined } });
  const call = { repo: 'acme/widgets', title: 'Fix it' };
  const a = await held(env, call);
  const b = await held(plain, call);

  assert.deepEqual(idsOf(a.question), ['approve', 'approve_task', 'approve_repository', 'reject']);
  assert.deepEqual(idsOf(b.question), ['approve', 'reject']);
  assert.equal(a.question.question, b.question.question, 'the card the owner approves is the same');
  assert.equal(a.question.recommended, 'approve');
  const stored = env.h.conductor.state.question(a.question.questionId);
  assert.deepEqual(stored?.grantCandidate, {
    tool: TOOL,
    repository: 'acme/widgets',
    fixed: { draft: false },
  });
});

test('this once leaves nothing behind: the next call asks again', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  const seen = await approve(env, card, first, 'approve', [{ repo: 'acme/widgets', title: 'Two' }]);
  assert.deepEqual(seen, ['ran', 'needs_approval']);
  assert.deepEqual(env.h.conductor.state.grantsOf(OWNER), []);
  assert.equal(env.ran.length, 1);
});

test('"this repository" covers later calls in that repository, in any run and conversation of the owner, with an audit row and a notice; not another repository or other pinned arguments', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  const seen = await approve(env, card, first, 'approve_repository', [
    { repo: 'acme/widgets', title: 'Two' },
    { repo: 'acme/other', title: 'Three' },
    { repo: 'acme/widgets', title: 'Four', draft: true },
  ]);
  assert.deepEqual(seen, ['ran', 'ran', 'needs_approval', 'needs_approval']);
  const [grant] = env.h.conductor.state.grantsOf(OWNER);
  assert.ok(grant);
  assert.equal(grant.scope, 'repository');
  assert.equal(grant.repository, 'acme/widgets');
  assert.equal(grant.runId, null);
  assert.equal(grant.expiresAt - grant.createdAt, GRANT_TTL_MS.repository);

  // Another run, another conversation of the same owner.
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Five' }, 'cnv_2'), 'ran');
  const titles = env.ran.map((entry) => entry.args.title);
  assert.deepEqual(titles, ['One', 'Two', 'Five']);
  const uses = usesOf(env);
  assert.equal(uses.length, 2);
  assert.equal(uses[1]?.conversation_id, 'cnv_2');
  assert.ok(
    env.h.outbox.notices.some((n) =>
      /keep going in this repository \(acme\/widgets\)/.test(n.text),
    ),
    JSON.stringify(env.h.outbox.notices),
  );
  // The tool is still given the card as it reads now, to check what it acts on against it.
  assert.match(String(env.ran[2]?.approved), /Repository: acme\/widgets$/);
});

test('"this task" covers later calls of the same run only', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  const seen = await approve(env, card, first, 'approve_task', [
    { repo: 'acme/widgets', title: 'Two' },
    { repo: 'acme/other', title: 'Three' },
  ]);
  assert.deepEqual(seen, ['ran', 'ran', 'needs_approval']);
  const [grant] = env.h.conductor.state.grantsOf(OWNER);
  assert.equal(grant?.scope, 'task');
  assert.ok(grant?.runId);
  assert.equal(grant?.expiresAt - grant?.createdAt, GRANT_TTL_MS.task);
  // A later run of the same conversation starts without it.
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Four' }), 'needs_approval');
});

test('revoking a grant stops the very next call; only its owner can revoke it', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  await approve(env, card, first, 'approve_repository');
  const { state } = env.h.conductor;
  const [grant] = state.grantsOf(OWNER);
  assert.ok(grant);
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Two' }), 'ran');

  assert.equal(state.revokeGrant(OTHER, grant.grantId), false);
  assert.equal(state.grantsOf(OWNER).length, 1);
  assert.equal(state.revokeGrant(OWNER, grant.grantId), true);
  assert.equal(state.revokeGrant(OWNER, grant.grantId), false);
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Three' }), 'needs_approval');
  assert.deepEqual(state.grantsOf(OWNER), []);
  assert.equal(state.grantsOf(OWNER, { all: true }).length, 1);
  // The uses stay on record.
  assert.equal(state.grantUses(grant.grantId).length, 1);
});

test("revoking by filter revokes only the owner's grants that match", async (t) => {
  const env = await setup(t);
  const { state } = env.h.conductor;
  for (const [repo, optionId] of [
    ['acme/widgets', 'approve_repository'],
    ['acme/gadgets', 'approve_repository'],
  ] as const) {
    const call = { repo, title: 'One' };
    const card = await held(env, call);
    await approve(env, card, call, optionId);
  }
  assert.equal(state.grantsOf(OWNER).length, 2);
  assert.equal(state.revokeGrants(OTHER), 0);
  assert.equal(state.revokeGrants(OWNER, { repository: 'acme/gadgets' }), 1);
  assert.deepEqual(
    state.grantsOf(OWNER).map((grant) => grant.repository),
    ['acme/widgets'],
  );
  assert.equal(state.revokeGrants(OWNER), 1);
  assert.deepEqual(state.grantsOf(OWNER), []);
});

test('a grant expires', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  await approve(env, card, first, 'approve_repository');
  env.clock.now += GRANT_TTL_MS.repository - 1;
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Two' }), 'ran');
  env.clock.now += 2;
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Three' }), 'needs_approval');
  assert.deepEqual(env.h.conductor.state.grantsOf(OWNER), []);
});

test('a grant is used only while its owner is still allowed: a revoked invite, or a conversation that is not theirs, gets a card', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  await approve(env, card, first, 'approve_repository');

  // Someone else's conversation never uses the owner's grant.
  assert.equal(
    await again(env, { repo: 'acme/widgets', title: 'Two' }, 'cnv_other'),
    'needs_approval',
  );
  env.active.delete(OWNER);
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Three' }), 'needs_approval');
  assert.deepEqual(
    env.ran.map((entry) => entry.args.title),
    ['One'],
  );
  env.active.add(OWNER);
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Four' }), 'ran');
});

test('an answer is bound to its scope: another scope on the same card is refused, the same one is a no-op, and one grant results', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  const { state } = env.h.conductor;
  const questionId = card.question.questionId;
  const answered = state.answer('cnv_1', questionId, 'approve_task', undefined, OWNER);
  assert.equal(answered.accepted, true);
  assert.deepEqual(state.answer('cnv_1', questionId, 'approve_repository', undefined, OWNER), {
    accepted: false,
    reason: 'conflict',
  });
  assert.deepEqual(state.answer('cnv_1', questionId, 'approve', undefined, OWNER), {
    accepted: false,
    reason: 'conflict',
  });
  const again = state.answer('cnv_1', questionId, 'approve_task', undefined, OWNER);
  assert.equal(again.accepted && again.duplicate, true);
  assert.equal(state.grantsOf(OWNER).length, 1);
  assert.equal(state.grantsOf(OWNER)[0]?.scope, 'task');
});

test('a scope that is not on the card is refused, and an answer with no one behind it grants nothing (the host does not use its approval either)', async (t) => {
  const env = await setup(t, { spec: { grantScope: undefined } });
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  const { state } = env.h.conductor;
  assert.deepEqual(
    state.answer('cnv_1', card.question.questionId, 'approve_repository', undefined, OWNER),
    {
      accepted: false,
      reason: 'unknown_option',
    },
  );

  const env2 = await setup(t);
  const card2 = await held(env2, first);
  const seen = await approve(env2, card2, first, 'approve_repository', [], 'cnv_1', null);
  assert.deepEqual(seen, ['not_approved']);
  assert.deepEqual(env2.h.conductor.state.grantsOf(OWNER), []);
});

test('a standing duty never uses a grant and is never offered a scope', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  await approve(env, card, first, 'approve_repository');
  assert.equal(env.h.conductor.state.grantsOf(OWNER).length, 1);

  // A duty run in a conversation the owner owns, with authority to open pull requests: the owner's
  // grant does not stand in for its card, and the card it asks has no scope.
  env.owners.set('cnv_duty', OWNER);
  const duty = await held(env, { repo: 'acme/widgets', title: 'Duty' }, 'cnv_duty', 'approve', {
    run: { dutyId: 'dty_1', authority: 'open-pr', budgetUsd: 5 },
  });
  assert.deepEqual(idsOf(duty.question), ['approve', 'reject']);
  assert.equal(usesOf(env).length, 0);
  assert.deepEqual(
    env.ran.map((entry) => entry.args.title),
    ['One'],
  );
});

test('the taint hold is not covered: a conversation that read outside content is held for a card, and offered no scope', async (t) => {
  const env = await setup(t);
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  await approve(env, card, first, 'approve_repository');

  // The owner's second conversation starts from a message by someone else, which taints it.
  const tainted = await held(env, { repo: 'acme/widgets', title: 'Two' }, 'cnv_2', 'approve', {
    external: true,
  });
  assert.deepEqual(idsOf(tainted.question), ['approve', 'reject']);
  assert.deepEqual(
    env.ran.map((entry) => entry.args.title),
    ['One'],
  );
  assert.equal(usesOf(env).length, 0);
});

test('with grantsCoverTaint on, a grant also covers a tainted conversation, and the scope is offered there', async (t) => {
  const env = await setup(t, { conductor: { grantsCoverTaint: true } });
  const first = { repo: 'acme/widgets', title: 'One' };
  env.h.conductor.state.taint('cnv_1', 'test');
  const card = await held(env, first);
  assert.deepEqual(idsOf(card.question), [
    'approve',
    'approve_task',
    'approve_repository',
    'reject',
  ]);
  await approve(env, card, first, 'approve_repository');
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'Two' }), 'ran');
});

test('a delegation held for taint is never offered a scope, and a tool that cannot name its call gets none', async (t) => {
  const env = await setup(t, {
    spec: { grantScope: () => undefined },
  });
  const card = await held(env, { repo: 'acme/widgets', title: 'One' });
  assert.deepEqual(idsOf(card.question), ['approve', 'reject']);
  assert.equal(env.h.conductor.state.question(card.question.questionId)?.grantCandidate, null);

  // delegate_task in a tainted conversation is held; its card has no scope.
  const h = env.h;
  h.conductor.state.taint('cnv_2', 'test');
  let ref: string | undefined;
  h.model.script(
    'conductor',
    calls(tool('delegate_task', { runner: 'claude-agent-sdk', brief: 'Do it.', budgetUsd: 1 })),
    (request) => {
      ref = refOf(request);
      assert.ok(ref, refusal(toolResults(request)[0]));
      return calls(
        tool('ask_user', {
          reason: 'irreversible',
          question: 'Send it?',
          actionRef: ref,
          recommended: 'reject',
        }),
      );
    },
  );
  await h.send('cnv_2', 'Delegate.');
  await h.conductor.idle();
  const question = h.outbox.questions.at(-1);
  assert.equal(
    question?.action && 'tool' in question.action && question.action.tool,
    'delegate_task',
  );
  assert.deepEqual(question && idsOf(question), ['reject', 'approve']);
});

test('a scope that fails or names nothing usable is no scope, and the call is held as before', async (t) => {
  for (const grantScope of [
    () => {
      throw new Error('boom');
    },
    () => ({ repository: '' }),
    () => ({ repository: 'x'.repeat(301) }),
    () => ({ repository: 'acme/widgets', fixed: { nested: { a: 1 } } }),
  ]) {
    const env = await setup(t, { spec: { grantScope: grantScope as never } });
    const card = await held(env, { repo: 'acme/widgets', title: 'One' });
    assert.deepEqual(idsOf(card.question), ['approve', 'reject']);
  }
});

test('only an irreversible tool that does not spend may declare a scope', () => {
  const host = { playbooks: DEFAULT_PLAYBOOKS, limits: DEFAULT_LIMITS } as unknown as ToolHost;
  const spec = (overrides: Partial<ConductorToolSpec>): ConductorToolSpec =>
    ({
      name: 'other_tool',
      description: 'A tool.',
      parameters: z.object({ repo: z.string() }),
      irreversible: true,
      effects: ['writes_outside_sandbox', 'irreversible'],
      externalResult: false,
      grantScope: (args: { repo: string }) => ({ repository: args.repo }),
      impl: async () => ({}),
      ...overrides,
    }) as ConductorToolSpec;
  assert.doesNotThrow(() => conductorTools(host, [spec({})]));
  assert.throws(
    () => conductorTools(host, [spec({ irreversible: false, effects: ['sends'] })]),
    /cannot offer a scope/,
  );
  assert.throws(
    () => conductorTools(host, [spec({ effects: ['spends', 'irreversible'] })]),
    /cannot offer a scope/,
  );
  assert.throws(
    () => conductorTools(host, [spec({ name: 'delegate_task' })]),
    /cannot offer a scope/,
  );
});

test('a call that carries a key is not covered by a grant', async (t) => {
  const env = await setup(t, {
    conductor: { carriesSecret: (value) => JSON.stringify(value).includes('sk-live') },
  });
  const first = { repo: 'acme/widgets', title: 'One' };
  const card = await held(env, first);
  await approve(env, card, first, 'approve_repository');
  assert.equal(
    await again(env, { repo: 'acme/widgets', title: 'key sk-live-123' }),
    'needs_approval',
  );
  assert.equal(await again(env, { repo: 'acme/widgets', title: 'fine' }), 'ran');
});

test('the migration adds grants to a database from before them and keeps its questions', () => {
  const db = new DatabaseSync(':memory:');
  for (const step of CONDUCTOR_MIGRATIONS.slice(0, CONDUCTOR_MIGRATIONS.length - 1)) {
    if (typeof step === 'string') db.exec(step);
    else step(db);
  }
  db.exec(`PRAGMA user_version = ${CONDUCTOR_MIGRATIONS.length - 1}`);
  migrateConductorDb(db);
  db.exec(
    "INSERT INTO grants (grant_id, owner, tool, repository, fixed, scope, conversation_id, question_id, created_at, expires_at) VALUES ('g', 'o', 't', 'r', '{}', 'task', 'c', 'q', 1, 2)",
  );
  db.exec(
    "INSERT INTO grant_uses (grant_id, run_id, conversation_id, args, at) VALUES ('g', 'r', 'c', '{}', 1)",
  );
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  assert.ok(tables.some((table) => table.name === 'grants'));
  assert.ok(tables.some((table) => table.name === 'grant_uses'));
  assert.throws(() => db.exec('UPDATE grant_uses SET at = 1'), /never changed/);
  assert.throws(() => db.exec('DELETE FROM grant_uses'), /never changed/);
});
