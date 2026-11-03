export interface ReviewReceipt {
  pr: string;
  sha: string;
  verdict: 'CLEAR' | 'BLOCK';
  at: number;
  summary: string;
}

export interface ReviewerPort {
  review(input: { repo: string; number: number; sha: string }): Promise<{ text: string }>;
}

/** Test double. Production hosts pass a non-interactive reviewer. */
export class FakeReviewer implements ReviewerPort {
  verdict: 'CLEAR' | 'BLOCK' | 'none' = 'CLEAR';

  async review(): Promise<{ text: string }> {
    if (this.verdict === 'none') return { text: 'looked at the diff; no VERDICT line' };
    return { text: `findings: none\nVERDICT: ${this.verdict}` };
  }
}

export function parseReviewVerdict(text: string): 'CLEAR' | 'BLOCK' | undefined {
  const hits = [...text.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = hits.at(-1);
  return last?.[1] === 'CLEAR' || last?.[1] === 'BLOCK' ? last[1] : undefined;
}

export function prRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function hasClearReceipt(
  receipts: readonly ReviewReceipt[] | undefined,
  pr: string,
  sha: string,
): boolean {
  return (receipts ?? []).some(
    (row) => row.pr === pr && row.sha === sha && row.verdict === 'CLEAR',
  );
}

export function receiptFromReview(
  text: string,
  input: { repo: string; number: number; sha: string; at: number },
): ReviewReceipt | undefined {
  const verdict = parseReviewVerdict(text);
  if (!verdict) return undefined;
  return {
    pr: prRef(input.repo, input.number),
    sha: input.sha,
    verdict,
    at: input.at,
    summary: text.trim().slice(-4000),
  };
}
