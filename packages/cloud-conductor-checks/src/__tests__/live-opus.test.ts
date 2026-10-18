import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveModeEnabled, runLive } from '../live.js';

test('live mode stays off unless both ANTHROPIC_API_KEY and MAKA_CLOUD_LIVE=1 are set', () => {
  assert.equal(liveModeEnabled({}), false);
  assert.equal(liveModeEnabled({ ANTHROPIC_API_KEY: 'sk-ant-x' }), false);
  assert.equal(liveModeEnabled({ MAKA_CLOUD_LIVE: '1' }), false);
  assert.equal(liveModeEnabled({ ANTHROPIC_API_KEY: 'sk-ant-x', MAKA_CLOUD_LIVE: 'true' }), false);
  assert.equal(liveModeEnabled({ ANTHROPIC_API_KEY: 'sk-ant-x', MAKA_CLOUD_LIVE: '1' }), true);
});

test('live: 30 turns on claude-opus-5-5 report cache reads per request and any 400', {
  skip: liveModeEnabled()
    ? false
    : 'set ANTHROPIC_API_KEY and MAKA_CLOUD_LIVE=1 to spend money on this',
}, async (t) => {
  const result = await runLive();
  for (const entry of result.usage) {
    t.diagnostic(
      `request ${entry.request} turn ${entry.turn ?? '?'} status ${entry.status} input ${entry.inputTokens ?? '-'} cache_read ${entry.cacheReadInputTokens ?? '-'} cache_creation ${entry.cacheCreationInputTokens ?? '-'} output ${entry.outputTokens ?? '-'}${entry.error ? ` error ${entry.error}` : ''}`,
    );
  }
  const rejected = result.usage.filter((entry) => entry.status >= 400);
  assert.deepEqual(rejected, []);
  assert.deepEqual(result.report.contentPrefix.breaks, []);
  assert.deepEqual(result.report.thinking.failures, []);
});
