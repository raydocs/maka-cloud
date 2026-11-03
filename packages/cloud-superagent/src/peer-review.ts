import type { Usage } from './types.js';

export const DEFAULT_PEER_REVIEW_ROUNDS = 2;

export type PeerReviewSeverity = 'block' | 'advise' | 'clear';
export type PeerReviewSkip = 'disabled' | 'no_client' | 'no_model' | 'same_model';

export interface PeerReviewClient {
  readonly model: string;
  complete(prompt: string): Promise<{ text: string; usage?: Partial<Usage> }>;
}

/** Test double. Production hosts pass a real client. Never calls an API. */
export class FakePeerReviewClient implements PeerReviewClient {
  readonly calls: string[] = [];
  text = 'SEVERITY: clear\nFINDING: none\n';
  usage: Partial<Usage> = {
    tokens: 20,
    usdMicros: 50,
    wallMs: 8,
    inputTokens: 12,
    outputTokens: 8,
  };

  constructor(readonly model = 'fake-reviewer') {}

  async complete(prompt: string): Promise<{ text: string; usage?: Partial<Usage> }> {
    this.calls.push(prompt);
    return { text: this.text, usage: { ...this.usage } };
  }
}

export interface PeerReviewSettings {
  enabled: boolean;
  /** Reviewer model id. Must differ from `workerModel` when both are set. */
  model: string;
  workerModel?: string;
  maxRounds: number;
  client?: PeerReviewClient;
}

/**
 * Host-facing constructor helper. Does not read `process.env`.
 * `enabled` is true only when the host passes `true`.
 */
export function peerReviewSettingsFrom(
  input: {
    enabled?: boolean;
    model?: string;
    workerModel?: string;
    maxRounds?: number;
    client?: PeerReviewClient;
  } = {},
): PeerReviewSettings {
  const maxRounds = input.maxRounds ?? DEFAULT_PEER_REVIEW_ROUNDS;
  return {
    enabled: input.enabled === true,
    model: input.model ?? input.client?.model ?? '',
    workerModel: input.workerModel,
    maxRounds: maxRounds > 0 ? maxRounds : DEFAULT_PEER_REVIEW_ROUNDS,
    client: input.client,
  };
}

export const DEFAULT_PEER_REVIEW: PeerReviewSettings = peerReviewSettingsFrom();

export interface PeerReviewInput {
  diff: string;
  repo?: string;
  workerId?: string;
}

export interface PeerReviewOutcome {
  allowed: boolean;
  severity: PeerReviewSeverity;
  findings: string[];
  correct?: string;
  feedback: string;
  waiting: boolean;
  rounds: number;
  usage?: Partial<Usage>;
  skipped?: PeerReviewSkip;
}

export function sameReviewModel(worker?: string, reviewer?: string): boolean {
  const left = worker?.trim() ?? '';
  const right = reviewer?.trim() ?? '';
  if (!left || !right) return false;
  return left === right;
}

export function parsePeerReview(text: string): {
  severity: PeerReviewSeverity;
  findings: string[];
  correct?: string;
} {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        severity?: unknown;
        findings?: unknown;
        correct?: unknown;
      };
      const severity = asSeverity(parsed.severity);
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.filter(
            (row): row is string => typeof row === 'string' && row.trim() !== '',
          )
        : [];
      const correct = typeof parsed.correct === 'string' ? parsed.correct : undefined;
      return { severity: severity ?? 'clear', findings, correct };
    } catch {
      // Fall through to the line parser.
    }
  }
  const severities = [...trimmed.matchAll(/^SEVERITY:\s*(block|advise|clear)\b/gim)];
  const last = severities.at(-1)?.[1]?.toLowerCase();
  const findings = [...trimmed.matchAll(/^FINDING:\s*(.+)$/gim)]
    .map((row) => row[1]?.trim() ?? '')
    .filter((row) => row && row.toLowerCase() !== 'none');
  const correct = [...trimmed.matchAll(/^CORRECT:\s*(.+)$/gim)].at(-1)?.[1]?.trim();
  return {
    severity: asSeverity(last) ?? 'clear',
    findings,
    correct: correct || undefined,
  };
}

export function peerReviewPrompt(input: {
  diff: string;
  repo?: string;
  workerModel?: string;
  reviewerModel: string;
}): string {
  return [
    'Review this diff before the worker pushes or opens a pull request.',
    `Reviewer model: ${input.reviewerModel}`,
    input.workerModel ? `Worker model: ${input.workerModel}` : '',
    input.repo ? `Repo: ${input.repo}` : '',
    'Reply with SEVERITY: block|advise|clear, FINDING: lines, and optional CORRECT: line.',
    'block = must fix before push. advise = optional. clear = no findings.',
    '',
    input.diff.slice(0, 20_000),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export async function runPeerReview(input: {
  settings: PeerReviewSettings;
  diff: string;
  repo?: string;
  currentRounds: number;
}): Promise<PeerReviewOutcome> {
  const rounds = input.currentRounds;
  if (!input.settings.enabled) {
    return skipped('disabled', rounds);
  }
  if (!input.settings.client) return skipped('no_client', rounds);
  const reviewerModel = input.settings.model || input.settings.client.model;
  if (!reviewerModel.trim()) return skipped('no_model', rounds);
  if (sameReviewModel(input.settings.workerModel, reviewerModel)) {
    return skipped('same_model', rounds);
  }
  const { text, usage } = await input.settings.client.complete(
    peerReviewPrompt({
      diff: input.diff,
      repo: input.repo,
      workerModel: input.settings.workerModel,
      reviewerModel,
    }),
  );
  const parsed = parsePeerReview(text);
  const nextRounds = parsed.severity === 'block' ? rounds + 1 : rounds;
  const waiting = parsed.severity === 'block' && nextRounds > input.settings.maxRounds;
  const feedback = formatPeerReviewFeedback(parsed, text);
  return {
    allowed: parsed.severity !== 'block',
    severity: parsed.severity,
    findings: parsed.findings,
    correct: parsed.correct,
    feedback,
    waiting,
    rounds: nextRounds,
    usage,
  };
}

export function formatPeerReviewFeedback(
  parsed: { severity: PeerReviewSeverity; findings: string[]; correct?: string },
  raw: string,
): string {
  const findings =
    parsed.findings.length > 0 ? parsed.findings.join('; ') : raw.trim().slice(0, 400);
  const correct = parsed.correct ? ` CORRECT: ${parsed.correct}` : '';
  return `peer-review ${parsed.severity}: ${findings}${correct}`.trim();
}

function skipped(reason: PeerReviewSkip, rounds: number): PeerReviewOutcome {
  return {
    allowed: true,
    severity: 'clear',
    findings: [],
    feedback: '',
    waiting: false,
    rounds,
    skipped: reason,
  };
}

function asSeverity(value: unknown): PeerReviewSeverity | undefined {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'block' || text === 'advise' || text === 'clear') return text;
  return undefined;
}
