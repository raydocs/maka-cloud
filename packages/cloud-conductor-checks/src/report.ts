import type { Divergence, HistoryCheckReport } from './checks.js';
import type { RunResult } from './runs.js';

export interface RunSummary {
  readonly id: string;
  readonly title: string;
  readonly turnsCompleted: number;
  readonly turnErrors: number;
  readonly mainRequests: number;
  readonly summaryRequests: number;
  readonly strictPrefixBreaks: Record<string, number>;
  readonly contentPrefixBreaks: Divergence[];
  readonly thinkingFailures: HistoryCheckReport['thinking']['failures'];
  readonly thinkingEmitted: number;
  readonly breakpointFailures: HistoryCheckReport['breakpoints']['failures'];
  readonly maxBreakpoints: number;
  readonly systemChanges: number;
  readonly toolsChanges: number;
}

export function summarizeRun(result: RunResult): RunSummary {
  const { report } = result;
  const strict: Record<string, number> = {};
  for (const divergence of report.strictPrefix.breaks) {
    strict[divergence.cause] = (strict[divergence.cause] ?? 0) + 1;
  }
  return {
    id: result.definition.id,
    title: result.definition.title,
    turnsCompleted: result.turns.filter((turn) => turn.outcome.stopReason === 'end_turn').length,
    turnErrors: result.turns.reduce((count, turn) => count + turn.outcome.errors.length, 0),
    mainRequests: report.requests,
    summaryRequests: result.requests.filter((request) => request.kind === 'summary').length,
    strictPrefixBreaks: strict,
    contentPrefixBreaks: report.contentPrefix.breaks,
    thinkingFailures: report.thinking.failures,
    thinkingEmitted: report.thinking.emitted,
    breakpointFailures: report.breakpoints.failures,
    maxBreakpoints: Math.max(0, ...report.breakpoints.observations.map((o) => o.total)),
    systemChanges: report.systemChanges.length,
    toolsChanges: report.toolsChanges.length,
  };
}

/** A Markdown table per run, for the findings doc and the PR description. */
export function renderMarkdown(results: readonly RunResult[]): string {
  const lines: string[] = [
    '| Run | Setting | Turns ok | Strict prefix breaks | Content prefix breaks | Thinking failures | Breakpoint failures |',
    '|---|---|---|---|---|---|---|',
  ];
  const details: string[] = [];
  for (const result of results) {
    const summary = summarizeRun(result);
    const strict =
      Object.entries(summary.strictPrefixBreaks)
        .map(([cause, count]) => `${count} ${cause}`)
        .join(', ') || '0';
    lines.push(
      `| ${summary.id} | ${summary.title} | ${summary.turnsCompleted}/${result.turns.length} | ${strict} | ${summary.contentPrefixBreaks.length} | ${summary.thinkingFailures.length} of ${summary.thinkingEmitted} | ${summary.breakpointFailures.length} |`,
    );
    if (
      summary.contentPrefixBreaks.length === 0 &&
      summary.thinkingFailures.length === 0 &&
      summary.breakpointFailures.length === 0
    ) {
      continue;
    }
    details.push(`### Run ${summary.id}: ${summary.title}`, '');
    for (const divergence of summary.contentPrefixBreaks) {
      details.push(
        `- Prefix: request ${divergence.from} (turn ${divergence.fromTurn}) to ${divergence.to} (turn ${divergence.toTurn}), \`messages[${divergence.messageIndex}]${divergence.path}\`: ${divergence.before} became ${divergence.after}`,
      );
    }
    const byKind = new Map<string, number>();
    for (const failure of summary.thinkingFailures) {
      const kind = `${failure.kind} ${failure.detail.startsWith('redacted') ? 'redacted_thinking' : 'thinking'}`;
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    for (const [kind, count] of byKind) details.push(`- Thinking: ${count} blocks ${kind}`);
    for (const failure of summary.thinkingFailures.slice(0, 5)) {
      details.push(
        `  - ${failure.detail}: ${failure.kind} at request ${failure.request} (turn ${failure.turn})`,
      );
    }
    for (const failure of summary.breakpointFailures) {
      details.push(
        `- Breakpoint: request ${failure.request} (turn ${failure.turn}) ${failure.kind}: ${failure.detail}`,
      );
    }
    details.push('');
  }
  return [...lines, '', ...details].join('\n');
}
