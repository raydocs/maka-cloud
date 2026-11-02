import { rm } from 'node:fs/promises';
import type { IngestInput } from './events.js';
import { sequentialIds } from './ids.js';
import { createCoderFromEnv } from './loop-coder.js';
import { createGitHostFromEnv } from './loop-github.js';
import {
  CodingLoopHandler,
  FakeGitHost,
  NodeFileTestPort,
  mergeAction,
  scratchFiles,
  workerBranch,
} from './loop.js';
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
  coder: 'fake' | 'model';
  git: 'fake' | 'github';
  evidence: string;
  steps: string[];
  error?: string;
}

export interface RealLoopOptions {
  env?: NodeJS.ProcessEnv;
  sandbox?: SandboxPort;
  repoDir?: string;
  keepDir?: boolean;
  fetch?: typeof fetch;
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
    coder: 'fake',
    git: 'fake',
    evidence: '',
    steps: [],
  };
  let dir: string | undefined;
  let box: HttpSandbox | undefined;
  let machineId: string | undefined;
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
    const fetchImpl = options.fetch ?? fetch;
    const coded = createCoderFromEnv(env, fetchImpl);
    const hosted = createGitHostFromEnv(env, fetchImpl);
    report.coder = coded.kind;
    report.git = hosted.kind;
    const repoName = hosted.repo ?? 'local/scratch';
    const git = hosted.git;
    const handler = new CodingLoopHandler({
      coder: coded.coder,
      tests: new NodeFileTestPort(),
      git,
      sandbox,
      repoUrl: dir,
    });
    const agent = new Superagent({
      handler,
      sandbox,
      sandboxRef: machineId,
      // Scratch CLI always spawns with `act` so the worker may push a
      // worker branch. HeuristicJudge's default is observe (no push).
      judge: {
        async decide(event) {
          return {
            action: 'spawn',
            mandate: actMandate(event.subject?.repo ? [event.subject.repo] : [repoName]),
            title: 'real-loop',
          };
        },
      },
      ids: sequentialIds(300),
      admission: { allowActors: ['alice'] },
    });
    const opened = await agent.ingest(prOpened(repoName));
    report.steps.push('spawn');
    if (opened.result !== 'spawned') {
      throw new Error(`expected spawn, got ${opened.result}`);
    }
    report.workerId = opened.workerId;
    const after = agent.store.worker('inv_loop', opened.workerId);
    report.branch = workerBranch(opened.workerId);
    const pr = handler.lastPr.get(opened.workerId);
    report.prUrl = pr?.url ?? null;
    report.evidence = formatEvidence(after?.evidence ?? []);
    const pushed = Boolean(after?.memory?.includes('pushed') && pr);
    if (!pushed || !pr) {
      throw new Error('loop did not push a worker branch or open a PR');
    }
    report.steps.push('push', 'pr');
    const ci = await agent.ingest(ciFailed('inv_loop', 7, repoName));
    if (ci.result === 'passthrough') report.steps.push('ci-resume');
    const comment = await agent.ingest(reviewComment('inv_loop', 7, repoName));
    if (comment.result === 'passthrough') report.steps.push('review-resume');
    const waiting = agent.store.worker('inv_loop', opened.workerId);
    if (waiting) {
      const action = mergeAction(repoName, pr.number);
      const held = agent.safety.gate(waiting, action, Date.now());
      if (!held.allowed && held.reason === 'held') {
        report.steps.push('merge-held');
        // Live GitHub never auto-merges. Fake host may approve to prove the gate.
        if (git instanceof FakeGitHost) {
          await agent.approve('inv_loop', held.approvalId, action.boundText);
          report.steps.push('merge-approved');
        }
      }
    }
    report.ok = pushed && Boolean(pr.url);
    agent.close();
  } catch (error) {
    report.error = redactKeys(error instanceof Error ? error.message : 'real-loop failed', env);
  } finally {
    if (machineId && box) {
      try {
        await box.destroyMachine(machineId);
        report.destroyed = true;
        report.steps.push('sandbox-destroy');
      } catch (error) {
        const extra = redactKeys(error instanceof Error ? error.message : 'destroy failed', env);
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
    `coder: ${report.coder}`,
    `git: ${report.git}`,
    `destroyed: ${report.destroyed}`,
    `steps: ${report.steps.join(' → ')}`,
    report.evidence,
    report.error ? `error: ${report.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runRealLoopCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const report = await runRealLoop({ env });
  console.log(redactKeys(formatRealLoopReport(report), env));
  return report.ok ? 0 : 1;
}

function redactKeys(text: string, env: NodeJS.ProcessEnv): string {
  return [
    env.INSTABOX_API_KEY,
    env.MAKA_GITHUB_TOKEN,
    env.ANTHROPIC_API_KEY,
    env.MAKA_CLOUD_JUDGE_API_KEY,
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
    .reduce((out, secret) => redactSecret(out, secret), text);
}

async function liveSandbox(env: NodeJS.ProcessEnv): Promise<HttpSandbox> {
  const api = instaboxApiFromEnv(env);
  return new HttpSandbox({ apiKey: api.apiKey, baseUrl: api.baseUrl });
}

function prOpened(repo: string): IngestInput {
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
      repository: { full_name: repo },
      sender: { login: 'alice', type: 'User' },
    },
  };
}

function ciFailed(tenantId: string, number: number, repo: string): IngestInput {
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
      repository: { full_name: repo },
      sender: { login: 'github-actions[bot]', type: 'Bot' },
    },
  };
}

function reviewComment(tenantId: string, number: number, repo: string): IngestInput {
  return {
    source: 'github',
    tenantId,
    deliveryId: 'loop-review',
    event: 'issue_comment',
    payload: {
      action: 'created',
      issue: { number, title: 'add', pull_request: {} },
      comment: { id: 1, body: 'please also add a comment' },
      repository: { full_name: repo },
      sender: { login: 'bob', type: 'User' },
    },
  };
}

/** Scratch workspace used by the metrics harness. */
export async function scratchAddRepo(): Promise<string> {
  return initLocalRepo(scratchFiles());
}
