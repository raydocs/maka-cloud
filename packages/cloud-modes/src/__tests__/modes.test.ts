import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_VENDORS,
  budgetProblem,
  chooseMode,
  DEFAULT_MODES,
  EFFORTS,
  implementerFor,
  looksLikeModeLine,
  MODE_IDS,
  MODES_CONFIG_VERSION,
  type ModesConfig,
  modelsOf,
  modesConfigFrom,
  otherVendor,
  parseModeBrief,
  parseModesConfig,
  reviewerFor,
  splitBudget,
  unnamedModels,
  withModeLine,
  withoutDeep,
} from '../index.js';

function clone(): ModesConfig {
  return structuredClone(DEFAULT_MODES);
}

test('the default config is valid and round-trips through its own parser', () => {
  const parsed = parseModesConfig(JSON.stringify(DEFAULT_MODES));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problems.join('; '));
  assert.deepEqual(parsed.config, DEFAULT_MODES);
  assert.equal(DEFAULT_MODES.version, MODES_CONFIG_VERSION);
});

test('every mode maps every role to a model or the CLI default, and an effort', () => {
  for (const id of MODE_IDS) {
    const mode = DEFAULT_MODES.modes[id];
    assert.ok(EFFORTS.includes(mode.conductor.effort), `${id} conductor effort`);
    assert.ok(EFFORTS.includes(mode.conductor.plannerEffort), `${id} planner effort`);
    assert.ok(EFFORTS.includes(mode.helper.effort), `${id} helper effort`);
    assert.ok(mode.helper.model, `${id} helper model`);
    for (const vendor of AGENT_VENDORS) {
      assert.ok(EFFORTS.includes(implementerFor(DEFAULT_MODES, id, vendor).effort));
      assert.ok(EFFORTS.includes(reviewerFor(DEFAULT_MODES, id, vendor).effort));
    }
  }
});

test('the reviewer is always the other vendor, in every mode, for either implementer', () => {
  for (const id of MODE_IDS) {
    for (const implementer of AGENT_VENDORS) {
      const reviewer = reviewerFor(DEFAULT_MODES, id, implementer);
      assert.notEqual(reviewer.vendor, implementer, `${id}: ${implementer} reviews itself`);
      assert.equal(reviewer.vendor, otherVendor(implementer));
    }
  }
});

test('a reviewer takes its model and effort from the reviewing vendor', () => {
  const config = clone();
  config.modes.deep.reviewer.codex = { model: 'gpt-review-x', effort: 'xhigh' };
  config.modes.deep.reviewer['claude-agent-sdk'] = { model: 'claude-opus-5-5', effort: 'medium' };
  assert.deepEqual(reviewerFor(config, 'deep', 'claude-agent-sdk'), {
    vendor: 'codex',
    model: 'gpt-review-x',
    effort: 'xhigh',
  });
  assert.deepEqual(reviewerFor(config, 'deep', 'codex'), {
    vendor: 'claude-agent-sdk',
    model: 'claude-opus-5-5',
    effort: 'medium',
  });
});

test('no field of the config can name a reviewer vendor', () => {
  const config = clone() as unknown as { modes: { deep: Record<string, unknown> } };
  config.modes.deep.reviewerVendor = 'claude-agent-sdk';
  assert.equal(modesConfigFrom(config).ok, false);
});

test('a config of another version is refused, not read', () => {
  const next = { ...clone(), version: MODES_CONFIG_VERSION + 1 };
  const parsed = modesConfigFrom(next);
  assert.equal(parsed.ok, false);
  assert.equal(modesConfigFrom({ ...clone(), version: undefined }).ok, false);
});

test('unknown keys, missing modes, bad efforts and bad model ids are refused', () => {
  const extra = { ...clone(), extra: true };
  assert.equal(modesConfigFrom(extra).ok, false);

  const missing = clone() as unknown as { modes: Record<string, unknown> };
  delete missing.modes.deep;
  assert.equal(modesConfigFrom(missing).ok, false);

  const effort = clone() as unknown as { modes: { quick: { conductor: { effort: string } } } };
  effort.modes.quick.conductor.effort = 'maximum';
  assert.equal(modesConfigFrom(effort).ok, false);

  for (const model of ['', ' x', 'a b', 'a;rm -rf /', '$(x)', '../x', 'x'.repeat(101), '-flag']) {
    const config = clone();
    config.modes.standard.implementer.codex = { model, effort: 'low' };
    assert.equal(modesConfigFrom(config).ok, false, `model ${JSON.stringify(model)}`);
  }
  assert.equal(parseModesConfig('{not json').ok, false);
  assert.equal(parseModesConfig('null').ok, false);
});

test('budgets must make sense: default above minimum, cap above default, minimums rising', () => {
  const low = clone();
  low.modes.standard.budget.defaultRunUsd = 1;
  assert.equal(modesConfigFrom(low).ok, false);

  const cap = clone();
  cap.modes.standard.budget.maxDelegationUsd = 4;
  assert.equal(modesConfigFrom(cap).ok, false);

  const order = clone();
  order.modes.deep.budget.minRunUsd = order.modes.standard.budget.minRunUsd;
  assert.equal(modesConfigFrom(order).ok, false);

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const config = clone();
    config.modes.quick.budget.minRunUsd = bad;
    assert.equal(modesConfigFrom(config).ok, false, `minRunUsd ${bad}`);
  }
  for (const share of [0, 0.01, 0.51, 1, Number.NaN]) {
    const config = clone();
    config.modes.quick.budget.reviewShare = share;
    assert.equal(modesConfigFrom(config).ok, false, `reviewShare ${share}`);
  }
});

test("the user's pick always stands, whatever the budget", () => {
  assert.deepEqual(chooseMode(DEFAULT_MODES, { requested: 'deep', budgetUsd: 0.1 }), {
    mode: 'deep',
    source: 'user',
  });
  assert.deepEqual(
    chooseMode(DEFAULT_MODES, { requested: 'quick', suggested: 'deep', budgetUsd: 500 }),
    { mode: 'quick', source: 'user' },
  );
});

test("the conductor's suggestion stands unless the budget is too small for it", () => {
  assert.deepEqual(chooseMode(DEFAULT_MODES, { suggested: 'deep', budgetUsd: 25 }), {
    mode: 'deep',
    source: 'conductor',
  });
  assert.equal(chooseMode(DEFAULT_MODES, { suggested: 'deep', budgetUsd: 5 }).mode, 'standard');
  assert.equal(chooseMode(DEFAULT_MODES, { suggested: 'deep', budgetUsd: 1 }).mode, 'quick');
  assert.equal(chooseMode(DEFAULT_MODES, { suggested: 'quick', budgetUsd: 500 }).mode, 'quick');
});

test('with no pick and no suggestion the budget decides, and never goes above standard', () => {
  assert.deepEqual(chooseMode(DEFAULT_MODES, { budgetUsd: 1 }), {
    mode: 'quick',
    source: 'budget',
  });
  assert.equal(chooseMode(DEFAULT_MODES, { budgetUsd: 5 }).mode, 'standard');
  assert.equal(chooseMode(DEFAULT_MODES, { budgetUsd: 500 }).mode, 'standard');
  assert.equal(chooseMode(DEFAULT_MODES, { budgetUsd: 0.01 }).mode, 'quick');
  assert.equal(chooseMode(DEFAULT_MODES, {}).mode, 'standard');
});

test('a budget below the mode minimum is a problem, and at it is not', () => {
  for (const id of MODE_IDS) {
    const { minRunUsd } = DEFAULT_MODES.modes[id].budget;
    assert.equal(budgetProblem(DEFAULT_MODES, id, minRunUsd), undefined);
    assert.match(
      budgetProblem(DEFAULT_MODES, id, minRunUsd - 0.01) ?? '',
      /needs a budget of at least/,
    );
  }
});

test('the budget split never adds up to more than the budget', () => {
  for (const id of MODE_IDS) {
    for (const budget of [0.01, 0.5, 1, 3.33, 5, 12.345678, 100, 9999.99]) {
      const { workUsd, reviewUsd } = splitBudget(DEFAULT_MODES, id, budget);
      assert.ok(workUsd >= 0 && reviewUsd > 0, `${id} ${budget}`);
      assert.ok(workUsd + reviewUsd <= budget + 1e-9, `${id} ${budget}: ${workUsd} + ${reviewUsd}`);
      assert.ok(workUsd < budget, 'the implementer never gets the whole budget');
    }
  }
});

test('the split is in whole micro-dollars rounded down, so the parts never add up to more than the budget', () => {
  const micros = (usd: number) => Math.round(usd * 1e6);
  // 0.9999999 split by rounding each part on its own came to 0.8 + 0.2 = 1.
  const { workUsd, reviewUsd } = splitBudget(DEFAULT_MODES, 'standard', 0.9999999);
  assert.deepEqual([workUsd, reviewUsd], [0.8, 0.199999]);
  assert.ok(micros(workUsd) + micros(reviewUsd) <= Math.floor(0.9999999 * 1e6));
  assert.deepEqual(splitBudget(DEFAULT_MODES, 'standard', 0.3), { workUsd: 0.24, reviewUsd: 0.06 });
  assert.deepEqual(splitBudget(DEFAULT_MODES, 'quick', 0), { workUsd: 0, reviewUsd: 0 });
  assert.deepEqual(splitBudget(DEFAULT_MODES, 'quick', -1), { workUsd: 0, reviewUsd: 0 });
  // Many budgets with awkward decimals, in every mode.
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const id of MODE_IDS) {
    for (let i = 0; i < 2000; i++) {
      const budget = next() * 50 + (i % 7 === 0 ? 0.0000001 : 0);
      const split = splitBudget(DEFAULT_MODES, id, budget);
      assert.ok(
        micros(split.workUsd) + micros(split.reviewUsd) <= Math.floor(budget * 1e6 + 1e-6),
        `${id} ${budget}`,
      );
      assert.ok(
        Math.abs(split.workUsd * 1e6 - micros(split.workUsd)) < 1e-4,
        'whole micro-dollars',
      );
    }
  }
});

test('the models a config names are listed once each, with the vendor that serves them', () => {
  const models = modelsOf(DEFAULT_MODES);
  assert.deepEqual(models.map((m) => `${m.vendor}:${m.model}`).sort(), [
    'anthropic:claude-haiku-5-5',
    'anthropic:claude-opus-5-5',
    'anthropic:claude-sonnet-5-5',
  ]);
  const config = clone();
  config.modes.deep.reviewer.codex = { model: 'gpt-review-x', effort: 'high' };
  assert.ok(modelsOf(config).some((m) => m.vendor === 'openai' && m.model === 'gpt-review-x'));
});

test('roles left on the CLI default are reported, so the host can say they need a price', () => {
  const open = unnamedModels(DEFAULT_MODES);
  assert.ok(open.length > 0);
  assert.ok(open.every((entry) => entry.vendor === 'codex'));
  const config = clone();
  for (const id of MODE_IDS) {
    for (const role of ['implementer', 'reviewer'] as const) {
      config.modes[id][role].codex = { model: 'gpt-x', effort: 'low' };
    }
  }
  assert.deepEqual(unnamedModels(config), []);
});

test('the mode line goes right after the leading directives and is read back from there', () => {
  const plain = withModeLine('Fix the bug.\n\nMore.', 'deep');
  assert.equal(plain, 'maka-mode: deep\nFix the bug.\n\nMore.');
  assert.deepEqual(parseModeBrief(plain), {
    ok: true,
    mode: 'deep',
    rest: 'Fix the bug.\n\nMore.',
  });

  const header = 'maka-inputs: tsk_a report.json\nmaka-artifacts: out/report.md\n';
  const withHeader = withModeLine(`${header}Rerun it.`, 'quick');
  assert.equal(withHeader, `${header}maka-mode: quick\nRerun it.`);
  assert.deepEqual(parseModeBrief(withHeader), {
    ok: true,
    mode: 'quick',
    rest: `${header}Rerun it.`,
  });
});

test('only the line right after the directives is the mode; any other is plain text', () => {
  for (const brief of [
    'Fix it.\nmaka-mode: deep',
    'Fix it.\n\nmaka-mode: deep\n',
    '> maka-mode: deep\nFix it.',
    ' maka-mode: deep\nFix it.',
  ]) {
    const parsed = parseModeBrief(brief);
    assert.deepEqual(parsed, { ok: true, rest: brief }, brief);
  }
});

test('a mode line that names no mode is refused, not defaulted', () => {
  for (const line of [
    'maka-mode:deep',
    'maka-mode: Deep',
    'maka-mode: deep ',
    'maka-mode: turbo',
    'maka-mode:',
  ]) {
    assert.equal(parseModeBrief(`${line}\nFix it.`).ok, false, line);
  }
});

test('a brief that already holds something like a mode line cannot be given one', () => {
  for (const brief of ['maka-mode: deep\nx', 'x\n  maka-mode : deep', 'x\n> * maka-mode: quick']) {
    assert.equal(looksLikeModeLine(brief), true, brief);
    assert.throws(() => withModeLine(brief, 'standard'), /already has a mode line/);
  }
  assert.equal(looksLikeModeLine('use maka-mode: in prose'), false);
});

test('without deep, deep is a copy of standard: its models, effort and budget', () => {
  const off = withoutDeep(DEFAULT_MODES);
  assert.deepEqual(off.modes.deep, DEFAULT_MODES.modes.standard);
  assert.deepEqual(off.modes.quick, DEFAULT_MODES.modes.quick);
  assert.notDeepEqual(DEFAULT_MODES.modes.deep, DEFAULT_MODES.modes.standard);
  // Applied after the config is parsed and never read back, so the parser's rising-minimums rule does not apply.
});
