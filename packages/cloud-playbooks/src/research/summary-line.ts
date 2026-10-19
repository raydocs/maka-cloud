/**
 * The one line `cite-check` prints and the runner copies, unchanged, into the
 * result manifest's `done`. `verify` parses it strictly: anything else fails.
 */
export interface CiteCheckSummary {
  claims: number;
  verified: number;
  quoteVerified: number;
  failed: number;
  /** Failed claims dropped from the report. */
  removed: number;
  /** Claims a reviewer gave a judgment on. */
  judged: number;
}

const LINE =
  /^cite-check v1: claims=(\d+) verified=(\d+) quote_verified=(\d+) failed=(\d+) removed=(\d+) judged=(\d+)$/;

export function formatCiteCheckLine(summary: CiteCheckSummary): string {
  return `cite-check v1: claims=${summary.claims} verified=${summary.verified} quote_verified=${summary.quoteVerified} failed=${summary.failed} removed=${summary.removed} judged=${summary.judged}`;
}

export type ParsedSummary = { ok: true; summary: CiteCheckSummary } | { ok: false; reason: string };

/** Parses a line strictly and checks that its counts add up. */
export function parseCiteCheckLine(line: string): ParsedSummary {
  const match = LINE.exec(line);
  if (!match) return { ok: false, reason: 'the cite-check line is malformed' };
  const [claims, verified, quoteVerified, failed, removed, judged] = match
    .slice(1)
    .map((digits) => Number(digits));
  if (![claims, verified, quoteVerified, failed, removed, judged].every(Number.isSafeInteger)) {
    return { ok: false, reason: 'the cite-check line has a count that is too large' };
  }
  const summary = {
    claims: claims as number,
    verified: verified as number,
    quoteVerified: quoteVerified as number,
    failed: failed as number,
    removed: removed as number,
    judged: judged as number,
  };
  if (summary.verified + summary.quoteVerified + summary.failed !== summary.claims) {
    return { ok: false, reason: 'the cite-check counts do not add up to the number of claims' };
  }
  if (summary.removed > summary.failed || summary.judged > summary.claims) {
    return { ok: false, reason: 'the cite-check counts are inconsistent' };
  }
  return { ok: true, summary };
}
