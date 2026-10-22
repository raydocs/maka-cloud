export type SuiteId = 'swe-bench-verified' | 'terminal-bench';

/** Everything a subject may see about a task. Hidden tests are not in here, by construction. */
export interface PublicTask {
  id: string;
  suite: SuiteId;
  /** `owner/name` on GitHub; null for a suite whose tasks are not a repository (Terminal-Bench). */
  repo: string | null;
  /** The commit the task starts from. */
  baseCommit: string | null;
  /** The task as the subject is told it. */
  statement: string;
  /** The repository's own visible test command, when the spec names one. */
  testCommand: string | null;
}

/** What only the grader may see. */
export interface HiddenTests {
  suite: SuiteId;
  testPatch: string;
  failToPass: string[];
  passToPass: string[];
}

/** The change a subject made, as a patch against the task's base commit. */
export interface Outcome {
  patch: string;
  /** Repository paths the patch touches. */
  files: string[];
  sha256: string;
}

import type { ProofSignals } from './proof.js';

export type DriverEnd = 'finished' | 'failed' | 'timeout' | 'cancelled';

export interface DriverInput {
  task: PublicTask;
  /** Orchestrator-style task id (`tsk_<hex>`), unique per attempt. */
  taskId: string;
  /** A host directory private to this attempt. */
  hostDir: string;
  /** Dollars the run may spend. */
  budgetUsd: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface DriverResult {
  /** Null when the run left no change to grade. */
  outcome: Outcome | null;
  /** Dollars the run reported; null when it reported none. */
  costUsd: number | null;
  end: DriverEnd;
  failureReason: string | null;
  /** What the subject's own record says about its change; only the playbook keeps one. */
  proof?: ProofSignals | null;
}

/**
 * Runs one subject on one task. By the time `run` settles, whatever it started is stopped and
 * its sandbox is given back: the grader sees hidden tests only after that.
 */
export interface SubjectDriver {
  run(input: DriverInput): Promise<DriverResult>;
}

/** A driver failure that is the infrastructure's, not the subject's. Carries what was spent. */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly costUsd: number | null = null,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

export interface Grade {
  resolved: boolean;
  detail: string;
}

export interface Grader {
  grade(input: {
    task: PublicTask;
    hidden: HiddenTests;
    outcome: Outcome;
    signal?: AbortSignal;
  }): Promise<Grade>;
}

/** Where hidden tests come from. Only the grading step calls it. */
export interface HiddenTestSource {
  load(taskId: string): Promise<HiddenTests>;
}

export const SUBJECT_IDS = ['claude-agent-sdk', 'codex', 'coding-playbook'] as const;
export type SubjectId = (typeof SUBJECT_IDS)[number];
