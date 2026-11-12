import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  AUTOMATION_MAX_ERRORS,
  AutomationStore,
  Automations,
  type AutomationPorts,
  type DeliverOutcome,
  deliveryKey,
  waitForTool,
} from '../automations.js';

interface Posted {
  conversationId: string;
  key: string;
  text: string;
  external: boolean;
}

/** A conversation store that keeps one message per key, as the server's does. */
function fakeWorld() {
  const posted = new Map<string, Posted>();
  const reports: Array<{ automationId: string; needsYou: boolean }> = [];
  const pr = { state: 'open' as 'open' | 'closed' | 'merged', headSha: 'a'.repeat(40) };
  const checks = { state: 'pending' as string, failing: [] as Array<{ name: string }> };
  const tasks = new Map<string, string>();
  let gone = false;
  let deliverThrows = 0;
  let checksThrow = false;
  let clock = Date.parse('2026-11-12T00:00:00Z');
  let checkCalls = 0;
  const ports: AutomationPorts = {
    checks: {
      pullRequest: async () => {
        checkCalls += 1;
        if (checksThrow) throw new Error('GitHub answered 502');
        return { ...pr };
      },
      checks: async () => ({ ...checks }) as never,
    },
    taskState: (_conversationId, taskId) => tasks.get(taskId),
    deliver: (input): DeliverOutcome => {
      if (deliverThrows > 0) {
        deliverThrows -= 1;
        throw new Error('database is locked');
      }
      if (gone) return 'gone';
      if (!posted.has(input.key)) posted.set(input.key, input);
      return 'delivered';
    },
    report: (item) => reports.push({ automationId: item.automationId, needsYou: item.needsYou }),
    now: () => clock,
  };
  return {
    ports,
    posted,
    reports,
    pr,
    checks,
    tasks,
    advance: (ms: number) => {
      clock += ms;
    },
    setGone: (value: boolean) => {
      gone = value;
    },
    failDeliveries: (n: number) => {
      deliverThrows = n;
    },
    setChecksThrow: (value: boolean) => {
      checksThrow = value;
    },
    checkCalls: () => checkCalls,
  };
}

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'automations-test-'));
  const path = join(dir, 'automations.db');
  const world = fakeWorld();
  const stores: AutomationStore[] = [];
  const running: Automations[] = [];
  const open = () => {
    const store = new AutomationStore(path);
    stores.push(store);
    const automations = new Automations(store, world.ports);
    running.push(automations);
    return { store, automations };
  };
  t.after(async () => {
    for (const automations of running) await automations.stop();
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // closed by the test
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { world, open };
}

const PR = { kind: 'pr_checks_finished' as const, repo: 'acme/app', pr: 7 };

test('a pull request wait matches once its checks have spoken and posts the resume text once', async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  const wait = automations.register({
    conversationId: 'cnv_1',
    condition: PR,
    resumeText: 'Checks are done: look at the result and continue.',
  });
  await automations.kick();
  assert.equal(world.posted.size, 0);
  assert.equal(automations.list('cnv_1')[0]?.state, 'watching');

  world.checks.state = 'failed';
  world.checks.failing = [{ name: 'test' }];
  world.advance(61_000);
  await automations.kick();
  const [message] = [...world.posted.values()];
  assert.equal(world.posted.size, 1);
  assert.equal(message?.conversationId, 'cnv_1');
  assert.equal(message?.external, true);
  assert.match(message?.text ?? '', /^Checks are done/u);
  assert.match(message?.text ?? '', /checks failed \(failing: test\)/u);
  assert.match(message?.text ?? '', /not an instruction/u);
  const [done] = automations.list('cnv_1');
  assert.equal(done?.state, 'delivered');
  assert.equal(done?.id, wait.id);
  assert.equal(done?.matchKey, `checks:${'a'.repeat(40)}:failed`);
});

test('duplicate wakes (nudges, repeated passes) deliver a match at most once', async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  automations.register({ conversationId: 'cnv_1', condition: PR, resumeText: 'go on' });
  world.checks.state = 'passed';
  await Promise.all([
    automations.kick(),
    automations.kick(),
    (async () => automations.nudge())(),
    automations.kick(),
  ]);
  automations.nudge();
  await automations.kick();
  world.advance(10 * 60_000);
  await automations.kick();
  assert.equal(world.posted.size, 1);
  assert.equal(automations.list('cnv_1')[0]?.state, 'delivered');
});

test('a match survives a failed delivery and a restart, and is posted once under the same key', async (t) => {
  const { world, open } = await setup(t);
  const first = open();
  first.automations.register({ conversationId: 'cnv_1', condition: PR, resumeText: 'go on' });
  world.checks.state = 'passed';
  world.failDeliveries(1_000);
  await first.automations.kick();
  assert.equal(world.posted.size, 0);
  world.failDeliveries(0);
  const [matched] = first.automations.list('cnv_1');
  assert.equal(matched?.state, 'matched');
  await first.automations.stop();
  first.store.close();

  // Upstream changes after the match: the match is final, the restart posts what matched.
  world.checks.state = 'pending';
  const second = open();
  await second.automations.kick();
  assert.equal(world.posted.size, 1);
  assert.equal([...world.posted.keys()][0], deliveryKey(matched!));
  assert.equal(second.automations.list('cnv_1')[0]?.state, 'delivered');
});

test('a restart resumes a watching wait where it was', async (t) => {
  const { world, open } = await setup(t);
  const first = open();
  first.automations.register({ conversationId: 'cnv_1', condition: PR, resumeText: 'go on' });
  await first.automations.kick();
  await first.automations.stop();
  first.store.close();

  const second = open();
  assert.equal(second.automations.list('cnv_1')[0]?.state, 'watching');
  world.checks.state = 'passed';
  world.advance(61_000);
  await second.automations.kick();
  assert.equal(world.posted.size, 1);
});

test('the user’s stop wins: a stopped conversation is never woken, even by a match already made', async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  automations.register({ conversationId: 'cnv_1', condition: PR, resumeText: 'go on' });
  automations.register({ conversationId: 'cnv_2', condition: PR, resumeText: 'go on' });
  world.checks.state = 'passed';
  world.failDeliveries(1_000);
  await automations.kick();
  world.failDeliveries(0);
  assert.deepEqual(
    automations.list('cnv_1').map((a) => a.state),
    ['matched'],
  );
  assert.equal(automations.onUserStop('cnv_1'), 1);
  await automations.kick();
  assert.equal(automations.list('cnv_1')[0]?.state, 'blocked');
  assert.equal(automations.list('cnv_2')[0]?.state, 'delivered');
  assert.deepEqual(
    [...world.posted.values()].map((p) => p.conversationId),
    ['cnv_2'],
  );
});

test('a conversation that is gone blocks the wait instead of posting', async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  automations.register({ conversationId: 'cnv_1', condition: PR, resumeText: 'go on' });
  world.checks.state = 'passed';
  world.setGone(true);
  await automations.kick();
  assert.equal(automations.list('cnv_1')[0]?.state, 'blocked');
  assert.equal(world.posted.size, 0);
});

test('a busy conversation still gets the wake: delivery is a queued message, not a turn', async (t) => {
  // The server queues a message behind a running turn; here the port only sees one post per key,
  // whatever the conversation is doing, and the wait is done once the message is stored.
  const { world, open } = await setup(t);
  const { automations } = open();
  automations.register({
    conversationId: 'cnv_1',
    condition: { kind: 'task_finished', taskId: 'tsk_1' },
    resumeText: 'The task ended.',
  });
  world.tasks.set('tsk_1', 'running');
  await automations.kick();
  assert.equal(world.posted.size, 0);
  world.tasks.set('tsk_1', 'succeeded');
  automations.nudge((condition) => condition.kind === 'task_finished');
  await automations.kick();
  assert.equal(world.posted.size, 1);
  assert.equal([...world.posted.values()][0]?.external, false);
});

test(`${AUTOMATION_MAX_ERRORS} failed checks in a row fail the wait and raise one item`, async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  automations.register({ conversationId: 'cnv_1', condition: PR, resumeText: 'go on' });
  world.setChecksThrow(true);
  const seen: number[] = [];
  while (automations.list('cnv_1')[0]?.state === 'watching') {
    await automations.kick();
    seen.push(automations.list('cnv_1')[0]?.consecutiveErrors ?? -1);
    world.advance(61_000);
  }
  // The check made when the wait was registered found nothing yet; then five failures in a row.
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
  const [failed] = automations.list('cnv_1');
  assert.equal(failed?.state, 'failed');
  assert.match(failed?.lastError ?? '', /502/u);
  world.advance(61_000);
  await automations.kick();
  assert.deepEqual(world.reports, [{ automationId: failed!.id, needsYou: true }]);
  assert.equal(world.posted.size, 0);
});

test('a successful check resets the error count', async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  automations.register({ conversationId: 'cnv_1', condition: PR, resumeText: 'go on' });
  world.setChecksThrow(true);
  await automations.kick();
  world.advance(61_000);
  world.setChecksThrow(false);
  await automations.kick();
  assert.equal(automations.list('cnv_1')[0]?.consecutiveErrors, 0);
});

test('an expired wait ends quietly with one item and no wake', async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  automations.register({
    conversationId: 'cnv_1',
    condition: PR,
    resumeText: 'go on',
    everySeconds: 60,
    expiresInSeconds: 120,
  });
  await automations.kick();
  world.advance(121_000);
  await automations.kick();
  await automations.kick();
  assert.equal(automations.list('cnv_1')[0]?.state, 'expired');
  assert.equal(world.reports.length, 1);
  assert.equal(world.reports[0]?.needsYou, false);
  assert.equal(world.posted.size, 0);
});

test('checks run only when due, and an `at` wait matches at its time', async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  automations.register({
    conversationId: 'cnv_1',
    condition: PR,
    resumeText: 'go on',
    everySeconds: 300,
  });
  await automations.kick();
  await automations.kick();
  world.advance(60_000);
  await automations.kick();
  assert.equal(world.checkCalls(), 1);
  automations.register({
    conversationId: 'cnv_2',
    condition: { kind: 'at', time: new Date(Date.parse('2026-11-12T00:03:00Z')).toISOString() },
    resumeText: 'time to look again',
  });
  await automations.kick();
  assert.equal(world.posted.size, 0);
  world.advance(3 * 60_000);
  await automations.kick();
  assert.equal([...world.posted.values()][0]?.conversationId, 'cnv_2');
});

test('cancel stops an open wait of the same conversation only', async (t) => {
  const { world, open } = await setup(t);
  const { automations } = open();
  const wait = automations.register({
    conversationId: 'cnv_1',
    condition: PR,
    resumeText: 'go on',
  });
  assert.equal(automations.cancel('cnv_2', wait.id), false);
  assert.equal(automations.cancel('cnv_1', wait.id), true);
  assert.equal(automations.cancel('cnv_1', wait.id), false);
  world.checks.state = 'passed';
  await automations.kick();
  assert.equal(world.posted.size, 0);
});

test('register refuses what it cannot keep', async (t) => {
  const { open } = await setup(t);
  const { automations } = open();
  const base = { conversationId: 'cnv_1', condition: PR, resumeText: 'go on' };
  assert.throws(() => automations.register({ ...base, everySeconds: 5 }), RangeError);
  assert.throws(() => automations.register({ ...base, expiresInSeconds: 30 * 86_400 }), RangeError);
  assert.throws(() => automations.register({ ...base, resumeText: '  ' }), RangeError);
  assert.throws(() =>
    automations.register({
      ...base,
      condition: { kind: 'pr_checks_finished', repo: 'no slash', pr: 1 },
    }),
  );
  for (let i = 0; i < 8; i += 1) automations.register(base);
  assert.throws(() => automations.register(base), RangeError);
});

test('wait_for registers for the calling conversation and refuses a task it did not delegate', async (t) => {
  const { open } = await setup(t);
  const { automations } = open();
  const tool = waitForTool({
    automations,
    ownsConversationTask: (conversationId, taskId) =>
      conversationId === 'cnv_1' && taskId === 'tsk_mine',
  });
  assert.equal(tool.name, 'wait_for');
  assert.deepEqual(tool.effects, []);
  const context = { runId: 'run_1', conversationId: 'cnv_1', signal: new AbortController().signal };
  const result = (await tool.impl(
    tool.parameters.parse({ condition: PR, resumeText: 'Checks done; continue.' }),
    context as never,
  )) as { registered: { id: string; state: string } };
  assert.equal(result.registered.state, 'watching');
  assert.equal(automations.list('cnv_1')[0]?.id, result.registered.id);
  await assert.rejects(
    async () =>
      tool.impl(
        tool.parameters.parse({
          condition: { kind: 'task_finished', taskId: 'tsk_other' },
          resumeText: 'x',
        }),
        context as never,
      ),
    (error: Error) =>
      error.name === 'ToolRefusal' || /not_your_task|delegated/u.test(error.message),
  );
  await assert.rejects(
    async () =>
      tool.impl(
        tool.parameters.parse({
          condition: PR,
          resumeText: 'x',
          everySeconds: 600,
          expiresInSeconds: 60,
        }),
        context as never,
      ),
    /expiresInSeconds/u,
  );
});
