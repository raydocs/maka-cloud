import { overBudget } from './safety.js';
import type { SuperagentStore } from './store.js';
import type { WatchdogFinding, WatchdogSettings, WorkerRecord } from './types.js';
import { isLiveState } from './types.js';

export interface WatchdogActions {
  restart(worker: WorkerRecord, at: number): Promise<void>;
  retire(worker: WorkerRecord, at: number, reason: string): Promise<void>;
  stop(worker: WorkerRecord, at: number, reason: string): Promise<void>;
  markStuck(worker: WorkerRecord, at: number): void;
}

export function evaluateWorker(
  worker: WorkerRecord,
  settings: WatchdogSettings,
  at: number,
  pendingExpired: boolean,
): WatchdogFinding | undefined {
  if (!isLiveState(worker.state) && worker.state !== 'retiring') return undefined;
  if (worker.subject.closed && worker.state !== 'retiring' && worker.state !== 'retired') {
    return finding(worker, 'subject_closed', 'retire', 'The subject closed.');
  }
  if (pendingExpired && worker.state === 'awaiting_approval') {
    return finding(worker, 'awaiting_expired', 'retire', 'The approval expired.');
  }
  const budget = overBudget(worker);
  if (budget) {
    return finding(worker, 'over_budget', 'stop', `Budget ${budget} exhausted.`);
  }
  if (isLiveState(worker.state) && worker.stepRepeats >= settings.loopRepeat) {
    return finding(
      worker,
      'looping',
      'escalate',
      `Step ${worker.lastStepSignature} repeated ${worker.stepRepeats} times.`,
    );
  }
  if (
    (worker.state === 'running' || worker.state === 'waking') &&
    at - worker.lastProgressAt > settings.stallAfterMs
  ) {
    return finding(worker, 'stuck', 'escalate', 'No progress inside the stall window.');
  }
  if (
    worker.state === 'crashed' ||
    (worker.state === 'running' && at - worker.lastHeartbeatAt > settings.heartbeatAfterMs)
  ) {
    const action = worker.generation < settings.maxRestarts ? 'restart' : 'escalate';
    return finding(worker, 'crashed', action, 'Heartbeat lost or the handler crashed.');
  }
  return undefined;
}

function finding(
  worker: WorkerRecord,
  rule: WatchdogFinding['rule'],
  action: WatchdogFinding['action'],
  detail: string,
): WatchdogFinding {
  return {
    rule,
    tenantId: worker.tenantId,
    workerId: worker.workerId,
    action,
    generation: worker.generation,
    detail,
  };
}

export async function runWatchdog(
  store: SuperagentStore,
  settings: WatchdogSettings,
  actions: WatchdogActions,
  at: number,
): Promise<WatchdogFinding[]> {
  const findings: WatchdogFinding[] = [];
  for (const worker of store.allWorkers()) {
    const expired = store
      .pendingApprovals(worker.tenantId, worker.workerId)
      .some((row) => row.expiresAt <= at);
    const found = evaluateWorker(worker, settings, at, expired);
    if (!found) continue;
    findings.push(found);
    if (found.action === 'restart') await actions.restart(worker, at);
    else if (found.action === 'retire') await actions.retire(worker, at, found.detail);
    else if (found.action === 'stop') await actions.stop(worker, at, found.detail);
    else actions.markStuck(worker, at);
    if (expired) {
      for (const row of store.pendingApprovals(worker.tenantId, worker.workerId)) {
        if (row.expiresAt <= at) {
          store.putApproval({ ...row, state: 'expired', decidedAt: at });
        }
      }
    }
  }
  return findings;
}
