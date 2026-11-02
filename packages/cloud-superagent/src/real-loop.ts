import { rm } from 'node:fs/promises';
import type { IngestInput } from './events.js';
import { sequentialIds } from './ids.js';
import {
  CodingLoopHandler,
  FakeCoder,
  FakeGitHost,
  NodeFileTestPort,
  mergeAction,
  scratchFiles,
  workerBranch,
} from './loop.js';
import { createJudgeFromEnv } from './judge-client.js';
import { Superagent } from './runtime.js';
import {
  HttpSandbox,
  SMALLEST_SANDBOX,
  createSandboxFromEnv,
  instaboxApiFromEnv,
  instaboxCreateSourceFromEnv,
  redactSecret,
  type SandboxPort,
} from './sandbox.js';
import { actMandate } from './types.js';
import { formatEvidence } from './evidence.js';
import { initLocalRepo } from './workspace.js';

export interface RealLoopReport {
  ok: boolean;
  live: boolean;
  workerId: string | null;
  branch: string | null;
  prUrl: string | null;
  destroyed: boolean;
  machineId: string | null;
  evidence: string;
  steps: string[];
  error?: string;
}

export interface RealLoopOptions {
  env?: NodeJS.ProcessEnv;
  sandbox?: SandboxPort;
  repoDir?: string;
  keepDir?: boolean;
}

/**
 * Full worker loop against a scratch repo. Default is FakeSandbox + FakeCoder
 * (safe for CI). Live Instabox / model / GitHub only when MAKA_CLOUD_LOOP_LIVE=1
 * and the matching env vars are set. This process never invents those keys.
 */
export async function runRealLoop(options: RealLoopOptions = {}): Promise<RealLoopReport> {
  const env = options.env ?? process.env;
  const live = env.MAKA_CLOUD_LOOP_LIVE === '1';
  const report: RealLoopReport = {
    ok: false,
    live,
    workerId: null,
    branch: null,
    prUrl: null,
    destroyed: false,
    machineId: null,
    evidence: '',
    steps: [],
  };
  let dir: string | undefined;
  let box: HttpSandbox | undefined;
  let machineId: string | undefined;
  const key = env.INSTABOX_API_KEY?.trim() ?? '';
  try {
    dir = options.repoDir ?? (await initLocalRepo(scratchFiles()));
    report.steps.push('workspace');
    const sandbox = options.sandbox ?? (live ? await liveSandbox(env) : createSandboxFromEnv(env));
    if (live && sandbox instanceof HttpSandbox) {
      box = sandbox;
      const created = await box.createMachine({
        name: `maka-loop-${Date.now()}`,
        ...instaboxCreateSourceFromEnv(env),
        desiredState: 'running',
        vcpus: SMALLEST_SANDBOX.vcpus,
        memMiB: SMALLEST_SANDBOX.memMiB,
        metadata: { 'maka.purpose': 'real-loop' },
      });
      const settled =
        created.state === 'succeeded' ? created : await box.waitForOperation(created.id);
      machineId = settled.machineId ?? created.machineId;
      report.machineId = machineId ?? null;
      report.steps.push('sandbox-create');
    }
    const git = new FakeGitHost();
    const handler = new CodingLoopHandler({
      coder: new FakeCoder(),
      tests: new NodeFileTestPort(),
      git,
      sandbox,
      repoUrl: dir,
    });
    const agent = new Superagent({
      handler,
      sandbox,
      sandboxRef: machineId,
      judge: live
        ? createJudgeFromEnv(env)
        : {
            async decide(event) {
              return {
                action: 'spawn',
                mandate: actMandate(event.subject?.repo ? [event.subject.repo] : ['local/scratch']),
                title: 'real-loop',
              };
            },
          },
      ids: sequentialIds(300),
      admission: { allowActors: ['alice'] },
    });
    const opened = await agent.ingest(prOpened());
    report.steps.push('spawn');
    if (opened.result !== 'spawned') {
      throw new Error(`expected spawn, got ${opened.result}`);
    }
    report.workerId = opened.workerId;
    const after = agent.store.worker('inv_loop', opened.workerId);
    report.branch = workerBranch(opened.workerId);
    report.prUrl = git.pullRequests[0]?.url ?? null;
    report.evidence = formatEvidence(after?.evidence ?? []);
    if (!git.pushes[0] || !git.pullRequests[0]) {
      throw new Error('loop did not push a worker branch or open a PR');
    }
    report.steps.push('push', 'pr');
    const pr = git.pullRequests[0];
    const ci = await agent.ingest(ciFailed('inv_loop', 7));
    if (ci.result === 'passthrough') report.steps.push('ci-resume');
    const comment = await agent.ingest(reviewComment('inv_loop', 7));
    if (comment.result === 'passthrough') report.steps.push('review-resume');
    const waiting = agent.store.worker('inv_loop', opened.workerId);
    if (waiting) {
      const held = agent.safety.gate(waiting, mergeAction('local/scratch', pr.number), Date.now());
      if (!held.allowed && held.reason === 'held') {
        report.steps.push('merge-held');
        await agent.approve(
          'inv_loop',
          held.approvalId,
          mergeAction('local/scratch', pr.number).boundText,
        );
        report.steps.push('merge-approved');
      }
    }
    report.ok = git.pushes.length >= 1 && git.pullRequests.length >= 1;
    agent.close();
  } catch (error) {
    report.error = redactSecret(error instanceof Error ? error.message : 'real-loop failed', key);
  } finally {
    if (machineId && box) {
      try {
        await box.destroyMachine(machineId);
        report.destroyed = true;
        report.steps.push('sandbox-destroy');
      } catch (error) {
        const extra = redactSecret(error instanceof Error ? error.message : 'destroy failed', key);
        report.error = report.error ? `${report.error}; ${extra}` : extra;
      }
    }
    if (dir && !options.keepDir && !options.repoDir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return report;
}

export function formatRealLoopReport(report: RealLoopReport): string {
  return [
    `ok: ${report.ok}`,
    `live: ${report.live}`,
    `worker: ${report.workerId ?? '(none)'}`,
    `branch: ${report.branch ?? '(none)'}`,
    `pr: ${report.prUrl ?? '(none)'}`,
    `machine: ${report.machineId ?? '(none)'}`,
    `destroyed: ${report.destroyed}`,
    `steps: ${report.steps.join(' → ')}`,
    report.evidence,
    report.error ? `error: ${report.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runRealLoopCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const key = env.INSTABOX_API_KEY?.trim() ?? '';
  const report = await runRealLoop({ env });
  console.log(redactSecret(formatRealLoopReport(report), key));
  return report.ok ? 0 : 1;
}

async function liveSandbox(env: NodeJS.ProcessEnv): Promise<HttpSandbox> {
  const api = instaboxApiFromEnv(env);
  return new HttpSandbox({ apiKey: api.apiKey, baseUrl: api.baseUrl });
}

function prOpened(): IngestInput {
  return {
    source: 'github',
    tenantId: 'inv_loop',
    deliveryId: 'loop-open',
    event: 'pull_request',
    payload: {
      action: 'opened',
      pull_request: {
        number: 7,
        title: 'add(2,3) should be 5',
        user: { login: 'alice', type: 'User' },
        head: { ref: 'maka/pr-7' },
      },
      repository: { full_name: 'local/scratch' },
      sender: { login: 'alice', type: 'User' },
    },
  };
}

function ciFailed(tenantId: string, number: number): IngestInput {
  return {
    source: 'github',
    tenantId,
    deliveryId: 'loop-ci',
    event: 'workflow_run',
    payload: {
      action: 'completed',
      workflow_run: {
        id: 1,
        name: 'test',
        head_sha: 'deadbeef',
        conclusion: 'failure',
        head_branch: 'maka/pr-7',
        pull_requests: [{ number }],
      },
      repository: { full_name: 'local/scratch' },
      sender: { login: 'github-actions[bot]', type: 'Bot' },
    },
  };
}

function reviewComment(tenantId: string, number: number): IngestInput {
  return {
    source: 'github',
    tenantId,
    deliveryId: 'loop-review',
    event: 'issue_comment',
    payload: {
      action: 'created',
      issue: { number, title: 'add', pull_request: {} },
      comment: { id: 1, body: 'please also add a comment' },
      repository: { full_name: 'local/scratch' },
      sender: { login: 'bob', type: 'User' },
    },
  };
}

/** Scratch workspace used by the metrics harness. */
export async function scratchAddRepo(): Promise<string> {
  return initLocalRepo(scratchFiles());
}
