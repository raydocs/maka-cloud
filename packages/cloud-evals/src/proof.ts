import type { JsonObject } from '@maka/eval';

/**
 * What the playbook's own record (`verification.json`) says about a change it handed over: the
 * facts of the pull request's proof block. The scorecard sets them against the hidden tests, so a
 * run that says "proven" and is wrong shows up as false confidence.
 */
export interface ProofSignals {
  /** A reproduction test was written and failed before the change. */
  reproduced: boolean;
  /** A second agent reviewed the change. */
  reviewed: boolean;
  /** The reviewer is another vendor than the agent that wrote the last attempt. */
  crossVendor: boolean;
  /** Findings that remain open, by severity. */
  open: { P1: number; P2: number; P3: number };
  /** Implementer attempts. */
  attempts: number;
  /** The change passed its checks but was kept for the owner instead of delivered. */
  kept: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

/** Reads the proof from a parsed `verification.json`; null when it is not one. */
export function proofOf(verification: unknown): ProofSignals | null {
  if (!isRecord(verification) || !Array.isArray(verification['attempts'])) return null;
  const attempts = verification['attempts'].filter(isRecord);
  const review = isRecord(verification['review']) ? verification['review'] : null;
  const reviewed = review?.['status'] === 'reviewed';
  const counts = review && isRecord(review['counts']) ? review['counts'] : {};
  const lastVendor = attempts.at(-1)?.['vendor'];
  return {
    reproduced: isRecord(verification['repro']),
    reviewed,
    crossVendor:
      reviewed &&
      typeof review?.['reviewer'] === 'string' &&
      typeof lastVendor === 'string' &&
      review['reviewer'] !== lastVendor,
    open: { P1: count(counts['P1']), P2: count(counts['P2']), P3: count(counts['P3']) },
    attempts: attempts.length,
    kept: isRecord(verification['kept']),
  };
}

/**
 * Handed over with nothing left for the owner to do: delivered (not kept), a reproduction test,
 * a second agent's review and no open P1. This is the bar for merging without reading the change.
 */
export function handsOff(proof: ProofSignals | null): boolean {
  return proof !== null && !proof.kept && proof.reproduced && proof.reviewed && proof.open.P1 === 0;
}

export function proofArtifact(proof: ProofSignals): JsonObject {
  return { kind: 'proof', ...proof, open: { ...proof.open } };
}

/** The proof a result's artifacts carry, if any. */
export function proofFromArtifacts(artifacts: readonly JsonObject[]): ProofSignals | null {
  const found = artifacts.find((artifact) => artifact['kind'] === 'proof');
  if (!found) return null;
  const { open } = found;
  if (!isRecord(open)) return null;
  return {
    reproduced: found['reproduced'] === true,
    reviewed: found['reviewed'] === true,
    crossVendor: found['crossVendor'] === true,
    open: { P1: count(open['P1']), P2: count(open['P2']), P3: count(open['P3']) },
    attempts: count(found['attempts']),
    kept: found['kept'] === true,
  };
}
