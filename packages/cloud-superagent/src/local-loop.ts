import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IngestInput } from './events.js';
import { sequentialIds } from './ids.js';
import { createJudgeFromEnv } from './judge-client.js';
import { HeuristicJudge } from './router.js';
import { mergeBoundText } from './loop.js';
import { FakeReviewer } from './review.js';
import { Superagent, type IngestResult } from './runtime.js';
import { actMandate } from './types.js';
import { createSandboxFromEnv, FakeSandbox, HttpSandbox, type SandboxPort } from './sandbox.js';
import { EnvOrgSecrets } from './secrets.js';
import { SqliteSuperagentStore } from './sqlite-store.js';
import { formatEvidence } from './evidence.js';
import type {
  HandlerResult,
  NormalizedEvent,
  RouterDecision,
  RouterJudge,
  TenantUsage,
  WorkerContext,
  WorkerHandler,
  WorkerRecord,
  WorkerState,
} from './types.js';

/** Heuristic spawn, but a PR starts at `act` so the loop can hold a merge. */
export class LocalLoopJudge implements RouterJudge {
  private readonly inner = new HeuristicJudge();

  async decide(event: NormalizedEvent, ctx: { workers: WorkerRecord[] }): Promise<RouterDecision> {
    const decision = await this.inner.decide(event, ctx);
    if (decision.action === 'spawn' && event.type === 'pr_opened') {
      return { ...decision, mandate: actMandate(decision.mandate.scope.repos, 'inferred') };
    }
    return decision;
  }
}

export const LOCAL_LOOP_TENANT = 'inv_local';
export const LOCAL_LOOP_REPO = 'acme/app';
export const MERGE_BOUND_TEXT = mergeBoundText(LOCAL_LOOP_REPO, 12, 'abc123def456');

export interface LocalLoopReport {
  sandboxKind: 'fake' | 'instabox';
  tenantId: string;
  workerId: string;
  steps: string[];
  states: WorkerState[];
  judgeCallsOnSpawn: number;
  judgeCallsAfterComment: number;
  passthroughComment: boolean;
  passthroughCi: boolean;
  approvalId: string | null;
  approvalBoundText: string | null;
  approved: boolean;
  watchdogRules: string[];
  ledger: TenantUsage;
  evidence: string;
  auditKinds: string[];
  resumed: boolean;
  sandboxCommands: string[];
}

export interface LocalLoopOptions {
  env?: NodeJS.ProcessEnv;
  sandbox?: SandboxPort;
  dir?: string;
  tenantId?: string;
  keepDir?: boolean;
}

/**
 * Demo handler for the local loop. A PR worker execs on the sandbox, sleeps,
 * resumes on a comment, holds merge for approval, and a second "spin" issue
 * trips the watchdog.
 */
export class LocalLoopHandler implements WorkerHandler {
  constructor(private readonly sandbox: SandboxPort) {}

  async handle(ctx: WorkerContext, event: NormalizedEvent): Promise<HandlerResult> {
    if (event.subject?.kind === 'issue' && event.subject.number === 99) {
      return { stepSignature: 'spin-login.ts', progress: false, plan: 'spin on login.ts' };
    }
    const box = ctx.worker.sandboxRef ?? 'local-loop';
    if (event.type === 'pr_opened') {
      await this.sandbox.ensureRunning(box);
      const ran = await this.sandbox.exec(box, { cmd: 'echo spawn' });
      return {
        progress: true,
        memory: `opened ${event.subject?.key ?? ''} stdout=${ran.stdout}`,
        plan: 'inspect the pull request',
        usage: { tokens: 20, usdMicros: 100, wallMs: 8 },
        evidence: [
          { kind: 'step', label: 'spawned on sandbox', body: ran.stdout, path: 'echo spawn' },
        ],
      };
    }
    if (event.type === 'issue_comment') {
      const ran = await this.sandbox.exec(box, { cmd: 'echo comment' });
      return {
        progress: true,
        memory: `${ctx.recall()}\ncomment stdout=${ran.stdout}`,
        plan: 'address the comment',
        usage: { tokens: 8, usdMicros: 40, wallMs: 4 },
        evidence: [{ kind: 'log', label: 'comment received', body: ran.stdout }],
      };
    }
    if (event.type === 'ci_failed') {
      return {
        progress: true,
        plan: 'CI failed; merge needs approval',
        evidence: [{ kind: 'test', label: 'ci failed', body: 'workflow ci' }],
        action: { kind: 'merge', boundText: MERGE_BOUND_TEXT },
      };
    }
    if (event.type === 'approval_granted') {
      const ran = await this.sandbox.exec(box, { cmd: 'echo approved' });
      return {
        progress: true,
        plan: 'merge approved',
        usage: { tokens: 5, usdMicros: 20, wallMs: 2 },
        evidence: [{ kind: 'step', label: 'approval granted', body: ran.stdout }],
      };
    }
    return { progress: true };
  }
}

export async function runLocalLoop(options: LocalLoopOptions = {}): Promise<LocalLoopReport> {
  const env = options.env ?? process.env;
  const sandbox = options.sandbox ?? createSandboxFromEnv(env);
  const sandboxKind = sandbox instanceof HttpSandbox ? 'instabox' : 'fake';
  const machineId = env.INSTABOX_MACHINE_ID?.trim() || 'local-loop';
  const tenantId = options.tenantId ?? LOCAL_LOOP_TENANT;
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'superagent-loop-')));
  const dbPath = join(dir, 'superagent.db');
  let now = 1_700_000_000_000;
  const clock = () => now;
  const handler = new LocalLoopHandler(sandbox);
  const steps: string[] = [];
  const states: WorkerState[] = [];

  const openAgent = (store: SqliteSuperagentStore, idsFrom = 1) =>
    new Superagent({
      store,
      handler,
      sandbox,
      sandboxRef: machineId,
      judge: new LocalLoopJudge(),
      reviewer: new FakeReviewer(),
      orgSecrets: new EnvOrgSecrets({ env }),
      clock,
      ids: sequentialIds(idsFrom),
      admission: { allowActors: ['alice', 'bob'] },
      watchdog: { stallAfterMs: 1_000, heartbeatAfterMs: 60_000, loopRepeat: 3 },
    });

  const store1 = SqliteSuperagentStore.open(dbPath);
  const agent1 = openAgent(store1);
  const opened = await agent1.ingest(
    github(tenantId, 'd-open', 'pull_request', prPayload('opened')),
  );
  if (opened.result !== 'spawned') {
    store1.close();
    throw new Error(`expected spawn, got ${opened.result}`);
  }
  const workerId = opened.workerId;
  steps.push('spawn');
  pushState(states, agent1, tenantId, workerId);
  const judgeCallsOnSpawn = opened.judgeCalls;
  store1.close();

  const store2 = SqliteSuperagentStore.open(dbPath);
  const agent2 = openAgent(store2, 200);
  const restored = await agent2.restore();
  const sleepingAfterRestore = agent2.worker(tenantId, workerId)?.state === 'sleeping';
  steps.push('resume-store');
  const comment = await agent2.ingest(
    github(tenantId, 'd-comment', 'issue_comment', commentPayload(12, 'please add a test')),
  );
  steps.push('passthrough-comment');
  pushState(states, agent2, tenantId, workerId);
  const judgeCallsAfterComment = agent2.judgeCalls;

  const ci = await agent2.ingest(
    github(tenantId, 'd-ci', 'workflow_run', workflowPayload('failure', 12)),
  );
  steps.push('passthrough-ci');
  pushState(states, agent2, tenantId, workerId);

  const pending = agent2.store.pendingApprovals(tenantId, workerId)[0];
  if (pending) steps.push('approval-request');
  let approved = false;
  if (pending) {
    const decision = await agent2.approve(tenantId, pending.approvalId, pending.boundText);
    approved = decision.ok;
    if (decision.ok) steps.push('approved');
  }
  pushState(states, agent2, tenantId, workerId);

  const spin = await agent2.ingest(
    github(tenantId, 'd-spin', 'issues', issuePayload('opened', 99, 'spin')),
  );
  if (spin.result === 'spawned') {
    await agent2.ingest(
      github(tenantId, 'd-spin-1', 'issue_comment', commentPayload(99, 'one', false, 1)),
    );
    await agent2.ingest(
      github(tenantId, 'd-spin-2', 'issue_comment', commentPayload(99, 'two', false, 2)),
    );
    now += 2_000;
    const findings = await agent2.tick();
    const watchdogRules = findings.map((row) => row.rule);
    if (watchdogRules.length > 0) steps.push(`watchdog:${watchdogRules.join(',')}`);

    const worker = agent2.worker(tenantId, workerId);
    const report: LocalLoopReport = {
      sandboxKind,
      tenantId,
      workerId,
      steps,
      states,
      judgeCallsOnSpawn,
      judgeCallsAfterComment,
      passthroughComment: comment.result === 'passthrough',
      passthroughCi: ci.result === 'passthrough',
      approvalId: pending?.approvalId ?? null,
      approvalBoundText: pending?.boundText ?? null,
      approved,
      watchdogRules,
      ledger: agent2.ledger(tenantId),
      evidence: formatEvidence(worker?.evidence ?? []),
      auditKinds: agent2.store.audit(tenantId).map((row) => row.kind),
      resumed: sleepingAfterRestore || restored.resumed > 0,
      sandboxCommands: sandbox instanceof FakeSandbox ? sandbox.commands.map((row) => row.cmd) : [],
    };
    agent2.close();
    if (!options.keepDir && !options.dir) await rm(dir, { recursive: true, force: true });
    return report;
  }

  agent2.close();
  throw new Error(`expected spin spawn, got ${spin.result}`);
}

export function formatLocalLoopReport(report: LocalLoopReport): string {
  const lines = [
    `sandbox: ${report.sandboxKind}`,
    `tenant: ${report.tenantId}`,
    `worker: ${report.workerId}`,
    `steps: ${report.steps.join(' → ')}`,
    `states: ${report.states.join(' → ')}`,
    `router calls after spawn: ${report.judgeCallsOnSpawn} (comment/CI must stay 0 more: ${report.judgeCallsAfterComment})`,
    `subscription: comment=${report.passthroughComment ? 'passthrough' : 'miss'} ci=${report.passthroughCi ? 'passthrough' : 'miss'}`,
    `approval: ${report.approvalBoundText ?? '(none)'} ${report.approved ? 'granted' : 'held'}`,
    `watchdog: ${report.watchdogRules.join(', ') || '(none)'}`,
    `ledger: tokens=${report.ledger.tokens} usd_micros=${report.ledger.usdMicros} events=${report.ledger.events}`,
    report.evidence || 'evidence: (none)',
    `audit: ${report.auditKinds.join(', ')}`,
    report.sandboxCommands.length > 0
      ? `sandbox exec: ${report.sandboxCommands.join(', ')}`
      : 'sandbox exec: (live Instabox or none recorded)',
  ];
  return lines.join('\n');
}

export async function runLocalLoopCli(argv: string[]): Promise<number> {
  const listen = flag(argv, '--listen');
  if (listen !== undefined) {
    const port = listen === '' || listen === 'true' ? 8787 : Number(listen);
    if (!Number.isInteger(port) || port <= 0) {
      console.error('usage: local-loop --listen [port]');
      return 2;
    }
    return listenLoop(port, process.env);
  }
  const report = await runLocalLoop();
  console.log(formatLocalLoopReport(report));
  return 0;
}

export async function listenLoop(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const tenantId = env.MAKA_CLOUD_SUPERAGENT_TENANT?.trim() || LOCAL_LOOP_TENANT;
  const sandbox = createSandboxFromEnv(env);
  const machineId = env.INSTABOX_MACHINE_ID?.trim() || 'local-loop';
  const dir = await mkdtemp(join(tmpdir(), 'superagent-listen-'));
  const store = SqliteSuperagentStore.open(join(dir, 'superagent.db'));
  const agent = new Superagent({
    store,
    handler: new LocalLoopHandler(sandbox),
    sandbox,
    sandboxRef: machineId,
    judge: createJudgeFromEnv(env),
    reviewer: new FakeReviewer(),
    orgSecrets: new EnvOrgSecrets({ env }),
    admission: {
      allowActors: parseList(env.MAKA_CLOUD_SUPERAGENT_ACTORS) ?? ['alice', 'bob'],
    },
  });
  const secret = env.MAKA_GITHUB_WEBHOOK_SECRET?.trim();
  const server = createServer((req, res) => {
    void handleWebhook(req, res, agent, tenantId, secret);
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const kind = sandbox instanceof HttpSandbox ? 'instabox' : 'fake';
  console.log(`listening on http://127.0.0.1:${port}/github/webhook`);
  console.log(
    `sandbox=${kind} tenant=${tenantId} secret=${secret ? 'required' : 'unsigned-local'}`,
  );
  console.log('POST a GitHub delivery (pull_request, issue_comment, workflow_run). Ctrl-C stops.');
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.close(() => {
        agent.close();
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await rm(dir, { recursive: true, force: true });
  return 0;
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  agent: Superagent,
  tenantId: string,
  secret: string | undefined,
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/github/webhook') {
    res.writeHead(404).end('not found');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  if (secret) {
    const header = headerOf(req, 'x-hub-signature-256');
    if (!verifySignature(secret, body, header)) {
      res.writeHead(401).end('bad signature');
      return;
    }
  }
  const event = headerOf(req, 'x-github-event');
  const deliveryId = headerOf(req, 'x-github-delivery') ?? `local-${Date.now()}`;
  if (!event) {
    res.writeHead(400).end('missing x-github-event');
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400).end('invalid json');
    return;
  }
  const input: IngestInput = {
    source: 'github',
    tenantId,
    deliveryId,
    event,
    payload,
  };
  try {
    const result: IngestResult = await agent.ingest(input);
    console.log(JSON.stringify({ deliveryId, event, result }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500).end(error instanceof Error ? error.message : 'ingest failed');
  }
}

function verifySignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  const match = header === undefined ? null : /^sha256=([0-9a-f]{64})$/u.exec(header);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(match[1] as string, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  if (next && !next.startsWith('--')) return next;
  return '';
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function pushState(
  states: WorkerState[],
  agent: Superagent,
  tenantId: string,
  workerId: string,
): void {
  const state = agent.worker(tenantId, workerId)?.state;
  if (state) states.push(state);
}

function prPayload(action: string, number = 12): unknown {
  return {
    action,
    pull_request: {
      number,
      title: `PR ${number}`,
      user: { login: 'alice', type: 'User' },
      head: { ref: 'maka/pr-12' },
    },
    repository: { full_name: LOCAL_LOOP_REPO },
    sender: { login: 'alice', type: 'User' },
  };
}

function issuePayload(action: string, number: number, body: string): unknown {
  return {
    action,
    issue: {
      number,
      title: `Issue ${number}`,
      body,
      user: { login: 'alice', type: 'User' },
    },
    repository: { full_name: LOCAL_LOOP_REPO },
    sender: { login: 'alice', type: 'User' },
  };
}

function commentPayload(number: number, body: string, onPr = true, commentId = 90): unknown {
  return {
    action: 'created',
    issue: {
      number,
      title: `Item ${number}`,
      ...(onPr ? { pull_request: {} } : {}),
    },
    comment: { id: commentId, body },
    repository: { full_name: LOCAL_LOOP_REPO },
    sender: { login: 'bob', type: 'User' },
  };
}

function workflowPayload(conclusion: 'success' | 'failure', pr?: number): unknown {
  return {
    action: 'completed',
    workflow_run: {
      id: 77,
      name: 'ci',
      head_sha: 'abc123def456',
      conclusion,
      head_branch: 'maka/pr-12',
      ...(pr === undefined ? {} : { pull_requests: [{ number: pr }] }),
    },
    repository: { full_name: LOCAL_LOOP_REPO },
    sender: { login: 'github-actions[bot]', type: 'Bot' },
  };
}

function github(
  tenantId: string,
  deliveryId: string,
  event: string,
  payload: unknown,
): IngestInput {
  return { source: 'github', tenantId, deliveryId, event, payload };
}

export const localLoopFixtures = {
  prPayload,
  issuePayload,
  commentPayload,
  workflowPayload,
  github,
};
