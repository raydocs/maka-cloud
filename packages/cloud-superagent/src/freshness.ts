export interface LiveFacts {
  sha?: string;
  ci?: string;
  prMerged?: boolean;
  at: number;
}

export function freshnessOf(
  live: LiveFacts,
  cached: Partial<LiveFacts>,
  now: number,
  staleAfterMs = 15 * 60_000,
): { stale: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (cached.sha && live.sha && cached.sha !== live.sha) {
    reasons.push(`head moved ${cached.sha.slice(0, 8)} → ${live.sha.slice(0, 8)}`);
  }
  if (cached.ci && live.ci && cached.ci !== live.ci) {
    reasons.push(`ci ${cached.ci} → ${live.ci}`);
  }
  if (cached.prMerged === false && live.prMerged === true) {
    reasons.push('PR merged since the cached report');
  }
  if (cached.at !== undefined && now - cached.at > staleAfterMs) {
    reasons.push('cached report older than the freshness window');
  }
  return { stale: reasons.length > 0, reasons };
}

export function formatLeadReport(input: {
  workerId: string;
  live: LiveFacts;
  freshness: { stale: boolean; reasons: string[] };
  plan: string;
  progress?: string;
}): string {
  const freshness = input.freshness.stale ? `STALE ${input.freshness.reasons.join('; ')}` : 'fresh';
  return [
    `worker ${input.workerId}`,
    `live sha=${input.live.sha ?? '(none)'} ci=${input.live.ci ?? '(none)'} merged=${input.live.prMerged ?? false}`,
    freshness,
    input.plan,
    ...(input.progress ? [input.progress] : []),
  ].join('\n');
}
