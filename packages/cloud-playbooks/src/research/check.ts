import type { Claim, Judgment } from './report-schema.js';
import { normalizeText, numbersIn } from './source-text.js';

/** A quote shorter than this proves nothing about a claim. */
export const MIN_QUOTE_WORDS = 4;
export const MIN_QUOTE_CHARS = 20;

/** The text of one fetched source. Fetching it is the caller's job. */
export interface SourceText {
  id: string;
  text: string;
}

export type ClaimStatus =
  /** The quote is in the source, the claim's numbers are in the quote, and a reviewer judged the quote supports the claim. */
  | 'verified'
  /** The quote is in the source and the claim's numbers are in the quote. Nobody judged whether the quote supports the claim. */
  | 'quote_verified'
  /** The quote is real but a reviewer judged it does not support the claim. */
  | 'unsupported'
  | 'quote_not_found'
  | 'number_mismatch'
  | 'source_missing'
  | 'quote_too_short'
  | 'no_citation';

export interface ClaimResult {
  id: string;
  status: ClaimStatus;
  reasons: string[];
  /** A reviewer judgment was given for this claim, whatever it said. */
  judged: boolean;
}

export interface CheckCounts {
  total: number;
  verified: number;
  quoteVerified: number;
  failed: number;
  judged: number;
}

export interface CheckResult {
  claims: ClaimResult[];
  counts: CheckCounts;
  /** Judgments naming a claim that is not in the report. */
  unknownJudgments: string[];
}

export class CitationInputError extends Error {}

export function passed(status: ClaimStatus): boolean {
  return status === 'verified' || status === 'quote_verified';
}

/**
 * Checks every claim against the text of the sources it cites. Pure: no I/O, no
 * clock, no model. A claim passes the mechanical checks only if each of its
 * quotes occurs in the cited source and every number in the claim occurs in its
 * quotes. A reviewer judgment can then only downgrade a claim that passed.
 */
export function checkCitations(input: {
  claims: readonly Claim[];
  sources: readonly SourceText[];
  judgments?: readonly Judgment[];
}): CheckResult {
  const sources = new Map<string, string>();
  for (const source of input.sources) {
    if (sources.has(source.id)) throw new CitationInputError(`duplicate source id "${source.id}"`);
    sources.set(source.id, normalizeText(source.text));
  }
  const seen = new Set<string>();
  for (const claim of input.claims) {
    if (seen.has(claim.id)) throw new CitationInputError(`duplicate claim id "${claim.id}"`);
    seen.add(claim.id);
  }

  const judgments = new Map<string, Judgment[]>();
  const unknownJudgments: string[] = [];
  for (const judgment of input.judgments ?? []) {
    if (!seen.has(judgment.claimId)) {
      if (!unknownJudgments.includes(judgment.claimId)) unknownJudgments.push(judgment.claimId);
      continue;
    }
    judgments.set(judgment.claimId, [...(judgments.get(judgment.claimId) ?? []), judgment]);
  }

  const claims = input.claims.map((claim) =>
    checkClaim(claim, sources, judgments.get(claim.id) ?? []),
  );
  const count = (status: ClaimStatus) => claims.filter((claim) => claim.status === status).length;
  return {
    claims,
    counts: {
      total: claims.length,
      verified: count('verified'),
      quoteVerified: count('quote_verified'),
      failed: claims.filter((claim) => !passed(claim.status)).length,
      judged: claims.filter((claim) => claim.judged).length,
    },
    unknownJudgments,
  };
}

function checkClaim(
  claim: Claim,
  sources: ReadonlyMap<string, string>,
  judgments: readonly Judgment[],
): ClaimResult {
  const judged = judgments.length > 0;
  const fail = (status: ClaimStatus, reason: string): ClaimResult => ({
    id: claim.id,
    status,
    reasons: [reason],
    judged,
  });

  if (claim.citations.length === 0) return fail('no_citation', 'the claim cites no source');

  const quotes: string[] = [];
  for (const citation of claim.citations) {
    const source = sources.get(citation.sourceId);
    if (source === undefined) {
      return fail('source_missing', `no fetched text for source "${citation.sourceId}"`);
    }
    const quote = normalizeText(citation.quote);
    if (quote.length < MIN_QUOTE_CHARS || quote.split(' ').length < MIN_QUOTE_WORDS) {
      return fail(
        'quote_too_short',
        `the quote from "${citation.sourceId}" is under ${MIN_QUOTE_WORDS} words or ${MIN_QUOTE_CHARS} characters`,
      );
    }
    if (!source.includes(quote)) {
      return fail(
        'quote_not_found',
        `the quote is not in the text of source "${citation.sourceId}"`,
      );
    }
    quotes.push(quote);
  }

  const quoted = new Set(quotes.flatMap(numbersIn));
  const missing = [...new Set(numbersIn(normalizeText(claim.text)))].filter((n) => !quoted.has(n));
  if (missing.length > 0) {
    return fail(
      'number_mismatch',
      `the claim states ${missing.join(', ')}, which its quotes do not contain`,
    );
  }

  const rejected = judgments.filter((judgment) => !judgment.entailed);
  if (rejected.length > 0) {
    return {
      id: claim.id,
      status: 'unsupported',
      reasons: rejected.map((judgment) => judgment.reason),
      judged,
    };
  }
  return { id: claim.id, status: judged ? 'verified' : 'quote_verified', reasons: [], judged };
}
