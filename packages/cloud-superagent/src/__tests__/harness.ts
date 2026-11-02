import { sequentialIds } from '../ids.js';
import { MemorySuperagentStore } from '../memory-store.js';
import { RecordingJudge } from '../router.js';
import { RecordingHandler, Superagent, type SuperagentOptions } from '../runtime.js';
import type { MeteringHooks, UsageEntry } from '../types.js';

export const TENANT = 'inv_test';
export const REPO = 'acme/app';

export function clock(start = 1_700_000_000_000): {
  now: number;
  advance: (ms: number) => void;
  read: () => number;
} {
  const c = {
    now: start,
    advance(ms: number) {
      c.now += ms;
    },
    read: () => c.now,
  };
  return c;
}

export function metering(): MeteringHooks & { records: UsageEntry[]; stop: boolean } {
  const hooks = {
    records: [] as UsageEntry[],
    stop: false,
    record(entry: UsageEntry) {
      hooks.records.push(entry);
    },
    admit() {
      return hooks.stop ? ('stop' as const) : ('ok' as const);
    },
  };
  return hooks;
}

export function prPayload(
  action: string,
  number = 12,
  extras: Record<string, unknown> = {},
): unknown {
  return {
    action,
    pull_request: {
      number,
      title: `PR ${number}`,
      user: { login: 'alice', type: 'User' },
      head: { ref: 'maka/pr-12' },
      ...extras,
    },
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
  };
}

export function issuePayload(action: string, number = 4, body = 'please fix the login'): unknown {
  return {
    action,
    issue: {
      number,
      title: `Issue ${number}`,
      body,
      user: { login: 'alice', type: 'User' },
    },
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
  };
}

export function commentPayload(number: number, body: string, onPr = true, commentId = 90): unknown {
  return {
    action: 'created',
    issue: {
      number,
      title: `Item ${number}`,
      ...(onPr ? { pull_request: {} } : {}),
    },
    comment: { id: commentId, body },
    repository: { full_name: REPO },
    sender: { login: 'bob', type: 'User' },
  };
}

export function workflowPayload(
  conclusion: 'success' | 'failure' | 'timed_out',
  pr?: number,
): unknown {
  return {
    action: 'completed',
    workflow_run: {
      id: 77,
      name: 'ci',
      head_sha: 'abc123def456',
      conclusion,
      head_branch: 'maka/pr-12',
      ...(pr === undefined ? {} : { pull_requests: [{ number: pr }] }),
    },
    repository: { full_name: REPO },
    sender: { login: 'github-actions[bot]', type: 'Bot' },
  };
}

export function github(
  tenantId: string,
  deliveryId: string,
  event: string,
  payload: unknown,
): {
  source: 'github';
  tenantId: string;
  deliveryId: string;
  event: string;
  payload: unknown;
} {
  return { source: 'github', tenantId, deliveryId, event, payload };
}

export function rig(overrides: SuperagentOptions = {}) {
  const time = clock();
  const judge = overrides.judge instanceof RecordingJudge ? overrides.judge : new RecordingJudge();
  const handler =
    overrides.handler instanceof RecordingHandler ? overrides.handler : new RecordingHandler();
  const usage = metering();
  const store = overrides.store ?? new MemorySuperagentStore();
  const agent = new Superagent({
    store,
    judge,
    handler,
    clock: time.read,
    ids: sequentialIds(),
    metering: overrides.metering ?? usage,
    ...overrides,
  });
  return { agent, time, judge, handler, store, usage };
}
