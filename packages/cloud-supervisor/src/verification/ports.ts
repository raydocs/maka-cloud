import type { SourceFetcher } from './fetcher.js';

/** What the supervisor needs from the server to check a finished task. Declared here, implemented by the server. */

export type ArtifactRead =
  /** `text` is `bytes` decoded, lossily: a comparison that must be exact uses `bytes`. */
  | { ok: true; text: string; bytes: Uint8Array }
  | { ok: false; reason: 'not_found' | 'too_large' | 'unavailable' };

export interface EvidenceSource {
  /** Reads an artifact the task listed in its manifest, by the reference it listed. Never follows a link. */
  readArtifact(
    task: { taskId: string; conversationId: string },
    ref: string,
    signal: AbortSignal,
  ): Promise<ArtifactRead>;
}

/** The conversation's budget (T5): one synchronous reserve, settled to the actual cost. */
export interface BudgetPort {
  reserve(request: {
    key: string;
    conversationId: string;
    taskId: string;
    maxUsd: number;
  }): { ok: true } | { ok: false; reason: string };
  /** Replaces the reservation with what was spent. Idempotent by key. */
  settle(key: string, actualUsd: number): void;
}

export type Vendor = 'anthropic' | 'openai' | 'google' | 'other';

export interface VerifierRequest {
  /** Fixed by the supervisor. */
  instructions: string;
  /** Claims and quoted evidence, in delimited blocks. */
  prompt: string;
  maxOutputTokens: number;
}

/** One model that can check evidence. A stateless one-shot request; API key only. */
/**
 * Charges one check's model request for a model that reserves its own cost: it reserves the
 * worst case of the exact request it sends, before sending it, and settles what it cost.
 */
export interface CheckCharge {
  /** Reserves against the day's cap, then the conversation's budget. Returns why it was refused, or undefined. */
  reserve(usd: number): 'daily_cap' | 'conversation_budget' | undefined;
  settle(usd: number): void;
}

export interface VerifierModel {
  /** Internal name. Never shown to the user. */
  id: string;
  vendor: Vendor;
  price: { inputPerMTokUsd: number; outputPerMTokUsd: number };
  maxInputChars: number;
  maxOutputTokens: number;
  /**
   * The model reserves and settles its request through `charge` itself (the model gateway).
   * The supervisor then makes no cost estimate of its own and charges nothing else.
   */
  metered?: boolean;
  /** Returns the parsed JSON of the reply as `output`; the supervisor validates it. */
  verify(
    request: VerifierRequest,
    signal: AbortSignal,
    charge?: CheckCharge,
  ): Promise<{ output: unknown; usage: { inputTokens: number; outputTokens: number } }>;
}

export interface VerificationOptions {
  evidence: EvidenceSource;
  fetcher: SourceFetcher;
  budget: BudgetPort;
  /** The pool a verifier is chosen from: any model of another vendor than the runner that did the work. */
  models: readonly VerifierModel[];
  /** Verifications running at once. Default 2. */
  concurrency?: number;
  /** For one attempt, fetches and the model call included. Default 5 minutes. */
  deadlineMs?: number;
  /** Attempts for a check that could not run for a passing reason. Default 3. */
  maxAttempts?: number;
  /** First retry delay; it doubles. Default 1 minute. */
  backoffMs?: number;
  /** Cited sources fetched for one report. Default 40. */
  maxSources?: number;
}

export interface Mismatch {
  /** What was claimed. */
  claim: string;
  /** What the evidence showed. */
  found: string;
}

export type Outcome =
  | { state: 'passed' }
  | { state: 'failed'; mismatches: Mismatch[] }
  | {
      state: 'could_not_check';
      code:
        | 'budget'
        | 'no_verifier'
        | 'unavailable'
        | 'model_error'
        | 'incomplete'
        | 'aborted'
        | 'unverified';
      reason: string;
      /** A later attempt may succeed without anyone changing anything. */
      transient: boolean;
    };
