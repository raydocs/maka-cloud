import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_MODES, type ModeId } from '@maka-cloud/modes';
import { DEFAULT_PLAYBOOKS, type Playbook, type VerifyContext } from '../playbooks.js';
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
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  const { runId, result } = await runWith(h, { mode: 'deep' }, delegate({ workMode: 'quick' }, 10));
  const run = h.conductor.state.run(runId);
  assert.equal(run?.mode, 'deep');
  assert.equal(run?.budgetUsd, DEFAULT_MODES.modes.deep.budget.defaultRunUsd);
  assert.match(await briefOf(h), /^maka-mode: deep\nFix lib\/add\.sh\.$/);
  const body = structured(result);
  assert.equal(body.workMode, 'deep');
  assert.equal(body.workModeChosenBy, 'user');
});

test('without a pick the conductor’s suggestion stands when the run’s budget affords it, and never goes above standard on its own', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  // The default run budget is $5: quick is affordable, deep is not (it wants $10), so standard.
  const quick = await runWith(h, {}, delegate({ workMode: 'quick' }, 3));
  assert.equal(structured(quick.result).workMode, 'quick');
  assert.equal(structured(quick.result).workModeChosenBy, 'conductor');
  assert.match(await briefOf(h, 0), /^maka-mode: quick\n/);
  assert.equal(h.conductor.state.run(quick.runId)?.mode, null);

  const deep = await runWith(h, {}, delegate({ workMode: 'deep' }, 4));
  assert.equal(structured(deep.result).workMode, 'standard', 'deep is not affordable at $4');
  const none = await runWith(h, {}, delegate({}, 4));
  assert.equal(structured(none.result).workMode, 'standard');
  assert.equal(structured(none.result).workModeChosenBy, 'budget');
});

test('a brief the model wrote with a mode line in it is refused before anything is reserved or sent', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
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

test('a delegation is judged by what it is given, not by the run: $0.20 never runs deep', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  // The user's pick stands, but a deep task needs $10: nothing is reserved or sent below that.
  const picked = await runWith(h, { mode: 'deep' }, delegate({}, 0.2));
  assert.equal(picked.result?.isError, true);
  assert.match(
    refusal(picked.result),
    /^delegation_under_mode_minimum: a deep run needs a budget of at least \$10\.00, this one has \$0\.20\./,
  );
  assert.equal(h.conductor.state.budget(picked.runId).reservedUsd, 0);
  assert.equal(h.claude.runs.length, 0);
  // Without a pick, a suggestion of deep with $0.20 is clamped down to quick, which needs $0.50.
  const small = await runWith(h, {}, delegate({ workMode: 'deep' }, 0.2));
  assert.equal(small.result?.isError, true);
  assert.match(refusal(small.result), /^delegation_under_mode_minimum: a quick run needs/);
  assert.equal(h.claude.runs.length, 0);
  // Given enough, the pick runs.
  const enough = await runWith(h, { mode: 'deep' }, delegate({}, 10));
  assert.equal(structured(enough.result).workMode, 'deep');
});

test('a mode caps what one delegation may cost, whoever chose the mode', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
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
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  await h.conductor.onUserMessage(
    { conversationId: 'cnv_1', messageId: 'msg_bad', text: 'Fix it.', mode: 'turbo' },
    h.access('cnv_1'),
  );
  await h.conductor.idle();
  assert.deepEqual(h.conductor.state.runsOfConversation('cnv_1'), []);
  assert.match(h.outbox.notices.at(-1)?.text ?? '', /its mode was not valid/);
});

test('a duty’s run keeps its own budget, and a mode on its message changes nothing', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
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

test('a run the system starts in a mode (a card) takes that mode and keeps its own budget; the user’s pick on the message still changes nothing', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  h.model.script('conductor', text('Nothing to do.'));
  await h.conductor.onUserMessage(
    {
      conversationId: 'cnv_1',
      messageId: 'msg_card',
      text: 'Rebase PR #12.',
      mode: 'deep',
      run: { dutyId: 'card:card_1', authority: 'open-pr', budgetUsd: 2.5, mode: 'quick' },
    },
    h.access('cnv_1'),
  );
  await h.conductor.idle();
  const run = h.conductor.state.runsOfConversation('cnv_1').at(-1);
  assert.equal(run?.budgetUsd, 2.5);
  assert.equal(run?.mode, 'quick');
  assert.equal(run?.authority, 'open-pr');
});

test('run limits that name a mode that is not one start no run', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  await h.conductor.onUserMessage(
    {
      conversationId: 'cnv_1',
      messageId: 'msg_bad_card',
      text: 'Rebase PR #12.',
      run: { dutyId: 'card:card_1', authority: 'open-pr', budgetUsd: 2.5, mode: 'turbo' },
    },
    h.access('cnv_1'),
  );
  await h.conductor.idle();
  assert.deepEqual(h.conductor.state.runsOfConversation('cnv_1'), []);
  assert.match(h.outbox.notices.at(-1)?.text ?? '', /limits were not valid/);
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
    const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
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

// A reviewer of a draft must be the other runner, and so must the runner that uses its judgments.
// The draft is made through the conversation's own session, so the conductor can read its runner.
async function reviewRun(
  h: Harness,
  conversationId: string,
  review: (draft: string) => ReturnType<typeof delegate>,
  drafter = 'claude-agent-sdk',
): Promise<ReturnType<typeof toolResults>[number] | undefined> {
  h.model.script('planner', plan);
  let result: ReturnType<typeof toolResults>[number] | undefined;
  h.model.script(
    'conductor',
    startCoding,
    async () => {
      const session = h.orchestrator.authenticate(h.access(conversationId).rotateToken());
      assert.ok(session);
      const draft = await h.orchestrator.delegate(session, { runner: drafter, brief: 'draft' });
      return calls(review(draft.taskId));
    },
    (request) => {
      result = toolResults(request)[0];
      return text('Done.');
    },
  );
  await h.conductor.onUserMessage(
    { conversationId, messageId: `msg_${conversationId}`, text: 'Review it.' },
    h.access(conversationId),
  );
  await h.conductor.idle();
  return result;
}

const reviewBrief = (draft: string, artifacts = 'judgments.json') =>
  `maka-inputs: ${draft} report.json sources\nmaka-artifacts: ${artifacts}\nJudge each claim.`;

test('a reviewer on the runner that drafted is refused before anything is reserved, and one on the other runner starts', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  const same = await reviewRun(h, 'cnv_same', (draft) =>
    delegate({ brief: reviewBrief(draft), runner: 'claude-agent-sdk' }),
  );
  assert.equal(same?.isError, true);
  assert.match(refusal(same), /^reviewer_same_runner:/);
  const sameRun = h.conductor.state.runsOfConversation('cnv_same').at(-1);
  assert.equal(h.conductor.state.budget(sameRun?.runId ?? '').reservedUsd, 0);
  assert.equal(h.codex.runs.length, 0);

  const other = await reviewRun(h, 'cnv_other', (draft) =>
    delegate({ brief: reviewBrief(draft), runner: 'codex' }, 4),
  );
  assert.equal(other?.isError, false, other?.text ?? '');
  assert.equal(h.codex.runs.length, 1);
  assert.match(
    await readFile(h.codex.runs[0]?.spec.briefPath ?? '', 'utf8'),
    /\nmaka-mode: standard\nJudge/,
  );
});

test('the runner that uses judgments is refused when it wrote them', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  const rerun = (judged: string) =>
    `maka-inputs: ${judged} judgments.json\nmaka-artifacts: out/report.json\nRerun.`;
  const own = await reviewRun(h, 'cnv_own', (judged) =>
    delegate({ brief: rerun(judged), runner: 'claude-agent-sdk' }),
  );
  assert.match(refusal(own), /^reviewer_same_runner:/);
  const theirs = await reviewRun(h, 'cnv_theirs', (judged) =>
    delegate({ brief: rerun(judged), runner: 'codex' }),
  );
  assert.equal(theirs?.isError, false, theirs?.text ?? '');
});

test('a draft whose runner cannot be read refuses the review instead of letting it through', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  const result = await reviewRun(h, 'cnv_unknown', () =>
    delegate({ brief: reviewBrief('tsk_does_not_exist'), runner: 'codex' }),
  );
  assert.match(refusal(result), /^reviewer_unverifiable:/);
  assert.equal(h.codex.runs.length, 0);
});

test('a brief that asks for no judgments is not a review', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  const result = await reviewRun(h, 'cnv_plain', (draft) =>
    delegate({
      brief: `maka-inputs: ${draft} report.json\nmaka-artifacts: out/report.json\nContinue.`,
      runner: 'claude-agent-sdk',
    }),
  );
  assert.equal(result?.isError, false, result?.text ?? '');
});

test('the mode a task was sent in is kept with its delegation', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES, deepMode: true } });
  const { runId } = await runWith(h, { mode: 'deep' }, delegate({}, 10));
  const [row] = h.conductor.state
    .unsettledDelegations({ runId })
    .concat(h.conductor.state.delegationOfTask(h.claude.runs[0]?.spec.taskId ?? '') ?? []);
  assert.equal(row?.mode, 'deep');
});

test('a playbook’s check is told the mode the task was sent in', async (t) => {
  const coding = DEFAULT_PLAYBOOKS.find((playbook) => playbook.id === 'coding');
  assert.ok(coding);
  const seen: Array<VerifyContext | undefined> = [];
  const watching: Playbook = {
    ...coding,
    verify: (manifest, context) => {
      seen.push(context);
      return coding.verify(manifest);
    },
  };
  const moded = await makeHarness(t, {
    conductor: { modes: DEFAULT_MODES, deepMode: true, playbooks: [watching] },
  });
  await runWith(moded, { mode: 'deep' }, delegate({}, 10));
  assert.deepEqual(seen, [{ mode: 'deep', otherRunnerInput: false }]);
  seen.length = 0;
  const plain = await makeHarness(t, { conductor: { playbooks: [watching] } });
  await runWith(plain, {}, delegate());
  assert.deepEqual(seen, [{ otherRunnerInput: false }]);
});

// A deep research run: who reviewed is read from which runner ran the tasks a brief builds on,
// never from what the files are called.

const researchPlaybooks = (): Playbook[] => {
  const coding = DEFAULT_PLAYBOOKS.find((playbook) => playbook.id === 'coding');
  assert.ok(coding);
  return [coding, { ...coding, id: 'research' }];
};

async function deepResearch(
  h: Harness,
  conversationId: string,
  next: (draft: string) => ReturnType<typeof delegate>,
): Promise<ReturnType<typeof toolResults>[number] | undefined> {
  h.model.script('planner', plan);
  let result: ReturnType<typeof toolResults>[number] | undefined;
  h.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'research', goal: 'g' })),
    async () => {
      const session = h.orchestrator.authenticate(h.access(conversationId).rotateToken());
      assert.ok(session);
      const draft = await h.orchestrator.delegate(session, {
        runner: 'claude-agent-sdk',
        brief: 'draft',
      });
      return calls(next(draft.taskId));
    },
    (request) => {
      result = toolResults(request)[0];
      return text('Done.');
    },
  );
  await h.conductor.onUserMessage(
    { conversationId, messageId: `msg_${conversationId}`, text: 'Research it.', mode: 'deep' },
    h.access(conversationId),
  );
  await h.conductor.idle();
  return result;
}

test('in a deep research run a review is refused on the drafter’s runner whatever its files are called', async (t) => {
  const h = await makeHarness(t, {
    conductor: { modes: DEFAULT_MODES, deepMode: true, playbooks: researchPlaybooks() },
  });
  const brief = (draft: string) =>
    `maka-inputs: ${draft} report.json sources\nmaka-artifacts: out/Judgments.JSON\nJudge each claim.`;
  const same = await deepResearch(h, 'cnv_deep_same', (draft) =>
    delegate({ brief: brief(draft), runner: 'claude-agent-sdk', workMode: 'deep' }, 10),
  );
  assert.match(refusal(same), /^reviewer_same_runner:/);
  // A brief that hides the judgments behind another name is no way round it: the runner of the
  // task it builds on is what counts.
  const renamed = await deepResearch(h, 'cnv_deep_renamed', (draft) =>
    delegate(
      {
        brief: `maka-inputs: ${draft} report.json sources\nmaka-artifacts: out/notes.json\nJudge each claim.`,
        runner: 'claude-agent-sdk',
        workMode: 'deep',
      },
      10,
    ),
  );
  assert.match(refusal(renamed), /^reviewer_same_runner:/);
  assert.equal(h.claude.runs.length, 2, 'only the two drafts ran: no review was started on claude');

  const other = await deepResearch(h, 'cnv_deep_other', (draft) =>
    delegate({ brief: brief(draft), runner: 'codex', workMode: 'deep' }, 10),
  );
  assert.equal(other?.isError, false, other?.text ?? '');
  const row = h.conductor.state.delegationOfTask(h.codex.runs[0]?.spec.taskId ?? '');
  assert.equal(row?.otherRunnerInput, true, 'the delegation took files from the other runner');
});

test('a deep research task that reuses a draft on its own runner is only allowed with a file from the other runner', async (t) => {
  const h = await makeHarness(t, {
    conductor: { modes: DEFAULT_MODES, deepMode: true, playbooks: researchPlaybooks() },
  });
  const seen: Array<string | undefined> = [];
  const result = await deepResearch(h, 'cnv_deep_rerun', (draft) =>
    delegate(
      {
        brief: `maka-inputs: ${draft} report.json sources\nmaka-artifacts: out/report.json\nRerun.`,
        runner: 'claude-agent-sdk',
        workMode: 'deep',
      },
      10,
    ),
  );
  seen.push(refusal(result));
  assert.match(seen[0] ?? '', /^reviewer_same_runner:/);
  // The same brief outside a deep task is an ordinary continuation.
  const plain = await reviewRun(h, 'cnv_not_deep', (draft) =>
    delegate({
      brief: `maka-inputs: ${draft} report.json\nmaka-artifacts: out/report.json\nContinue.`,
      runner: 'claude-agent-sdk',
    }),
  );
  assert.equal(plain?.isError, false, plain?.text ?? '');
});

test('deep mode is off by default: a suggestion of it runs as standard, and the conductor is not told about it', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  const { result } = await runWith(h, {}, delegate({ workMode: 'deep' }, 3));
  assert.equal(structured(result).workMode, 'standard');
  assert.match(await briefOf(h), /^maka-mode: standard\n/);
  const prompt = JSON.stringify(
    h.model.requests.find((request) => request.lane === 'conductor')?.body.system ?? '',
  );
  assert.match(prompt, /quick \(small, well-understood work\) or standard\./);
  assert.doesNotMatch(prompt, /\bdeep\b/);
});

test('deep mode off: the user’s pick of it runs the request as standard, with a notice and the standard budget', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  const { runId, result } = await runWith(h, { mode: 'deep' }, delegate({}, 3));
  assert.equal(h.conductor.state.run(runId)?.mode, 'standard');
  assert.equal(
    h.conductor.state.run(runId)?.budgetUsd,
    DEFAULT_MODES.modes.standard.budget.defaultRunUsd,
  );
  assert.equal(structured(result).workMode, 'standard');
  assert.match(await briefOf(h), /^maka-mode: standard\n/);
  assert.ok(
    h.outbox.notices.some((notice) => /Deep mode is not available yet/.test(notice.text)),
    'the user was told',
  );
});

test('deep mode off: a duplicate message leaves one notice, not two', async (t) => {
  const h = await makeHarness(t, { conductor: { modes: DEFAULT_MODES } });
  h.model.script('conductor', text('Nothing to do.'));
  const message = { conversationId: 'cnv_1', messageId: 'msg_dup', text: 'Fix it.', mode: 'deep' };
  await h.conductor.onUserMessage(message, h.access('cnv_1'));
  await h.conductor.onUserMessage(message, h.access('cnv_1'));
  await h.conductor.idle();
  const told = h.outbox.notices.filter((notice) =>
    /Deep mode is not available yet/.test(notice.text),
  );
  assert.equal(told.length, 1);
});
