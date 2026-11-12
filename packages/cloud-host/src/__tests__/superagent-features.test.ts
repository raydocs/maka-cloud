import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeConfig, readStackConfig } from '../config.js';
import {
  readSuperagentFeatureConfig,
  startSuperagentFeatureTimers,
  SUPERAGENT_FEATURES_OFF,
  superagentOptionsFromFeatures,
} from '../superagent-features.js';

const ENV = {
  MAKA_CLOUD_DATA_DIR: '/srv/maka',
  ANTHROPIC_API_KEY: 'sk-secret-anthropic',
  INSTABOX_API_KEY: 'ibx-secret-instabox',
  MAKA_CLOUD_SANDBOXES: '{"inv_000000000001":"mch_1"}',
};

test('without a rules file the super-agent gets no rules path', () => {
  const read = readSuperagentFeatureConfig({});
  assert.deepEqual(read.problems, []);
  assert.equal(read.features.rulesPath, undefined);
  assert.equal(superagentOptionsFromFeatures(read.features).rulesPath, undefined);
  const described = readStackConfig(ENV);
  assert.equal(described.superagentFeatures.rulesPath, undefined);
  assert.match(describeConfig(described).join('\n'), /super-agent rules:\s+off/);
});

test('host wires the rules file when its path is set, and refuses a reload interval that is not a number', () => {
  const read = readSuperagentFeatureConfig({
    MAKA_CLOUD_SUPERAGENT_RULES: '/srv/maka/superagent.rules.json',
    MAKA_CLOUD_RULES_EVERY_MS: '15000',
  });
  assert.deepEqual(read.problems, []);
  assert.equal(read.features.rulesEveryMs, 15_000);
  assert.equal(
    superagentOptionsFromFeatures(read.features).rulesPath,
    '/srv/maka/superagent.rules.json',
  );
  assert.deepEqual(readSuperagentFeatureConfig({ MAKA_CLOUD_RULES_EVERY_MS: 'soon' }).problems, [
    'MAKA_CLOUD_RULES_EVERY_MS must be a whole number of milliseconds above 0',
  ]);
});

test('a rules path loads immediately and reloads on its timer; without one no timer starts', () => {
  let reloads = 0;
  const intervals: number[] = [];
  const stop = startSuperagentFeatureTimers({
    features: {
      ...SUPERAGENT_FEATURES_OFF,
      rulesPath: '/srv/maka/superagent.rules.json',
      rulesEveryMs: 15_000,
    },
    every(fn, ms) {
      intervals.push(ms);
      fn();
      return () => undefined;
    },
    reloadRules() {
      reloads += 1;
    },
  });
  assert.equal(reloads, 2);
  assert.deepEqual(intervals, [15_000]);
  stop();

  let called = false;
  startSuperagentFeatureTimers({
    features: SUPERAGENT_FEATURES_OFF,
    every() {
      called = true;
      return () => undefined;
    },
    reloadRules() {
      called = true;
    },
  });
  assert.equal(called, false);
});
