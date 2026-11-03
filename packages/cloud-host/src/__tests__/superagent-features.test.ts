import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeConfig, readStackConfig } from '../config.js';
import {
  HttpVersionProbe,
  readSuperagentFeatureConfig,
  releaseVerifySkipsWithoutEndpoint,
  startSuperagentFeatureTimers,
  SUPERAGENT_FEATURES_OFF,
  superagentOptionsFromFeatures,
  sweepTargets,
} from '../superagent-features.js';

const ENV = {
  MAKA_CLOUD_DATA_DIR: '/srv/maka',
  ANTHROPIC_API_KEY: 'sk-secret-anthropic',
  INSTABOX_API_KEY: 'ibx-secret-instabox',
  MAKA_CLOUD_SANDBOXES: '{"inv_000000000001":"mch_1"}',
};

test('super-agent feature flags default off and the constructors are not given env', () => {
  const read = readSuperagentFeatureConfig({});
  assert.deepEqual(read.problems, []);
  assert.equal(read.features.byom, false);
  assert.equal(read.features.peerReview, false);
  assert.equal(read.features.releaseVerify, false);
  assert.equal(read.features.sweep, false);
  assert.equal(read.features.learning, false);
  assert.equal(read.features.rulesPath, undefined);
  const options = superagentOptionsFromFeatures(read.features, {});
  assert.equal(options.byom, undefined);
  assert.equal(options.peerReview, undefined);
  assert.equal(options.releaseVerify, undefined);
  assert.equal(options.sweep, undefined);
  assert.equal(options.learning, undefined);
  assert.equal(options.rulesPath, undefined);
  const described = readStackConfig(ENV);
  assert.equal(described.superagentFeatures.byom, false);
  assert.match(describeConfig(described).join('\n'), /byom off/);
});

test('host wires BYOM, peer review, rules, and a weekly sweep only when the flags are on', () => {
  const env = {
    MAKA_CLOUD_BYOM: '1',
    MAKA_CLOUD_BYOM_REPOS: 'acme/ios',
    MAKA_CLOUD_PEER_REVIEW: '1',
    MAKA_CLOUD_PEER_REVIEW_URL: 'https://review.example.test/complete',
    MAKA_CLOUD_PEER_REVIEW_MODEL: 'reviewer-b',
    MAKA_CLOUD_LEARNING: '1',
    MAKA_CLOUD_SWEEP: '1',
    MAKA_CLOUD_SWEEP_TENANT: 'inv_00000000000a',
    MAKA_CLOUD_SWEEP_REPO: 'acme/app',
    MAKA_CLOUD_SUPERAGENT_RULES: '/srv/maka/superagent.rules.json',
  };
  const read = readSuperagentFeatureConfig(env);
  assert.deepEqual(read.problems, []);
  const options = superagentOptionsFromFeatures(read.features, env, fakeFetch());
  assert.equal(options.byom?.settings.enabled, true);
  assert.deepEqual(options.byom?.settings.optedRepos, ['acme/ios']);
  assert.equal(options.peerReview?.enabled, true);
  assert.equal(options.peerReview?.model, 'reviewer-b');
  assert.ok(options.peerReview?.client);
  assert.equal(options.learning?.enabled, true);
  assert.equal(options.sweep?.enabled, true);
  assert.equal(options.sweep?.repo, 'acme/app');
  assert.equal(options.rulesPath, '/srv/maka/superagent.rules.json');
  assert.deepEqual(sweepTargets(read.features, ['inv_other']), ['inv_00000000000a']);
});

test('post-deploy verify skips the /version probe when no endpoint is configured', async () => {
  const skipped = readSuperagentFeatureConfig({ MAKA_CLOUD_RELEASE_VERIFY: '1' });
  assert.deepEqual(skipped.problems, []);
  assert.equal(skipped.features.releaseVerifyUrl, undefined);
  const skippedOptions = superagentOptionsFromFeatures(skipped.features, {
    MAKA_CLOUD_RELEASE_VERIFY: '1',
  });
  assert.equal(releaseVerifySkipsWithoutEndpoint(skippedOptions.releaseVerify), true);
  assert.equal(skippedOptions.releaseVerify?.probe, undefined);

  const calls: string[] = [];
  const env = {
    MAKA_CLOUD_RELEASE_VERIFY: '1',
    MAKA_CLOUD_RELEASE_VERIFY_URL: 'https://app.example.test/version',
  };
  const armed = superagentOptionsFromFeatures(
    readSuperagentFeatureConfig(env).features,
    env,
    async (input) => {
      calls.push(String(input));
      return new Response('{"sha":"abc1234"}', { status: 200 });
    },
  );
  assert.equal(armed.releaseVerify?.enabled, true);
  assert.equal(armed.releaseVerify?.versionUrl, 'https://app.example.test/version');
  const read = await armed.releaseVerify?.probe?.read('https://app.example.test/version');
  assert.equal(read?.status, 200);
  assert.match(read?.body ?? '', /abc1234/);
  assert.deepEqual(calls, ['https://app.example.test/version']);
  assert.ok(armed.releaseVerify?.probe instanceof HttpVersionProbe);
});

test('a rules path loads immediately and the weekly sweep timer stays off until asked', () => {
  let reloads = 0;
  let sweeps = 0;
  const intervals: number[] = [];
  const stop = startSuperagentFeatureTimers({
    features: {
      ...SUPERAGENT_FEATURES_OFF,
      rulesPath: '/srv/maka/superagent.rules.json',
      rulesEveryMs: 15_000,
      sweep: true,
      sweepEveryMs: WEEK,
    },
    every(fn, ms) {
      intervals.push(ms);
      fn();
      return () => undefined;
    },
    reloadRules() {
      reloads += 1;
    },
    sweep() {
      sweeps += 1;
    },
  });
  assert.equal(reloads, 2);
  assert.equal(sweeps, 1);
  assert.deepEqual(intervals, [15_000, WEEK]);
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
    sweep() {
      called = true;
    },
  });
  assert.equal(called, false);
});

const WEEK = 7 * 24 * 60 * 60 * 1000;

function fakeFetch(): typeof fetch {
  return (async () => new Response('{}', { status: 200 })) as typeof fetch;
}
