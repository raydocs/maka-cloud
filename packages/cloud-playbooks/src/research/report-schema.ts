import { z } from 'zod';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'ids are 1-64 letters, digits, "_" or "-"');

const HttpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'a source URL must be http or https');

export const CitationSchema = z
  .object({ sourceId: Id, quote: z.string().min(1).max(2000) })
  .strict();

export const ClaimSchema = z
  .object({
    id: Id,
    /** One checkable statement, without citation markers: the renderer adds those. */
    text: z.string().min(1).max(2000),
    citations: z.array(CitationSchema).max(8),
  })
  .strict();

export const SourceSchema = z
  .object({ id: Id, url: HttpUrl, title: z.string().max(300).optional() })
  .strict();

export const ReportSchema = z
  .object({
    title: z.string().min(1).max(300),
    sections: z
      .array(
        z
          .object({ heading: z.string().min(1).max(300), claims: z.array(ClaimSchema).max(200) })
          .strict(),
      )
      .max(50),
    sources: z.array(SourceSchema).max(200),
  })
  .strict();

export const JudgmentSchema = z
  .object({ claimId: Id, entailed: z.boolean(), reason: z.string().min(1).max(1000) })
  .strict();

export const JudgmentsSchema = z.array(JudgmentSchema).max(1000);

export type Citation = z.infer<typeof CitationSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type Judgment = z.infer<typeof JudgmentSchema>;

export function claimsOf(report: Report): Claim[] {
  return report.sections.flatMap((section) => section.claims);
}
