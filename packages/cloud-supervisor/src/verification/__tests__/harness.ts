import { createHash } from 'node:crypto';
import type { SignalManifest } from '../../events.js';
import {
  CONVERSATION,
  Clock,
  FakeHost,
  type Rig,
  firstItem,
  rig,
} from '../../__tests__/harness.js';
import type { SupervisorOptions } from '../../supervisor.js';
import type { Settings } from '../../settings.js';
import type { FetchOutcome, SourceFetcher } from '../fetcher.js';
import type {
  ArtifactRead,
  BudgetPort,
  EvidenceSource,
  VerificationOptions,
  Vendor,
  VerifierModel,
  VerifierRequest,
} from '../ports.js';

export { CONVERSATION, Clock, FakeHost, firstItem, rig };
export type { Rig };

type FileEntry = string | { fail: 'not_found' | 'too_large' | 'unavailable' } | { throws: Error };

/** Artifacts by task and file name. Reads are recorded. */
export class FakeEvidence implements EvidenceSource {
  readonly files = new Map<string, FileEntry>();
  readonly reads: string[] = [];
  onRead?: (taskId: string, name: string, signal: AbortSignal) => Promise<void>;

  set(taskId: string, name: string, content: FileEntry): void {
    this.files.set(`${taskId}/${name}`, content);
  }

  async readArtifact(
    task: { taskId: string },
    ref: string,
    signal: AbortSignal,
  ): Promise<ArtifactRead> {
    const name = ref.split('/').pop() as string;
    this.reads.push(`${task.taskId}/${name}`);
    await this.onRead?.(task.taskId, name, signal);
    const entry = this.files.get(`${task.taskId}/${name}`);
    if (entry === undefined) return { ok: false, reason: 'not_found' };
    if (typeof entry === 'string') return { ok: true, text: entry };
    if ('throws' in entry) throw entry.throws;
    return { ok: false, reason: entry.fail };
  }
}

/** A conversation budget: one synchronous reserve, settled to the actual cost. */
export class FakeBudget implements BudgetPort {
  readonly reserved = new Map<string, number>();
  readonly settled = new Map<string, number>();
  readonly settleCalls: Array<[string, number]> = [];
  /** Refuse every reservation, or only when the amount exceeds this. */
  refuse: false | true | { above: number } = false;
  throwOnReserve: Error | undefined;
  throwOnSettle: Error | undefined;
  reserveCalls = 0;
  reserve(request: { key: string; maxUsd: number }): { ok: true } | { ok: false; reason: string } {
    this.reserveCalls += 1;
    if (this.throwOnReserve) throw this.throwOnReserve;
    if (this.refuse === true || (this.refuse && request.maxUsd > this.refuse.above)) {
      return { ok: false, reason: 'budget' };
    }
    this.reserved.set(request.key, request.maxUsd);
    return { ok: true };
  }
  settle(key: string, actualUsd: number): void {
    if (this.throwOnSettle) throw this.throwOnSettle;
    this.settleCalls.push([key, actualUsd]);
    if (this.reserved.has(key)) this.settled.set(key, actualUsd);
  }
  totalSettled(): number {
    return [...this.settled.values()].reduce((sum, usd) => sum + usd, 0);
  }
}

export interface ModelScript {
  (
    request: VerifierRequest,
    signal: AbortSignal,
  ): Promise<{
    output: unknown;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}

/** The verdicts a model would give: one entry per claim id found in the request. */
export function claimIdsOf(request: VerifierRequest): string[] {
  const match = /CLAIMS\n(DATA-[0-9a-f]+)\n(.*)\n\1\nEVIDENCE/su.exec(request.prompt);
  if (!match) throw new Error('no claims block in the request');
  return (JSON.parse(match[2] as string) as Array<{ id: string }>).map((claim) => claim.id);
}

export function allSupported(request: VerifierRequest) {
  return {
    output: {
      verdicts: claimIdsOf(request).map((claimId) => ({
        claimId,
        verdict: 'supported',
        reason: 'ok',
      })),
    },
    usage: { inputTokens: 1000, outputTokens: 100 },
  };
}

export class FakeModel implements VerifierModel {
  readonly requests: VerifierRequest[] = [];
  inflight = 0;
  maxInflight = 0;
  script: ModelScript = async (request) => allSupported(request);
  constructor(
    readonly id: string,
    readonly vendor: Vendor,
    readonly price = { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
    readonly maxInputChars = 60_000,
    readonly maxOutputTokens = 4_000,
  ) {}
  async verify(request: VerifierRequest, signal: AbortSignal) {
    this.requests.push(request);
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      return await this.script(request, signal);
    } finally {
      this.inflight -= 1;
    }
  }
}

export class FakeFetcher implements SourceFetcher {
  readonly pages = new Map<string, FetchOutcome>();
  readonly fetched: string[] = [];
  inflight = 0;
  maxInflight = 0;
  async fetchText(url: string, _signal?: AbortSignal): Promise<FetchOutcome> {
    this.fetched.push(url);
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.inflight -= 1;
    return (
      this.pages.get(url) ?? {
        ok: false,
        reason: 'unreachable',
        detail: 'no such page in the test',
      }
    );
  }
  page(url: string, text: string, contentType = 'text/plain'): void {
    this.pages.set(url, { ok: true, text, finalUrl: url, contentType, bytes: text.length });
  }
}

export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export interface World {
  evidence: FakeEvidence;
  budget: FakeBudget;
  fetcher: FakeFetcher;
  /** One model per vendor, pool order: anthropic, then openai. */
  anthropic: FakeModel;
  openai: FakeModel;
  options: VerificationOptions;
}

export function world(overrides: Partial<VerificationOptions> = {}): World {
  const evidence = new FakeEvidence();
  const budget = new FakeBudget();
  const fetcher = new FakeFetcher();
  const anthropic = new FakeModel('verifier-a', 'anthropic');
  const openai = new FakeModel('verifier-o', 'openai');
  return {
    evidence,
    budget,
    fetcher,
    anthropic,
    openai,
    options: { evidence, fetcher, budget, models: [anthropic, openai], ...overrides },
  };
}

export async function verifyRig(
  w: World,
  options: Partial<SupervisorOptions> & {
    settings?: Partial<Settings>;
    clock?: Clock;
    host?: FakeHost;
  } = {},
): Promise<Rig> {
  return rig({ ...options, verification: w.options });
}

export const CODING_ARTIFACTS = ['out/change.patch', 'out/changes.json', 'out/verification.json'];

/** The three files a coding run delivers, consistent with each other. */
export function codingFiles(
  w: World,
  taskId: string,
  options: {
    result?: 'verified' | 'failed';
    files?: Array<{ path: string; content: string }>;
    patch?: string;
  } = {},
): void {
  const files = options.files ?? [{ path: 'src/a.ts', content: 'export const a = 1;\n' }];
  w.evidence.set(
    taskId,
    'changes.json',
    JSON.stringify({
      repo: 'acme/app',
      baseSha: 'abc',
      files: files.map((file) => ({
        path: file.path,
        status: 'added',
        mode: '100644',
        blobSha: gitBlobSha(file.content),
        contentBase64: Buffer.from(file.content).toString('base64'),
      })),
    }),
  );
  w.evidence.set(
    taskId,
    'verification.json',
    JSON.stringify({
      repo: 'acme/app',
      result: options.result ?? 'verified',
      testCommand: 'npm test',
    }),
  );
  w.evidence.set(
    taskId,
    'change.patch',
    options.patch ?? '--- /dev/null\n+++ b/src/a.ts\n+export const a = 1;\n',
  );
}

export function manifestOf(overrides: Partial<SignalManifest> = {}): SignalManifest {
  return {
    summary: 'Added the constant a.',
    done: ['added src/a.ts', 'tests pass'],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
    artifacts: CODING_ARTIFACTS,
    ...overrides,
  };
}

/** A top-level task that ends successfully with `manifest`; lets the supervisor settle. */
export async function finishTask(
  r: Rig,
  taskId: string,
  manifest: SignalManifest = manifestOf(),
  options: { runner?: string; title?: string; conversation?: string } = {},
): Promise<void> {
  await r.taskCreated(taskId, {
    title: options.title ?? 'Add the constant',
    runner: options.runner ?? 'claude-agent-sdk',
    ...(options.conversation ? { conversation: options.conversation } : {}),
  });
  await r.taskEvent({ type: 'task_started', taskId }, options.conversation);
  await r.taskEvent({ type: 'task_succeeded', taskId, manifest }, options.conversation);
}

export function itemsOf(r: Rig, kind?: string) {
  return r.supervisor
    .listItems({ state: 'all' })
    .items.filter((item) => kind === undefined || item.kind === kind);
}

export const RESEARCH_ARTIFACTS = [
  'out/report.md',
  'out/report.html',
  'out/report.json',
  'out/verification.json',
];

export interface ReportClaim {
  id: string;
  text: string;
  citations: Array<{ sourceId: string; quote: string }>;
}

export const TUNNEL_QUOTE = 'The tunnel opened in 1994 and is about 50 km long.';

export function defaultClaims(): ReportClaim[] {
  return [
    {
      id: 'c1',
      text: 'The tunnel opened in 1994.',
      citations: [{ sourceId: 's1', quote: TUNNEL_QUOTE }],
    },
    {
      id: 'c2',
      text: 'Traffic is mostly freight.',
      citations: [
        {
          sourceId: 's2',
          quote: 'Most of the traffic through the link is freight rather than passengers.',
        },
      ],
    },
  ];
}

/** report.json, the exported cite-check record and the cited pages, consistent with each other. */
export function researchFiles(
  w: World,
  taskId: string,
  options: { claims?: ReportClaim[]; removed?: string[]; pages?: Record<string, string> } = {},
): ReportClaim[] {
  const claims = options.claims ?? defaultClaims();
  const sourceIds = [...new Set(claims.flatMap((claim) => claim.citations.map((c) => c.sourceId)))];
  w.evidence.set(
    taskId,
    'report.json',
    JSON.stringify({
      title: 'The link',
      sections: [{ heading: 'Facts', claims }],
      sources: sourceIds.map((id) => ({ id, url: `https://example.com/${id}` })),
    }),
  );
  w.evidence.set(
    taskId,
    'verification.json',
    JSON.stringify({
      version: 1,
      claims: claims.map((claim) => ({
        id: claim.id,
        status: 'quote_verified',
        removed: options.removed?.includes(claim.id) ?? false,
      })),
    }),
  );
  const pages = options.pages ?? {
    s1: `<html><body><p>${TUNNEL_QUOTE}</p></body></html>`,
    s2: 'Most of the traffic through the link is freight rather than passengers. More text.',
  };
  for (const [id, text] of Object.entries(pages)) {
    w.fetcher.page(
      `https://example.com/${id}`,
      text,
      text.startsWith('<') ? 'text/html' : 'text/plain',
    );
  }
  return claims;
}

export function researchManifest(overrides: Partial<SignalManifest> = {}): SignalManifest {
  return manifestOf({
    summary: 'Researched the link.',
    done: ['wrote the report'],
    artifacts: RESEARCH_ARTIFACTS,
    ...overrides,
  });
}

/** Appends a top-level task's events without waiting for the supervisor, for tests that hold a check open. */
export function finishLater(
  r: Rig,
  taskId: string,
  manifest: SignalManifest = manifestOf(),
  options: { runner?: string; title?: string } = {},
): void {
  const at = r.clock.t;
  const feed = r.host.feed;
  const event = (e: Record<string, unknown>) =>
    feed.append('task.event', CONVERSATION, { seq: feed.entries.length + 1, at, event: e }, at);
  event({
    type: 'task_created',
    taskId,
    sessionId: 'ses_1',
    runner: options.runner ?? 'claude-agent-sdk',
    mode: 'async',
    title: options.title ?? 'Add the constant',
  });
  event({ type: 'task_started', taskId });
  event({ type: 'task_succeeded', taskId, manifest });
}

/** Holds each caller until `count` have arrived, then releases them together. */
export class Barrier {
  private arrived = 0;
  private readonly gate: Promise<void>;
  private open!: () => void;
  constructor(private readonly count: number) {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }
  async wait(): Promise<void> {
    this.arrived += 1;
    if (this.arrived >= this.count) this.open();
    await this.gate;
  }
}
