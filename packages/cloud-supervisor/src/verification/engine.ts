import type { SignalManifest } from '../events.js';
import { clip } from '../text.js';
import { raceAbort } from './abort.js';
import { type Prepared, prepareCoding, prepareResearch } from './checks.js';
import { refFor, type VerificationKind } from './kind.js';
import { buildRequest, chooseVerifier, collectVerdicts, costUsd, upperBoundUsd } from './model.js';
import type { Mismatch, Outcome, VerificationOptions } from './ports.js';

/** The two limits a model check is gated by, before any request. */
export interface SpendGate {
  /**
   * Reserves `usd` against the day's cap and then the conversation's budget,
   * each in one synchronous step. Returns why it was refused, or undefined.
   */
  reserve(
    key: string,
    usd: number,
    conversationId: string,
    taskId: string,
  ): 'daily_cap' | 'conversation_budget' | undefined;
  /** Replaces the reservation with what was spent. */
  settle(key: string, usd: number): void;
}

export interface CheckInput {
  task: { taskId: string; conversationId: string; runner: string | null };
  manifest: SignalManifest;
  kind: VerificationKind;
  /** `verification id : epoch : attempt`, the key of this attempt's spend. */
  attemptKey: string;
  options: VerificationOptions;
  spend: SpendGate;
  signal: AbortSignal;
}

const MAX_MISMATCHES = 20;

function cannot(
  code: Extract<Outcome, { state: 'could_not_check' }>['code'],
  reason: string,
  transient: boolean,
): Outcome {
  return { state: 'could_not_check', code, reason, transient };
}

/**
 * Checks a finished task against its own artifacts: deterministic checks first,
 * then, only if they found nothing wrong and something is left to judge, a
 * model of another vendor than the runner. A deterministic failure is final; a
 * model can only add failures, never remove them. A check that did not run is
 * `could_not_check`, never a pass.
 */
export async function runCheck(input: CheckInput): Promise<Outcome> {
  const { task, manifest, options, signal } = input;

  const read: Parameters<typeof prepareCoding>[0]['read'] = async (name) => {
    const ref = refFor(manifest, name);
    if (ref === undefined) return { ok: false, reason: 'not_listed' };
    if (signal.aborted) return { ok: false, reason: 'unavailable' };
    try {
      return await raceAbort(options.evidence.readArtifact(task, ref, signal), signal);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  };

  let prepared: Prepared;
  try {
    prepared =
      input.kind === 'coding'
        ? await prepareCoding({ manifest, read })
        : await prepareResearch({
            read,
            fetcher: options.fetcher,
            signal,
            maxSources: options.maxSources ?? 40,
          });
  } catch {
    return cannot('unavailable', 'the evidence could not be gathered', true);
  }
  if (signal.aborted) return cannot('aborted', 'the check was stopped', true);

  // Cheap and certain first: this runs whatever is left of the budget.
  if (prepared.failures.length > 0) {
    return { state: 'failed', mismatches: prepared.failures.slice(0, MAX_MISMATCHES) };
  }
  if (prepared.unavailable.length > 0) {
    return cannot(
      'unavailable',
      clip(
        prepared.unavailable
          .map((entry) => entry.reason)
          .slice(0, 3)
          .join('; '),
        300,
      ),
      prepared.unavailable.some((entry) => entry.transient),
    );
  }
  // A pass needs something that was judged: an empty set of claims proves nothing.
  if (prepared.claims.length === 0) {
    return cannot('incomplete', 'there were no claims left to check', false);
  }

  const model = chooseVerifier(options.models, task.runner);
  if (!model) {
    return cannot(
      'no_verifier',
      'no model of another vendor is available to check this work',
      false,
    );
  }
  const request = buildRequest(model, prepared.claims, prepared.evidence);
  const bound = upperBoundUsd(model, request);
  if (bound === undefined) {
    return cannot(
      'budget',
      'the cost of the check could not be bounded safely, so the model check did not run',
      false,
    );
  }
  const reserved = input.spend.reserve(input.attemptKey, bound, task.conversationId, task.taskId);
  if (reserved !== undefined) {
    return cannot(
      'budget',
      reserved === 'daily_cap'
        ? 'the daily limit for independent checks is used up, so the model check did not run'
        : "this conversation's budget is used up, so the model check did not run",
      false,
    );
  }

  let reply: Awaited<ReturnType<typeof model.verify>>;
  try {
    reply = await raceAbort(model.verify(request, signal), signal);
  } catch {
    // Whether tokens were billed is unknown: the reservation stands as the charge.
    input.spend.settle(input.attemptKey, bound);
    return signal.aborted
      ? cannot('aborted', 'the check was stopped', true)
      : cannot('model_error', 'the checking model did not answer', true);
  }
  input.spend.settle(input.attemptKey, costUsd(model, reply.usage));

  const verdicts = collectVerdicts(reply.output, prepared.claims);
  if (!verdicts) return cannot('model_error', 'the checking model gave an unusable answer', true);
  const mismatches: Mismatch[] = prepared.mismatches(verdicts);
  if (mismatches.length > 0) {
    return { state: 'failed', mismatches: mismatches.slice(0, MAX_MISMATCHES) };
  }
  const missing = prepared.claims.filter((claim) => !verdicts.has(claim.id));
  if (missing.length > 0) {
    return cannot(
      'incomplete',
      `the checking model left ${missing.length} claims unanswered`,
      true,
    );
  }
  return { state: 'passed' };
}
