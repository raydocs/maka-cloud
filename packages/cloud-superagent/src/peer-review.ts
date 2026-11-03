import type { Usage } from './types.js';

export const DEFAULT_PEER_REVIEW_ROUNDS = 3;

export type PeerReviewSeverity = 'block' | 'advise' | 'clear';
export type PeerReviewSkip = 'disabled' | 'no_client' | 'no_model' | 'same_model';

/** Forced capabilities for the isolated reviewer. Write / network / secrets stay false. */
export const REVIEW_CAPABILITIES = {
  readDiff: true,
  readRepo: true,
  write: false,
  network: false,
  secrets: false,
} as const;

export type ReviewCapabilities = typeof REVIEW_CAPABILITIES;

const SECRET_ENV_RE =
  /(^|_)(API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|AUTHORIZATION|CREDENTIAL|GITHUB_TOKEN|ANTHROPIC)(_|$)/i;

const STYLE_ONLY_RE =
  /\b(style|styling|naming|rename|whitespace|indent(?:ation)?|prettier|eslint|biome|lint|format(?:ting)?|comment|nit|nits|prefer|changelog|typo in comment|spacing)\b/i;
const SUBSTANTIVE_RE =
  /\b(correct(?:ness)?|incorrect|wrong|bug|crash|fail(?:ure)?|security|secret|token leak|auth(?:n|z)?|inject(?:ion)?|xss|data loss|delet(?:e|ion)|truncat(?:e|ion)|overwrit(?:e|es)|regress(?:ion)?|break(?:s|ing)? existing|race|null deref|undefined|off-by-one|sql|path traversal)\b/i;

export interface ReviewIsolation {
  env: Record<string, string>;
  capabilities: ReviewCapabilities;
}

export interface PeerReviewClient {
  readonly model: string;
  complete(
    prompt: string,
    isolation?: ReviewIsolation,
  ): Promise<{ text: string; usage?: Partial<Usage> }>;
}

/** Test double. Production hosts pass a real client. Never calls an API. */
export class FakePeerReviewClient implements PeerReviewClient {
  readonly calls: string[] = [];
  readonly isolations: ReviewIsolation[] = [];
  lastEnv: Record<string, string> = {};
  lastCapabilities: ReviewCapabilities | undefined;
  text = 'SEVERITY: clear\nFINDING: none\n';
  usage: Partial<Usage> = {
    tokens: 20,
    usdMicros: 50,
    wallMs: 8,
    inputTokens: 12,
    outputTokens: 8,
  };

  constructor(readonly model = 'fake-reviewer') {}

  async complete(
    prompt: string,
    isolation?: ReviewIsolation,
  ): Promise<{ text: string; usage?: Partial<Usage> }> {
    this.calls.push(prompt);
    if (isolation) {
      this.isolations.push({
        env: { ...isolation.env },
        capabilities: isolation.capabilities,
      });
      this.lastEnv = { ...isolation.env };
      this.lastCapabilities = isolation.capabilities;
    }
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
  /**
   * Env bag the isolated reviewer may see. Host passes this; Superagent never
   * copies `process.env`. Secret-shaped keys are stripped before the client.
   */
  reviewEnv?: Record<string, string | undefined>;
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
    reviewEnv?: Record<string, string | undefined>;
  } = {},
): PeerReviewSettings {
  const maxRounds = input.maxRounds ?? DEFAULT_PEER_REVIEW_ROUNDS;
  return {
    enabled: input.enabled === true,
    model: input.model ?? input.client?.model ?? '',
    workerModel: input.workerModel,
    maxRounds: maxRounds > 0 ? maxRounds : DEFAULT_PEER_REVIEW_ROUNDS,
    client: input.client,
    reviewEnv: input.reviewEnv,
  };
}

export const DEFAULT_PEER_REVIEW: PeerReviewSettings = peerReviewSettingsFrom();

export interface PeerReviewInput {
  diff: string;
  repo?: string;
  workerId?: string;
}

export interface PeerReviewStats {
  wallMs: number;
  tokens: number;
  /** Review tokens / worker tokens after the charge, 0..1. */
  tokenShare: number;
  issuesReported: number;
  issuesFixed: number;
  openFindings: string[];
}

export interface PeerReviewOutcome {
  allowed: boolean;
  severity: PeerReviewSeverity;
  findings: string[];
  discardedStyle: string[];
  correct?: string;
  feedback: string;
  waiting: boolean;
  rounds: number;
  usage?: Partial<Usage>;
  isolation: ReviewIsolation;
  stats?: Pick<PeerReviewStats, 'wallMs' | 'tokens' | 'issuesReported'>;
  skipped?: PeerReviewSkip;
}

export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_RE.test(name);
}

/** Drop secret-shaped keys. Never pass `process.env` through unchanged. */
export function sealReviewEnv(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue;
    if (isSecretEnvName(key)) continue;
    out[key] = value;
  }
  return out;
}

export function assertReviewIsolation(isolation: ReviewIsolation): void {
  const caps = isolation.capabilities;
  if (caps.write) throw new Error('peer review cannot write');
  if (caps.network) throw new Error('peer review cannot use the network');
  if (caps.secrets) throw new Error('peer review cannot receive secrets');
  if (!caps.readDiff || !caps.readRepo) {
    throw new Error('peer review must be able to read the diff and repo');
  }
  const leaked = Object.keys(isolation.env).filter((key) => isSecretEnvName(key));
  if (leaked.length > 0) {
    throw new Error(`peer review cannot receive secret env: ${leaked.join(', ')}`);
  }
}

export function isolateReview(env: Record<string, string | undefined> = {}): ReviewIsolation {
  const isolation: ReviewIsolation = {
    env: sealReviewEnv(env),
    capabilities: Object.freeze({ ...REVIEW_CAPABILITIES }),
  };
  assertReviewIsolation(isolation);
  return isolation;
}

export function isStyleOnlyFinding(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (SUBSTANTIVE_RE.test(trimmed)) return false;
  return STYLE_ONLY_RE.test(trimmed) || /^(nit|nits|style|naming)\b/i.test(trimmed);
}

export function retainSubstantiveFindings(findings: readonly string[]): {
  kept: string[];
  discarded: string[];
} {
  const kept: string[] = [];
  const discarded: string[] = [];
  for (const row of findings) {
    if (isStyleOnlyFinding(row)) discarded.push(row);
    else kept.push(row);
  }
  return { kept, discarded };
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
    'You run in an isolated read-only environment: you may read the diff and repo only.',
    'You cannot write, cannot use the network, and you have no secrets or tokens.',
    `Reviewer model: ${input.reviewerModel}`,
    input.workerModel ? `Worker model: ${input.workerModel}` : '',
    input.repo ? `Repo: ${input.repo}` : '',
    'Report only problems that would actually break production: correctness, security, data loss, or regressions.',
    'Do not report style, naming, formatting, comments, or nits.',
    'Reply with SEVERITY: block|advise|clear, FINDING: lines, and optional CORRECT: line.',
    'block = must fix before push. advise = optional substantive issue. clear = no findings.',
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
  const isolation = isolateReview(input.settings.reviewEnv ?? {});
  if (!input.settings.enabled) {
    return skipped('disabled', rounds, isolation);
  }
  if (!input.settings.client) return skipped('no_client', rounds, isolation);
  const reviewerModel = input.settings.model || input.settings.client.model;
  if (!reviewerModel.trim()) return skipped('no_model', rounds, isolation);
  if (sameReviewModel(input.settings.workerModel, reviewerModel)) {
    return skipped('same_model', rounds, isolation);
  }
  const started = Date.now();
  const { text, usage } = await input.settings.client.complete(
    peerReviewPrompt({
      diff: input.diff,
      repo: input.repo,
      workerModel: input.settings.workerModel,
      reviewerModel,
    }),
    isolation,
  );
  const parsed = parsePeerReview(text);
  const { kept, discarded } = retainSubstantiveFindings(parsed.findings);
  const severity =
    kept.length === 0 && (parsed.severity === 'block' || parsed.severity === 'advise')
      ? 'clear'
      : parsed.severity;
  const nextRounds = severity === 'block' ? rounds + 1 : rounds;
  const waiting = severity === 'block' && nextRounds > input.settings.maxRounds;
  const wallMs = usage?.wallMs ?? Date.now() - started;
  const tokens = usage?.tokens ?? 0;
  const feedback = formatPeerReviewFeedback({ ...parsed, severity, findings: kept }, text);
  return {
    allowed: severity !== 'block',
    severity,
    findings: kept,
    discardedStyle: discarded,
    correct: parsed.correct,
    feedback,
    waiting,
    rounds: nextRounds,
    usage: usage ? { ...usage, wallMs } : { wallMs, tokens },
    isolation,
    stats: { wallMs, tokens, issuesReported: kept.length },
  };
}

export function mergePeerReviewStats(
  previous: PeerReviewStats | undefined,
  outcome: PeerReviewOutcome,
  workerTokensAfterCharge: number,
): PeerReviewStats {
  const prev = previous ?? {
    wallMs: 0,
    tokens: 0,
    tokenShare: 0,
    issuesReported: 0,
    issuesFixed: 0,
    openFindings: [],
  };
  const open = outcome.skipped ? prev.openFindings : outcome.findings;
  const fixed = outcome.skipped ? 0 : prev.openFindings.filter((row) => !open.includes(row)).length;
  const tokens = prev.tokens + (outcome.stats?.tokens ?? outcome.usage?.tokens ?? 0);
  const wallMs = prev.wallMs + (outcome.stats?.wallMs ?? outcome.usage?.wallMs ?? 0);
  const reported = prev.issuesReported + (outcome.skipped ? 0 : outcome.findings.length);
  return {
    wallMs,
    tokens,
    tokenShare: workerTokensAfterCharge > 0 ? tokens / workerTokensAfterCharge : 0,
    issuesReported: reported,
    issuesFixed: prev.issuesFixed + fixed,
    openFindings: [...open],
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

function skipped(
  reason: PeerReviewSkip,
  rounds: number,
  isolation: ReviewIsolation,
): PeerReviewOutcome {
  return {
    allowed: true,
    severity: 'clear',
    findings: [],
    discardedStyle: [],
    feedback: '',
    waiting: false,
    rounds,
    skipped: reason,
    isolation,
  };
}

function asSeverity(value: unknown): PeerReviewSeverity | undefined {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'block' || text === 'advise' || text === 'clear') return text;
  return undefined;
}
