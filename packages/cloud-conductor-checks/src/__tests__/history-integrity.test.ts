import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { RunResult } from '../runs.js';
import { executeRun, RUNS, type RunId } from '../runs.js';

/**
 * Drives the 30-turn conversation through Maka's runtime once per setting and
 * checks what reached the Anthropic endpoint. The assertions state what each
 * setting does today (see docs/fork/findings/t3-history-integrity.md). A
 * runtime change that alters any of them should fail here and be re-read,
 * not be absorbed by loosening the assertion.
 */

const results = new Map<RunId, RunResult>();
const run = (id: RunId): RunResult => {
  const result = results.get(id);
  assert.ok(result, `run ${id} did not execute`);
  return result;
};

/** Strict-prefix causes that are by design on every request (see the findings doc). */
const BY_DESIGN_CAUSES = new Set(['request_only_context_and_cache_control']);

function assertAllTurnsCompleted(result: RunResult): void {
  for (const turn of result.turns) {
    assert.equal(
      turn.outcome.stopReason,
      'end_turn',
      `turn ${turn.turn}: ${turn.outcome.errors.join('; ')}`,
    );
    assert.equal(turn.unconsumedReplies, 0, `turn ${turn.turn} ended before its script did`);
  }
}

function assertAppendOnly(result: RunResult): void {
  const { report } = result;
  assert.ok(report.pairs >= 60, `only ${report.pairs} request pairs`);
  assert.deepEqual(report.contentPrefix.breaks, []);
  assert.deepEqual(report.thinking.failures, []);
  assert.deepEqual(report.breakpoints.failures, []);
  assert.deepEqual(report.systemChanges, []);
  assert.deepEqual(report.toolsChanges, []);
  // Check 1 as the brief states it: byte-identical. It fails on every pair,
  // and only for the two by-design reasons.
  assert.equal(report.strictPrefix.breaks.length, report.pairs);
  for (const divergence of report.strictPrefix.breaks) {
    assert.ok(BY_DESIGN_CAUSES.has(divergence.cause), JSON.stringify(divergence));
  }
}

/** The first request that carries a history-compact checkpoint block. */
function firstCheckpointRequest(result: RunResult): number {
  const found = result.requests.find(
    (request) =>
      request.kind === 'main' &&
      JSON.stringify(request.body.messages[0]).includes('maka_history_compact_checkpoint'),
  );
  assert.ok(found, 'no request replayed a compaction checkpoint');
  return found.index;
}

function assertCompactionBreak(result: RunResult, checkpointRequest: number): void {
  const { report } = result;
  const atCheckpoint = report.contentPrefix.breaks.filter((d) => d.to === checkpointRequest);
  assert.equal(atCheckpoint.length, 1);
  assert.equal(atCheckpoint[0]!.messageIndex, 0);
  assert.equal(atCheckpoint[0]!.cause, 'rewrite');
  assert.ok(
    report.breakpoints.failures.some(
      (failure) => failure.request === checkpointRequest && failure.kind === 'moved_backwards',
    ),
  );
  // Thinking emitted before the checkpoint is folded into the summary.
  assert.ok(
    report.thinking.failures.some(
      (f) => f.emittedAt < checkpointRequest && f.request === checkpointRequest,
    ),
  );
}

/**
 * After a checkpoint exists, redacted_thinking from later turns is dropped:
 * it is a thinking event with empty text, and the checkpoint replay keeps
 * only events `isHistoryCompactContentEvent` counts (history-compaction.ts:520).
 * Signed thinking emitted after the checkpoint survives.
 */
function assertRedactedThinkingDroppedAfterCheckpoint(
  result: RunResult,
  checkpointRequest: number,
): void {
  const failuresAfter = result.report.thinking.failures.filter(
    (f) => f.emittedAt >= checkpointRequest,
  );
  assert.ok(failuresAfter.length > 0);
  for (const failure of failuresAfter) {
    assert.equal(failure.kind, 'missing');
    assert.match(failure.detail, /^redacted_thinking/);
  }
}

describe('history integrity through Maka runtime (fake Anthropic endpoint)', () => {
  before(async () => {
    for (const definition of RUNS) results.set(definition.id, await executeRun(definition));
  });

  test('A: defaults as runtime-host wires them keep content and thinking append-only', () => {
    assertAllTurnsCompleted(run('A'));
    assertAppendOnly(run('A'));
    assert.ok(run('A').report.thinking.occurrencesChecked > 2_000);
  });

  test('B: with pruning and compaction off the result is the same', () => {
    assertAllTurnsCompleted(run('B'));
    assertAppendOnly(run('B'));
  });

  test('C: a tool result sent in full and archived later is rewritten', () => {
    const result = run('C');
    assertAllTurnsCompleted(result);
    assert.deepEqual(result.archiveWrites.failed, 1);
    const breaks = result.report.contentPrefix.breaks;
    assert.equal(breaks.length, 1, JSON.stringify(breaks));
    assert.match(breaks[0]!.path, /^\.content\[\d+\]\.content$/);
    assert.match(breaks[0]!.after ?? '', /maka\.archived_tool_result/);
    // Every other large result was archived before its first send.
    assert.ok(result.archiveWrites.attempted > 1);
    assert.deepEqual(result.report.thinking.failures, []);
  });

  test('D: proactive compaction replaces the history once it fires', () => {
    const result = run('D');
    assertAllTurnsCompleted(result);
    const checkpoint = firstCheckpointRequest(result);
    assertCompactionBreak(result, checkpoint);
    assert.equal(result.report.contentPrefix.breaks.length, 1);
    assertRedactedThinkingDroppedAfterCheckpoint(result, checkpoint);
  });

  test('E: reactive overflow recovery compacts mid-turn and the turn completes', () => {
    const result = run('E');
    // The injected 400 is recovered from inside turn 20; no error reaches the turn.
    assertAllTurnsCompleted(result);
    assert.deepEqual(result.turns[19]!.outcome.errors, []);
    const checkpoint = firstCheckpointRequest(result);
    assert.equal(result.requests[checkpoint]!.turn, 20);
    assertCompactionBreak(result, checkpoint);
    assertRedactedThinkingDroppedAfterCheckpoint(result, checkpoint);
  });

  test('F: manual compaction replaces the history, then drops later redacted thinking', () => {
    const result = run('F');
    assertAllTurnsCompleted(result);
    assert.equal(result.compactions.length, 1);
    const checkpoint = firstCheckpointRequest(result);
    assert.equal(result.requests[checkpoint]!.turn, 16);
    assertCompactionBreak(result, checkpoint);
    assertRedactedThinkingDroppedAfterCheckpoint(result, checkpoint);
    // Each later break is that same drop, at a turn boundary.
    for (const divergence of result.report.contentPrefix.breaks.filter(
      (d) => d.to !== checkpoint,
    )) {
      assert.equal(divergence.before, '"redacted_thinking"');
    }
  });

  test('G: a restart onto the same stores keeps content and thinking append-only', () => {
    assertAllTurnsCompleted(run('G'));
    assertAppendOnly(run('G'));
  });

  test('H: a session without llmConnectionId drops all prior-turn thinking', () => {
    const result = run('H');
    assertAllTurnsCompleted(result);
    const failures = result.report.thinking.failures;
    const lastTurn = result.turns.length;
    const emittedBeforeLastTurn = result.emittedThinking.filter(
      (thinking) => result.requests[thinking.requestIndex]!.turn !== lastTurn,
    );
    assert.equal(failures.length, emittedBeforeLastTurn.length);
    for (const failure of failures) {
      assert.equal(failure.kind, 'missing');
      const emittedTurn = result.requests[failure.emittedAt]!.turn!;
      assert.equal(failure.turn, emittedTurn + 1, 'dropped at the next turn, not within its own');
    }
  });
});
