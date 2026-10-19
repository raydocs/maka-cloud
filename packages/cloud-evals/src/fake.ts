import { createHash } from 'node:crypto';
import { outcomeOf } from './sandbox-ops.js';
import {
  type Grade,
  type Grader,
  type HiddenTests,
  type HiddenTestSource,
  type DriverInput,
  type DriverResult,
  type SubjectDriver,
} from './types.js';

/** What a fake subject looks like: how often it resolves a task and what a run costs. */
export interface FakeProfile {
  resolveRate: number;
  /** Median dollars of a run. */
  medianCostUsd: number;
  /** Share of runs that fail after spending. */
  failRate: number;
}

/** Shaped like a cheap-and-weaker, a middle and an expensive-and-stronger subject. */
export const FAKE_PROFILES: Readonly<Record<string, FakeProfile>> = {
  codex: { resolveRate: 0.4, medianCostUsd: 0.6, failRate: 0.04 },
  'claude-agent-sdk': { resolveRate: 0.46, medianCostUsd: 0.9, failRate: 0.04 },
  'coding-playbook': { resolveRate: 0.6, medianCostUsd: 1.9, failRate: 0.03 },
};

export const FAKE_RESOLVES = 'FAKE-RESOLVES';

function unit(...parts: string[]): number[] {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest();
  return [0, 4, 8, 12].map((offset) => digest.readUInt32BE(offset) / 0x1_0000_0000);
}

/**
 * A subject that needs no sandbox, no model and no network: its outcome, cost and failures are a
 * fixed function of (subject, task). It is the dry-run subject.
 */
export class FakeDriver implements SubjectDriver {
  constructor(
    private readonly subjectId: string,
    private readonly profile: FakeProfile = FAKE_PROFILES[subjectId] ?? FAKE_PROFILES['codex']!,
  ) {}

  async run(input: DriverInput): Promise<DriverResult> {
    const [resolve, size, fail] = unit(this.subjectId, input.task.id);
    // Log-normal-ish spread around the median, capped by the budget the run was given.
    const cost = Math.min(
      input.budgetUsd,
      Math.round(this.profile.medianCostUsd * 2 ** ((size! - 0.5) * 3) * 1e4) / 1e4,
    );
    if (fail! < this.profile.failRate) {
      return { outcome: null, costUsd: cost, end: 'failed', failureReason: 'fake subject failed' };
    }
    const resolves = resolve! < this.profile.resolveRate;
    const patch = `diff --git a/f b/f\n# ${resolves ? FAKE_RESOLVES : 'FAKE-WRONG'} ${this.subjectId} ${input.task.id}\n`;
    return {
      outcome: outcomeOf(patch, ['f']),
      costUsd: cost,
      end: 'finished',
      failureReason: null,
    };
  }
}

/** Resolved when the fake patch says so. */
export class FakeGrader implements Grader {
  async grade(input: { outcome: { patch: string } }): Promise<Grade> {
    const resolved = input.outcome.patch.includes(FAKE_RESOLVES);
    return { resolved, detail: resolved ? 'fake tests passed' : 'fake tests failed' };
  }
}

export class FakeHiddenTests implements HiddenTestSource {
  async load(taskId: string): Promise<HiddenTests> {
    return {
      suite: 'swe-bench-verified',
      testPatch: `fake test patch for ${taskId}`,
      failToPass: [],
      passToPass: [],
    };
  }
}
