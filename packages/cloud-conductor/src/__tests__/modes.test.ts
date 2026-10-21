import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_MODES, type ModeId } from '@maka-cloud/modes';
import { calls, refusal, text, tool, toolResults } from './fake-model.js';
import { type Harness, makeHarness } from './harness.js';

const startCoding = calls(tool('start_playbook', { playbook: 'coding', goal: 'g' }));
const plan = text('1. Change the code.');

function delegate(extra: Record<string, unknown> = {}, budgetUsd = 1) {
  return tool('delegate_task', {
    runner: 'claude-agent-sdk',
    brief: 'Fix lib/add.sh.',
    budgetUsd,
    mode: 'wait',
    timeoutMs: 10_000,
    ...extra,
  });
}

async function briefOf(h: Harness, index = 0): Promise<string> {
  const run = h.claude.runs[index];
  assert.ok(run, 'the runner got a task');
  return readFile(run.spec.briefPath, 'utf8');
}

let conversations = 0;

/** One run in a conversation of its own (a delegation taints its conversation): plan, one delegation, done. */
async function runWith(
  h: Harness,
  message: { mode?: string },
  delegation: ReturnType<typeof delegate>,
): Promise<{ runId: string; result: ReturnType<typeof toolResults>[number] | undefined }> {
  const conversationId = `cnv_${++conversations}`;
  h.model.script('planner', plan);
  let result: ReturnType<typeof toolResults>[number] | undefined;
  h.model.script('conductor', startCoding, calls(delegation), (request) => {
    result = toolResults(request)[0];
    return text('Done.');
  });
  await h.conductor.onUserMessage(
    { conversationId, messageId: `msg_${conversationId}`, text: 'Fix it.', ...message },
    h.access(conversationId),
  );
  await h.conductor.idle();
  const run = h.conductor.state.runsOfConversation(conversationId).at(-1);
  assert.ok(run);
  return { runId: run.runId, result };
}

const structured = (
  result: { text: string; isError?: boolean; json?: Record<string, unknown> } | undefined,
): Record<string, unknown> => {
  assert.ok(result, 'the delegation got a result');
  assert.equal(result.isError, false, result.text);
  return result.json ?? {};
};

test('the user’s pick is the run’s mode, starts it with that mode’s budget, and the model cannot choose another', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  const { runId, result } = await runWith(h, { mode: 'deep' }, delegate({ workMode: 'quick' }, 4));
  const run = h.conductor.state.run(runId);
  assert.equal(run?.mode, 'deep');
  assert.equal(run?.budgetUsd, DEFAULT_MODES.modes.deep.budget.defaultRunUsd);
  assert.match(await briefOf(h), /^maka-mode: deep\nFix lib\/add\.sh\.$/);
  const body = structured(result);
  assert.equal(body.workMode, 'deep');
  assert.equal(body.workModeChosenBy, 'user');
});

test('without a pick the conductor’s suggestion stands when the run’s budget affords it, and never goes above standard on its own', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  // The default run budget is $5: quick is affordable, deep is not (it wants $10), so standard.
  const quick = await runWith(h, {}, delegate({ workMode: 'quick' }));
  assert.equal(structured(quick.result).workMode, 'quick');
  assert.equal(structured(quick.result).workModeChosenBy, 'conductor');
  assert.match(await briefOf(h, 0), /^maka-mode: quick\n/);
  assert.equal(h.conductor.state.run(quick.runId)?.mode, null);

  const deep = await runWith(h, {}, delegate({ workMode: 'deep' }));
  assert.equal(structured(deep.result).workMode, 'standard', 'deep is not affordable at $5');
  const none = await runWith(h, {}, delegate());
  assert.equal(structured(none.result).workMode, 'standard');
  assert.equal(structured(none.result).workModeChosenBy, 'budget');
});

test('a brief the model wrote with a mode line in it is refused before anything is reserved or sent', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  for (const brief of [
    'maka-mode: deep\nFix it.',
    'Fix it.\n\n> maka-mode: quick',
    'Fix it.\n  maka-mode: deep',
  ]) {
    const { runId, result } = await runWith(h, {}, delegate({ brief }));
    assert.equal(result?.isError, true, brief);
    assert.match(refusal(result), /^mode_line_in_brief:/);
    assert.equal(h.conductor.state.budget(runId).reservedUsd, 0);
  }
  assert.equal(h.claude.runs.length, 0, 'nothing was delegated');
});

test('a mode caps what one delegation may cost, whoever chose the mode', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  const cap = DEFAULT_MODES.modes.quick.budget.maxDelegationUsd;
  const { runId, result } = await runWith(h, { mode: 'quick' }, delegate({}, cap + 1));
  assert.equal(result?.isError, true);
  assert.match(
    refusal(result),
    /^delegation_over_mode_cap: A quick task may be given at most \$10\.00/,
  );
  assert.equal(h.conductor.state.budget(runId).reservedUsd, 0);
  assert.equal(h.claude.runs.length, 0);
});

test('a mode that is not one starts no run', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  await h.conductor.onUserMessage(
    { conversationId: 'cnv_1', messageId: 'msg_bad', text: 'Fix it.', mode: 'turbo' },
    h.access('cnv_1'),
  );
  await h.conductor.idle();
  assert.deepEqual(h.conductor.state.runsOfConversation('cnv_1'), []);
  assert.match(h.outbox.notices.at(-1)?.text ?? '', /its mode was not valid/);
});

test('a duty’s run keeps its own budget, and a mode on its message changes nothing', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  h.model.script('conductor', text('Nothing to do.'));
  await h.conductor.onUserMessage(
    {
      conversationId: 'cnv_1',
      messageId: 'msg_duty',
      text: 'Check the repo.',
      mode: 'deep',
      run: { dutyId: 'duty_1', authority: 'read-only', budgetUsd: 1.5 },
    },
    h.access('cnv_1'),
  );
  await h.conductor.idle();
  const run = h.conductor.state.runsOfConversation('cnv_1').at(-1);
  assert.equal(run?.budgetUsd, 1.5);
  assert.equal(run?.mode, null);
});

test('without modes nothing is added to a brief and the result names no mode', async (t) => {
  const h = await makeHarness(t);
  const { runId, result } = await runWith(h, { mode: 'deep' }, delegate({ workMode: 'deep' }));
  assert.equal(await briefOf(h), 'Fix lib/add.sh.');
  assert.ok(!('workMode' in structured(result)));
  const run = h.conductor.state.run(runId);
  assert.equal(run?.mode, null, 'a pick with no modes configured is not stored');
});

const MODE_EFFORT: [ModeId, string][] = [
  ['quick', 'low'],
  ['standard', 'medium'],
  ['deep', 'high'],
];

for (const [mode, effort] of MODE_EFFORT) {
  test(`${mode}: the conductor thinks at ${effort} effort and the planner at its own`, async (t) => {
    const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
    await runWith(h, { mode }, delegate({}, 1));
    const planner = DEFAULT_MODES.modes[mode].conductor.plannerEffort;
    const effortOnTheWire = (lane: 'conductor' | 'planner') => {
      const request = h.model.requests.find((candidate) => candidate.lane === lane);
      assert.ok(request);
      return (JSON.parse(request.raw) as { output_config?: { effort?: string } }).output_config
        ?.effort;
    };
    assert.equal(effortOnTheWire('conductor'), effort);
    assert.equal(effortOnTheWire('planner'), planner);
  });
}
