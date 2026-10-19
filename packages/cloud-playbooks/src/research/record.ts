import { z } from 'zod';
import { type CheckResult, type ClaimStatus, passed } from './check.js';
import { type Rendered, renderReport } from './render.js';
import type { Report } from './report-schema.js';

const STATUSES = [
  'verified',
  'quote_verified',
  'unsupported',
  'quote_not_found',
  'number_mismatch',
  'source_missing',
  'quote_too_short',
  'no_citation',
] as const satisfies readonly ClaimStatus[];

/** The cite-check record `cite-check` writes as verification.json: what a renderer needs to make the report again. */
export const VerificationRecordSchema = z
  .object({
    mode: z.enum(['drop_unsupported', 'keep']),
    claims: z
      .array(
        z.object({ id: z.string(), status: z.enum(STATUSES), removed: z.boolean() }).passthrough(),
      )
      .max(1000),
  })
  .passthrough();

export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

/** The check result the record states: statuses and the counts the rendering prints, nothing else. */
export function resultFromRecord(record: VerificationRecord): CheckResult {
  const count = (status: ClaimStatus) =>
    record.claims.filter((claim) => claim.status === status).length;
  return {
    claims: record.claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      reasons: [],
      judged: false,
    })),
    counts: {
      total: record.claims.length,
      verified: count('verified'),
      quoteVerified: count('quote_verified'),
      failed: record.claims.filter((claim) => !passed(claim.status)).length,
      judged: 0,
    },
    unknownJudgments: [],
  };
}

/** The report and its renderings as `cite-check` made them, from the report and the record alone. */
export function renderFromRecord(report: Report, record: VerificationRecord): Rendered {
  return renderReport(report, resultFromRecord(record), {
    dropFailed: record.mode === 'drop_unsupported',
  });
}
