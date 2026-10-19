import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import type { ModelPrices } from './config.js';

/** Dollars for one model call, from its token counts and the price table. */
export function callCostUsd(attempt: ModelCallAttempt, prices: ModelPrices): number {
  const input = attempt.inputTokens ?? 0;
  const hit = attempt.cacheReadInputTokens ?? 0;
  const write = attempt.cacheWriteInputTokens ?? 0;
  const miss = attempt.cacheMissInputTokens ?? Math.max(0, input - hit - write);
  const output = attempt.outputTokens ?? 0;
  return (
    (miss * prices.input +
      hit * prices.cacheRead +
      write * prices.cacheWrite +
      output * prices.output) /
    1_000_000
  );
}
