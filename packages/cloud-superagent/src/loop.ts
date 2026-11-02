import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { EvidenceBlock } from './types.js';
import type {
  HandlerResult,
  NormalizedEvent,
  ProposedAction,
  Usage,
  WorkerContext,
  WorkerHandler,
  WorkerRecord,
} from './types.js';
import { GitCloneStore, type WorkspaceHandle, type WorkspaceStore } from './workspace.js';
import type { SandboxPort } from './sandbox.js';

const run = promisify(execFile);

export function workerBranch(workerId: string): string {
  return `maka/sa-${workerId}`;
}

export function mayPush(worker: WorkerRecord): boolean {
  return worker.mandate.intensity !== 'observe' && worker.mandate.authority !== 'read-only';
}

export interface CoderResult {
  changed: string[];
  summary: string;
  usage?: Partial<Usage>;
}

export interface CoderPort {
  apply(input: {
    dir: string;
    brief: string;
    event: NormalizedEvent;
    worker: WorkerRecord;
  }): Promise<CoderResult>;
}

export interface TestResult {
  ok: boolean;
  output: string;
  command: string;
}

export interface TestPort {
  run(input: { dir: string }): Promise<TestResult>;
}

export interface PushResult {
  sha: string;
  branch: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export interface GitHostPort {
  commitAndPush(input: {
    dir: string;
    branch: string;
    message: string;
    repo: string;
  }): Promise<PushResult>;
  openOrUpdatePullRequest(input: {
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
    number?: number;
  }): Promise<PullRequestResult>;
  ciLink(repo: string, sha: string): string;
  merge?(input: { repo: string; number: number }): Promise<void>;
}

export interface LoopPorts {
  workspaces?: WorkspaceStore;
  coder: CoderPort;
  tests: TestPort;
  git: GitHostPort;
  sandbox?: SandboxPort;
  /** Local path or git URL. Defaults to `subject.repo`. */
  repoUrl?: string | ((repo: string) => string);
  protectedBranches?: readonly string[];
  baseBranch?: string;
  testCommand?: string;
}

/** Writes known files. CI uses this instead of a live model. */
export class FakeCoder implements CoderPort {
  constructor(private readonly files: Record<string, string> = { 'add.js': ADD_FIXED }) {}

  async apply(input: { dir: string }): Promise<CoderResult> {
    const changed: string[] = [];
    for (const [rel, content] of Object.entries(this.files)) {
      const path = join(input.dir, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      changed.push(rel);
    }
    return {
      changed,
      summary: `fake coder wrote ${changed.join(', ')}`,
      usage: { tokens: 40, usdMicros: 200, wallMs: 12 },
    };
  }
}

export const ADD_BROKEN = 'export function add(a, b) { return a; }\n';
export const ADD_FIXED = 'export function add(a, b) { return a + b; }\n';
export const ADD_TEST = `import assert from 'node:assert/strict';
import { add } from './add.js';
assert.equal(add(2, 3), 5);
`;
export const SCRATCH_PACKAGE = '{ "type": "module" }\n';

export function scratchFiles(broken = true): Record<string, string> {
  return {
    'package.json': SCRATCH_PACKAGE,
    'add.js': broken ? ADD_BROKEN : ADD_FIXED,
    'add.test.js': ADD_TEST,
  };
}

export class NodeFileTestPort implements TestPort {
  constructor(private readonly command = 'node add.test.js') {}

  async run(input: { dir: string }): Promise<TestResult> {
    const [bin, ...args] = this.command.split(/\s+/);
    try {
      const { stdout, stderr } = await run(bin, args, { cwd: input.dir });
      return { ok: true, output: `${stdout}${stderr}`.trim() || 'ok', command: this.command };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        output: `${err.stdout ?? ''}${err.stderr ?? err.message ?? 'test failed'}`.trim(),
        command: this.command,
      };
    }
  }
}

export class FakeGitHost implements GitHostPort {
  readonly pushes: PushResult[] = [];
  readonly pullRequests: Array<
    PullRequestResult & { branch: string; title: string; body: string }
  > = [];
  readonly merged: number[] = [];
  private nextPr = 1;

  async commitAndPush(input: {
    dir: string;
    branch: string;
    message: string;
  }): Promise<PushResult> {
    await run('git', ['-C', input.dir, 'checkout', '-B', input.branch]);
    await run('git', ['-C', input.dir, 'add', '-A']);
    await run('git', [
      '-C',
      input.dir,
      '-c',
      'user.email=superagent@test',
      '-c',
      'user.name=Superagent Loop',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      input.message,
      '--allow-empty',
    ]);
    const { stdout } = await run('git', ['-C', input.dir, 'rev-parse', 'HEAD']);
    const result = { sha: stdout.trim(), branch: input.branch };
    this.pushes.push(result);
    return result;
  }

  async openOrUpdatePullRequest(input: {
    repo: string;
    branch: string;
    title: string;
    body: string;
    number?: number;
  }): Promise<PullRequestResult> {
    const existing = this.pullRequests.find((row) => row.branch === input.branch);
    if (existing) {
      existing.title = input.title;
      existing.body = input.body;
      return existing;
    }
    const number = input.number ?? this.nextPr++;
    const row = {
      number,
      url: `https://github.com/${input.repo}/pull/${number}`,
      branch: input.branch,
      title: input.title,
      body: input.body,
    };
    this.pullRequests.push(row);
    return row;
  }

  ciLink(repo: string, sha: string): string {
    return `https://github.com/${repo}/commit/${sha}/checks`;
  }

  async merge(input: { number: number }): Promise<void> {
    this.merged.push(input.number);
  }
}

/**
 * Worker that clones via WorkspaceStore, applies a coder, runs tests, pushes
 * a worker branch (act mandate), and opens/updates a PR. Merge / protected
 * push / secrets / deploy are returned as ProposedAction for Safety.
 *
 * The model lives on the host (FakeCoder or a live client). Instabox is used
 * for ensureRunning + a verify exec so the API key never enters the box —
 * the same split as cloud-playbooks GitHubPublisher.
 */
export class CodingLoopHandler implements WorkerHandler {
  private readonly workspaces: WorkspaceStore;
  private readonly handles = new Map<string, WorkspaceHandle>();
  readonly lastPr = new Map<string, PullRequestResult>();

  constructor(private readonly ports: LoopPorts) {
    this.workspaces = ports.workspaces ?? new GitCloneStore();
  }

  async handle(ctx: WorkerContext, event: NormalizedEvent): Promise<HandlerResult> {
    const worker = ctx.worker;
    const repo = worker.subject.repo ?? 'local/scratch';
    const box = worker.sandboxRef ?? 'loop';
    if (event.type === 'approval_granted') {
      return this.onApproval(ctx, event, repo);
    }
    if (!mayPush(worker)) {
      return {
        progress: true,
        plan: 'observe only — no push',
        evidence: [
          {
            kind: 'step',
            label: 'observe',
            body: `${event.type} on ${worker.subject.key}; intensity=${worker.mandate.intensity}`,
          },
        ],
      };
    }

    if (this.ports.sandbox) {
      await this.ports.sandbox.ensureRunning(box);
    }

    const brief = briefOf(event);
    const handle = await this.prepare(worker, repo);
    const coded = await this.ports.coder.apply({
      dir: handle.dir as string,
      brief,
      event,
      worker,
    });
    const patch = await this.workspaces.exportPatch(handle);
    const tested = await this.ports.tests.run({ dir: handle.dir as string });
    if (this.ports.sandbox) {
      await this.ports.sandbox.exec(box, { cmd: `echo loop-verify ${tested.ok ? 'ok' : 'fail'}` });
    }

    const evidence: EvidenceBlock[] = [
      { kind: 'step', label: coded.summary, body: coded.changed.join('\n') },
      {
        kind: 'patch',
        label: 'diff summary',
        body: summarizePatch(patch),
        path: handle.dir ?? undefined,
      },
      { kind: 'test', label: tested.command, body: tested.output },
    ];

    if (!tested.ok) {
      return {
        progress: true,
        workspaceRef: handle.id,
        memory: `tests failed: ${tested.output.slice(0, 200)}`,
        plan: 'fix tests after failure',
        usage: coded.usage,
        evidence,
        stepSignature: `test-fail:${event.type}`,
      };
    }

    const branch = workerBranch(worker.workerId);
    const protectedBranches = this.ports.protectedBranches ?? ['main', 'master'];
    if (protectedBranches.includes(branch)) {
      return {
        progress: true,
        workspaceRef: handle.id,
        evidence,
        action: {
          kind: 'push_protected',
          boundText: `Push ${branch} on ${repo}`,
        },
      };
    }

    const pushed = await this.ports.git.commitAndPush({
      dir: handle.dir as string,
      branch,
      message: `superagent: ${brief.slice(0, 72)}`,
      repo,
    });
    const pr = await this.ports.git.openOrUpdatePullRequest({
      repo,
      branch,
      base: this.ports.baseBranch ?? 'main',
      title: worker.plan || brief.slice(0, 72) || `worker ${worker.workerId}`,
      body: formatPrBody(worker, evidence, pushed),
      number: this.lastPr.get(worker.workerId)?.number,
    });
    this.lastPr.set(worker.workerId, pr);
    const ci = this.ports.git.ciLink(repo, pushed.sha);
    evidence.push({ kind: 'artifact', label: 'CI', body: ci, path: pr.url });

    return {
      progress: true,
      workspaceRef: handle.id,
      memory: `pushed ${pushed.sha} pr=${pr.url}`,
      plan: `open-pr ${pr.url}`,
      usage: coded.usage,
      evidence,
      stepSignature: `loop:${event.type}:${pushed.sha}`,
    };
  }

  private async onApproval(
    ctx: WorkerContext,
    event: NormalizedEvent,
    repo: string,
  ): Promise<HandlerResult> {
    const kind = field(event, 'kind');
    const bound = field(event, 'boundText');
    if (kind === 'merge') {
      const pr = this.lastPr.get(ctx.worker.workerId);
      if (pr && this.ports.git.merge) {
        await this.ports.git.merge({ repo, number: pr.number });
      }
      return {
        progress: true,
        memory: `merged ${bound}`,
        evidence: [{ kind: 'step', label: 'merge', body: bound }],
      };
    }
    return { progress: true, memory: `approved ${kind}` };
  }

  private async prepare(worker: WorkerRecord, repo: string): Promise<WorkspaceHandle> {
    const existing = worker.workspaceRef ? this.handles.get(worker.workspaceRef) : undefined;
    if (existing?.dir) return existing;
    const mapped =
      typeof this.ports.repoUrl === 'function'
        ? this.ports.repoUrl(repo)
        : (this.ports.repoUrl ?? repo);
    const repoUrl = mapped;
    const handle = await this.workspaces.prepare({
      tenantId: worker.tenantId,
      workerId: worker.workerId,
      repoUrl,
    });
    if (!handle.dir) throw new Error('CodingLoopHandler needs a git-clone workspace directory.');
    this.handles.set(handle.id, handle);
    return handle;
  }
}

export function mergeAction(repo: string, number: number): ProposedAction {
  return { kind: 'merge', boundText: `Merge pull request #${number} in ${repo}` };
}

function briefOf(event: NormalizedEvent): string {
  return (
    field(event, 'body') ||
    field(event, 'comment') ||
    field(event, 'text') ||
    field(event, 'title') ||
    event.summary ||
    event.type
  );
}

function field(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

function summarizePatch(patch: string): string {
  const files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
  const plus = (patch.match(/^\+/gm) ?? []).length;
  const minus = (patch.match(/^-/gm) ?? []).length;
  if (files.length === 0 && !patch.trim()) return '(no diff)';
  return `${files.join(', ') || 'workspace'} +${plus} -${minus}\n${patch.slice(0, 800)}`;
}

function formatPrBody(worker: WorkerRecord, evidence: EvidenceBlock[], pushed: PushResult): string {
  const lines = [
    `Worker \`${worker.workerId}\` on \`${worker.subject.key}\`.`,
    `Branch \`${pushed.branch}\` @ \`${pushed.sha.slice(0, 8)}\`.`,
    '',
    '### Evidence',
  ];
  for (const block of evidence) {
    lines.push(`- **${block.kind}** ${block.label}`);
  }
  return lines.join('\n');
}
