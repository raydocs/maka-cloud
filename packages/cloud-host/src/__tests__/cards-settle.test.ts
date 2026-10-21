import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DutyEngine } from '@maka-cloud/duties';
import { CardSettler } from '../cards/settle.js';
import type { DutyRunView } from '../duties/settle.js';

const OWNER = 'inv_000000000001';
const DAY0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const HOUR = 3_600_000;

function rig() {
  const clock = { t: DAY0 };
  const engine = new DutyEngine({
    dbPath: ':memory:',
    webhookSecret: 'a-webhook-secret-of-sufficient-length',
    allowProject: () => true,
    now: () => clock.t,
  });
  const added = engine.addProject(OWNER, {
    repo: 'acme/widgets',
    installationId: 7,
    defaultBranch: 'main',
    selfLogins: ['maka-bot'],
  });
  assert.ok(added.ok);
  const runs = new Map<string, DutyRunView[]>();
  const warnings: string[] = [];
  const settler = new CardSettler({
    engine,
    runsOf: (id) => {
      const found = runs.get(id);
      if (found === ('throw' as never)) throw new Error('unreadable');
      return found ?? [];
    },
    now: () => clock.t,
    onWarning: (m) => warnings.push(m),
  });
  let n = 0;
  const tapped = () => {
    n += 1;
    clock.t += 24 * HOUR;
    const made = engine.cards.propose(OWNER, added.project.projectId, {
      kind: 'fix_main_ci',
      subjectKey: `s${n}`,
      title: `Fix the failing test ${n}`,
      detail: 'd',
      brief: 'b',
      estimateUsd: 3,
      preconditionHash: 'a'.repeat(64),
      external: false,
    });
    assert.ok(made.ok);
    engine.cards.accept(OWNER, made.card.cardId);
    engine.cards.attachConversation(OWNER, made.card.cardId, `cnv_${n}`);
    return { cardId: made.card.cardId, conversationId: `cnv_${n}` };
  };
  return { engine, settler, runs, warnings, clock, tapped };
}

const run = (cardId: string, over: Partial<DutyRunView>): DutyRunView => ({
  runId: 'run_1',
  dutyId: `card:${cardId}`,
  state: 'done',
  spentUsd: 1.25,
  endReason: null,
  ...over,
});

test('a finished task is settled once with what it spent', () => {
  const r = rig();
  const t = r.tapped();
  r.runs.set(t.conversationId, [run(t.cardId, {})]);
  assert.equal(r.settler.settle(), 1);
  assert.equal(r.settler.settle(), 0, 'a second pass finds nothing to do');
  const card = r.engine.cards.get(OWNER, t.cardId);
  assert.equal(card?.outcome, 'completed');
  assert.equal(card?.spentUsd, 1.25);
  r.engine.close();
});

test('a task still running is left alone, and settled when it ends', () => {
  const r = rig();
  const t = r.tapped();
  for (const state of ['active', 'waiting', 'delivering'] as const) {
    r.runs.set(t.conversationId, [run(t.cardId, { state, spentUsd: 0.5 })]);
    assert.equal(r.settler.settle(), 0, state);
  }
  r.runs.set(t.conversationId, [
    run(t.cardId, { state: 'failed', spentUsd: 4, endReason: 'budget_limit' }),
  ]);
  assert.equal(r.settler.settle(), 1);
  assert.equal(r.engine.cards.get(OWNER, t.cardId)?.outcome, 'failed');
  r.engine.close();
});

test('a person’s stop is stopped; any other end of a cancelled run, and an interrupted one, is failed', () => {
  const r = rig();
  const cases: Array<[Partial<DutyRunView>, string]> = [
    [{ state: 'cancelled', endReason: 'user_stop' }, 'stopped'],
    [{ state: 'cancelled', endReason: 'paused' }, 'stopped'],
    [{ state: 'cancelled', endReason: 'budget_limit' }, 'failed'],
    [{ state: 'cancelled', endReason: null }, 'failed'],
    [{ state: 'interrupted' }, 'failed'],
  ];
  for (const [over, expected] of cases) {
    const t = r.tapped();
    r.runs.set(t.conversationId, [run(t.cardId, over)]);
    r.settler.settle();
    assert.equal(r.engine.cards.get(OWNER, t.cardId)?.outcome, expected, JSON.stringify(over));
  }
  r.engine.close();
});

test('only the card’s own run counts, not another run in the same conversation', () => {
  const r = rig();
  const t = r.tapped();
  r.runs.set(t.conversationId, [
    run(t.cardId, { dutyId: null, spentUsd: 9 }),
    run(t.cardId, { dutyId: 'card:someone_else', spentUsd: 8 }),
  ]);
  assert.equal(r.settler.settle(), 0);
  r.runs.set(t.conversationId, [
    run(t.cardId, { dutyId: null, spentUsd: 9 }),
    run(t.cardId, { spentUsd: 2 }),
  ]);
  assert.equal(r.settler.settle(), 1);
  assert.equal(r.engine.cards.get(OWNER, t.cardId)?.spentUsd, 2);
  r.engine.close();
});

test('a task that never got its run is written off after a day, spending nothing', () => {
  const r = rig();
  const t = r.tapped();
  assert.equal(r.settler.settle(), 0);
  r.clock.t += 24 * HOUR - 1;
  assert.equal(r.settler.settle(), 0);
  r.clock.t += 1;
  assert.equal(r.settler.settle(), 1);
  const card = r.engine.cards.get(OWNER, t.cardId);
  assert.equal(card?.outcome, 'abandoned');
  assert.equal(card?.spentUsd, 0);
  r.engine.close();
});

test('a conversation that cannot be read holds up no other card', () => {
  const r = rig();
  const bad = r.tapped();
  const good = r.tapped();
  r.runs.set(bad.conversationId, 'throw' as never);
  r.runs.set(good.conversationId, [run(good.cardId, {})]);
  assert.equal(r.settler.settle(), 1);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.engine.cards.get(OWNER, bad.cardId)?.outcome, null, 'tried again next pass');
  r.runs.set(bad.conversationId, [run(bad.cardId, {})]);
  assert.equal(r.settler.settle(), 1);
  r.engine.close();
});
