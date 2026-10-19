import type { Conductor } from '@maka-cloud/conductor';
import type { BudgetPort } from '@maka-cloud/supervisor';

type SpendApi = Pick<Conductor, 'reserveSpend' | 'settleSpend'>;

/**
 * The verification's budget port over the conductor's run budget (T5). A reservation is charged
 * to the run that delegated the checked task, in the same transaction that guards delegations,
 * so a check cannot overdraw the run and a run cannot overdraw a check. Anything unexpected is a
 * refusal: a check that cannot prove it has budget does not run.
 */
export function conductorBudget(
  conductor: SpendApi,
  warn: (message: string, detail?: unknown) => void = () => undefined,
): BudgetPort {
  return {
    reserve(request) {
      try {
        const result = conductor.reserveSpend(
          request.key,
          request.conversationId,
          request.taskId,
          request.maxUsd,
        );
        if (result.ok) return { ok: true };
        return { ok: false, reason: REFUSALS[result.reason] };
      } catch (error) {
        warn('The conversation budget could not be read', error);
        return { ok: false, reason: 'the conversation budget could not be read' };
      }
    },
    settle(key, actualUsd) {
      try {
        const result = conductor.settleSpend(key, actualUsd);
        // An unknown key is a reservation that never happened (a refusal released first): nothing to settle.
        if (!result.ok && result.reason !== 'not_found') {
          warn(`The verification charge ${key} was not settled: ${result.reason}`);
        }
      } catch (error) {
        warn(`The verification charge ${key} could not be settled`, error);
      }
    },
  };
}

const REFUSALS = {
  budget: "the conversation's budget cannot cover the check",
  no_run: 'there is no run of this conversation to charge the check to',
  conflict: 'the check was already reserved with different terms',
  invalid_amount: 'the check had no valid cost',
} as const;
