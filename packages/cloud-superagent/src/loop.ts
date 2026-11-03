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
import { defaultPhases, type ProgressPhase } from './progress.js';
import {
  BOX_REPO,
  BoxWorkspace,
  applyBoxPatch,
  formatBoxExec,
  formatBoxExecSummary,
  isPublicCloneUrl,
  type BoxExecLog,
} from './loop-box.js';
import { GitCloneStore, type WorkspaceHandle, type WorkspaceStore } from './workspace.js';
import { DuplexLoop } from './duplex.js';
import type { SandboxPort } from './sandbox.js';

const run = promisify(execFile);

export function workerBranch(workerId: string): string {
  return `maka/sa-${workerId}`;
}

export function mayPush(worker: WorkerRecord): boolean {
  if (worker.speculative && worker.speculative.status !== 'accepted') return false;
  return worker.mandate.intensity !== 'observe' && worker.mandate.authority !== 'read-only';
}

export interface CoderResult {
  changed: string[];
  files: Record<string, string>;
  summary: string;
  usage?: Partial<Usage>;
}

export interface CoderPort {
  apply(input: {
    dir?: string;
    snapshot?: string;
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
  merge?(input: {
    repo: string;
    number: number;
    sha: string;
    allowNoCi?: boolean;
    receipt?: import('./review.js').ReviewReceipt;
  }): Promise<void>;
  readPull?(input: {
    repo: string;
    number: number;
  }): Promise<{ merged: boolean; mergeSha?: string }>;
  readIssue?(input: { repo: string; number: number }): Promise<{ closed: boolean }>;
  readCi?(sha: string, repo?: string): Promise<import('./loop-github.js').CiStatus>;
}

export const LOOP_TIMING_PHASES = [
  'create',
  'materialize',
  'edit',
  'test',
  'diff',
  'destroy',
] as const;

export type LoopTimingPhase = (typeof LOOP_TIMING_PHASES)[number];
export type LoopTimings = Record<LoopTimingPhase, number>;

export function emptyTimings(): LoopTimings {
  return { create: 0, materialize: 0, edit: 0, test: 0, diff: 0, destroy: 0 };
}

export function formatTimings(timings: LoopTimings): string {
  return LOOP_TIMING_PHASES.map((phase) => `${phase}=${timings[phase]}ms`).join(' ');
}

export interface LoopPorts {
  workspaces?: WorkspaceStore;
  coder: CoderPort;
  tests: TestPort;
  git: GitHostPort;
  sandbox?: SandboxPort;
  /** Local path or git URL. Defaults to `subject.repo`. */
  repoUrl?: string | ((repo: string) => string);
  /** `clone` runs `git clone` in the box (public / local path). `upload` sends a host tarball. */
  boxSource?: 'clone' | 'upload';
  protectedBranches?: readonly string[];
  baseBranch?: string;
  installCommand?: string;
  testCommand?: string;
  /** When false, box tests are the deliverable (no git push / PR). */
  publish?: boolean;
  /** Worker model id for peer review. Host passes this; the loop does not read env. */
  workerModel?: string;
}

/** Writes known files. CI uses this instead of a live model. */
export class FakeCoder implements CoderPort {
  constructor(private readonly files: Record<string, string> = { 'add.js': ADD_FIXED }) {}

  async apply(input: { dir?: string }): Promise<CoderResult> {
    const changed: string[] = [];
    for (const [rel, content] of Object.entries(this.files)) {
      if (input.dir) {
        const path = join(input.dir, rel);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
      changed.push(rel);
    }
    return {
      changed,
      files: { ...this.files },
      summary: `fake coder wrote ${changed.join(', ')}`,
      usage: { tokens: 40, usdMicros: 200, wallMs: 12 },
    };
  }
}

/** Live public-repo probe: run the repo's own tests, do not invent files. */
export class NoopCoder implements CoderPort {
  async apply(): Promise<CoderResult> {
    return { changed: [], files: {}, summary: 'no edits' };
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
  readonly mergedShas: string[] = [];
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

  async merge(input: {
    number: number;
    sha: string;
    receipt?: import('./review.js').ReviewReceipt;
  }): Promise<void> {
    if (!input.receipt || input.receipt.verdict !== 'CLEAR' || input.receipt.sha !== input.sha) {
      throw new Error('MERGE_REFUSED no review receipt at head');
    }
    this.merged.push(input.number);
    this.mergedShas.push(input.sha);
  }

  async readPull(input: { number: number }): Promise<{ merged: boolean; mergeSha?: string }> {
    const index = this.merged.indexOf(input.number);
    return {
      merged: index >= 0,
      mergeSha: index >= 0 ? this.mergedShas[index] : undefined,
    };
  }

  async readIssue(): Promise<{ closed: boolean }> {
    return { closed: false };
  }

  async readCi(): Promise<import('./loop-github.js').CiStatus> {
    return { verdict: 'success', detail: 'fake' };
  }
}

/**
 * Worker that materializes the repo *inside* the sandbox, applies host-computed
 * coder edits there, runs install/test there, then pulls a diff back. The host
 * calls the model and publishes via GitHub API — tokens never enter the box.
 */
export class CodingLoopHandler implements WorkerHandler {
  private readonly workspaces: WorkspaceStore;
  private readonly handles = new Map<string, WorkspaceHandle>();
  readonly lastPr = new Map<string, PullRequestResult>();
  readonly lastPush = new Map<string, PushResult>();
  readonly lastTimings: LoopTimings = emptyTimings();
  lastExecs: BoxExecLog[] = [];
  lastPatch = '';
  lastPublishDir: string | null = null;
  lastUsage: CoderResult['usage'];

  constructor(private readonly ports: LoopPorts) {
    this.workspaces = ports.workspaces ?? new GitCloneStore();
  }

  async handle(ctx: WorkerContext, event: NormalizedEvent): Promise<HandlerResult> {
    let produced: HandlerResult | undefined;
    const loop = new DuplexLoop(
      {
        next: async () => {
          if (produced) {
            return { kind: 'done' as const, result: produced };
          }
          produced = await this.runLoop(ctx, event);
          return {
            kind: 'done' as const,
            memory: produced.memory,
            plan: produced.plan,
            usage: produced.usage,
            progressUpdate: produced.progressUpdate,
            result: produced,
          };
        },
      },
      { maxSteps: 2 },
    );
    const wrapped = await loop.handle(ctx, event);
    return produced ?? wrapped;
  }

  private async runLoop(ctx: WorkerContext, event: NormalizedEvent): Promise<HandlerResult> {
    const worker = ctx.worker;
    const repo = worker.subject.repo ?? 'local/scratch';
    const boxId = worker.sandboxRef ?? 'loop';
    const report = ctx.reportProgress ?? (async () => undefined);
    const enter = async (
      phase: ProgressPhase,
      activity: string,
      waiting?: null | { kind: 'ci' | 'review' | 'human'; detail: string },
    ) => {
      await report({
        phase,
        activity,
        ...(waiting === undefined ? {} : { waiting }),
      });
    };
    if (event.type === 'watchdog_nudge') {
      await enter(worker.progress?.phase ?? 'edit', event.summary);
      return { progress: false, plan: worker.plan };
    }
    if (event.type === 'approval_granted') {
      return this.onApproval(ctx, event, repo);
    }
    if (event.type === 'ci_passed' && this.lastPr.has(worker.workerId)) {
      await enter('review-wait', event.summary, { kind: 'review', detail: event.summary });
      return {
        progress: true,
        plan: 'ci green; waiting on review',
        progressUpdate: {
          phase: 'review-wait',
          waiting: { kind: 'review', detail: event.summary },
          activity: event.summary,
        },
      };
    }
    if (event.type === 'ci_failed') {
      await enter('edit', event.summary, null);
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

    const brief = briefOf(event);
    const mapped = this.mappedUrl(repo);
    const sandbox = this.ports.sandbox;
    const boxed = sandbox ? new BoxWorkspace(sandbox, boxId) : undefined;
    if (sandbox) await sandbox.ensureRunning(boxId);

    const cloneInBox =
      this.ports.boxSource === 'clone' ||
      (this.ports.boxSource !== 'upload' && isPublicCloneUrl(mapped));
    const publish = this.ports.publish !== false;
    const handle =
      publish || !cloneInBox
        ? await this.prepare(worker, repo)
        : { id: `box:${worker.workerId}`, kind: 'git-clone' as const, dir: null };

    this.resetLast();
    const phases = defaultPhases({
      publish,
      install: Boolean(boxed && this.ports.installCommand),
    });
    await report({ phases, phase: phases[0], activity: `plan ${phases.join(' → ')}` });
    const evidence: EvidenceBlock[] = [];
    if (boxed) {
      await enter('materialize', cloneInBox ? `git clone ${mapped}` : 'upload host tarball');
      const kind = await this.timed('materialize', () =>
        boxed.materialize(cloneInBox ? { clone: mapped } : { hostDir: handle.dir as string }),
      );
      evidence.push({
        kind: 'step',
        label: kind === 'clone' ? 'box-clone' : 'box-upload',
        body: cloneInBox ? mapped : 'host tarball (no token)',
      });
    }

    await enter('edit', `model step: ${brief.slice(0, 80)}`);
    const coded = await this.timed('edit', async () => {
      const snapshot = boxed ? await boxed.snapshot() : undefined;
      const result = await this.ports.coder.apply({
        dir: boxed ? undefined : (handle.dir ?? undefined),
        snapshot,
        brief,
        event,
        worker,
      });
      if (boxed) await boxed.writeFiles(result.files);
      return result;
    });
    this.lastUsage = coded.usage;
    evidence.push({
      kind: 'step',
      label: 'box-edit',
      body: `${coded.summary}\n${coded.changed.join('\n')}`,
    });
    if (coded.usage) {
      evidence.push({
        kind: 'step',
        label: 'model-usage',
        body: formatModelUsage(coded.usage),
      });
    }

    const testCommand = this.ports.testCommand ?? 'node add.test.js';
    const tested = await this.timed('test', async () => {
      if (boxed && this.ports.installCommand) {
        await enter('install', this.ports.installCommand);
        const installed = await boxed.run(this.ports.installCommand);
        evidence.push({
          kind: 'step',
          label: this.ports.installCommand,
          body: formatBoxExec({
            cmd: this.ports.installCommand,
            cwd: BOX_REPO,
            exitCode: installed.exitCode,
            stdout: installed.stdout,
            stderr: installed.stderr,
          }),
        });
      }
      await enter('test', testCommand);
      if (boxed) return boxTest(await boxed.run(testCommand), testCommand);
      return this.ports.tests.run({ dir: handle.dir as string });
    });
    const patch = await this.timed('diff', async () => {
      const raw = boxed
        ? await boxed.pullPatch()
        : handle.dir
          ? await this.workspaces.exportPatch(handle)
          : '';
      this.lastPatch = raw;
      return raw;
    });
    this.lastExecs = boxed ? [...boxed.execs] : [];
    this.lastPublishDir = handle.dir ?? null;
    evidence.push({
      kind: 'patch',
      label: 'box-diff',
      body: boxed
        ? `applied box git diff --cached to a clean host checkout\n${summarizePatch(patch)}`
        : summarizePatch(patch),
      path: handle.dir ?? BOX_REPO,
    });
    evidence.push({ kind: 'test', label: tested.command, body: tested.output });
    if (this.lastExecs.length > 0) {
      evidence.push({
        kind: 'step',
        label: 'box-exec',
        body: this.lastExecs.map((log) => formatBoxExec(log)).join('\n\n'),
      });
      evidence.push({
        kind: 'step',
        label: 'box-exec-summary',
        body: formatBoxExecSummary(this.lastExecs),
      });
    }

    if (!tested.ok) {
      return {
        progress: true,
        workspaceRef: handle.id,
        sandboxRef: boxId,
        memory: `tests failed: ${tested.output.slice(0, 200)}`,
        plan: 'fix tests after failure',
        usage: coded.usage,
        evidence,
        stepSignature: `test-fail:${event.type}`,
      };
    }

    if (!publish) {
      return {
        progress: true,
        workspaceRef: handle.id,
        sandboxRef: boxId,
        memory: 'box-tests ok',
        plan: 'box-tests',
        usage: coded.usage,
        evidence,
        stepSignature: `box:${event.type}`,
      };
    }

    if (boxed && handle.dir) {
      await this.timed('diff', () => applyBoxPatch(handle.dir as string, patch));
    }

    const branch = workerBranch(worker.workerId);
    const protectedBranches = this.ports.protectedBranches ?? ['main', 'master'];
    if (protectedBranches.includes(branch)) {
      return {
        progress: true,
        workspaceRef: handle.id,
        sandboxRef: boxId,
        evidence,
        action: {
          kind: 'push_protected',
          boundText: `Push ${branch} on ${repo}`,
        },
      };
    }

    if (ctx.peerReview) {
      await enter('review-wait', 'peer review of the diff', {
        kind: 'review',
        detail: 'peer-review',
      });
      const reviewed = await ctx.peerReview({ diff: patch, repo });
      if (reviewed.feedback) {
        evidence.push({ kind: 'step', label: 'peer-review', body: reviewed.feedback });
      }
      if (!reviewed.allowed) {
        return {
          progress: true,
          workspaceRef: handle.id,
          sandboxRef: boxId,
          memory: reviewed.feedback,
          plan: reviewed.waiting ? 'peer-review waiting on human' : 'fix peer-review findings',
          usage: coded.usage,
          evidence,
          stepSignature: `peer-review:${reviewed.severity}`,
          progressUpdate: reviewed.waiting
            ? {
                phase: 'review-wait',
                waiting: { kind: 'human', detail: 'peer-review' },
                activity: 'peer-review exhausted',
              }
            : {
                phase: 'edit',
                waiting: null,
                activity: 'fix peer-review findings',
              },
        };
      }
    }

    await enter('push', `git push ${branch}`);
    const pushed = await this.ports.git.commitAndPush({
      dir: handle.dir as string,
      branch,
      message: `superagent: ${brief.slice(0, 72)}`,
      repo,
    });
    await enter('pr', `open pull request on ${branch}`);
    const pr = await this.ports.git.openOrUpdatePullRequest({
      repo,
      branch,
      base: this.ports.baseBranch ?? 'main',
      title: worker.plan || brief.slice(0, 72) || `worker ${worker.workerId}`,
      body: formatPrBody(worker, evidence, pushed),
      number: this.lastPr.get(worker.workerId)?.number,
    });
    this.lastPush.set(worker.workerId, pushed);
    this.lastPr.set(worker.workerId, pr);
    const ci = this.ports.git.ciLink(repo, pushed.sha);
    evidence.push({ kind: 'artifact', label: 'CI', body: ci, path: pr.url });

    await enter('ci-wait', `waiting on CI for ${pushed.sha.slice(0, 8)}`, {
      kind: 'ci',
      detail: ci,
    });
    return {
      progress: true,
      workspaceRef: handle.id,
      sandboxRef: boxId,
      memory: `pushed ${pushed.sha} pr=${pr.url}`,
      plan: `open-pr ${pr.url}`,
      usage: coded.usage,
      evidence,
      stepSignature: `loop:${event.type}:${pushed.sha}`,
      progressUpdate: {
        phase: 'ci-wait',
        waiting: { kind: 'ci', detail: ci },
        activity: `waiting on CI for ${pushed.sha.slice(0, 8)}`,
      },
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
      const parsed = parseMergeBound(bound);
      const sha = parsed?.sha;
      if (!pr || !sha) {
        const reason = 'MERGE_REFUSED missing head sha';
        return {
          progress: true,
          memory: reason,
          evidence: [{ kind: 'step', label: 'merge', body: reason }],
        };
      }
      if (this.ports.git.merge) {
        try {
          const receipt = ctx.worker.reviewReceipts?.find(
            (row) => row.sha === sha && row.verdict === 'CLEAR',
          );
          await this.ports.git.merge({
            repo: parsed?.repo || repo,
            number: parsed?.number ?? pr.number,
            sha,
            allowNoCi: ctx.worker.mandate.allowNoCi === true,
            receipt,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'MERGE_REFUSED';
          return {
            progress: true,
            memory: message,
            evidence: [{ kind: 'step', label: 'merge', body: message }],
          };
        }
      }
      return {
        progress: true,
        memory: `merged ${bound}`,
        evidence: [{ kind: 'step', label: 'merge', body: bound }],
      };
    }
    return { progress: true, memory: `approved ${kind}` };
  }

  private mappedUrl(repo: string): string {
    return typeof this.ports.repoUrl === 'function'
      ? this.ports.repoUrl(repo)
      : (this.ports.repoUrl ?? repo);
  }

  private async prepare(worker: WorkerRecord, repo: string): Promise<WorkspaceHandle> {
    const existing = worker.workspaceRef ? this.handles.get(worker.workspaceRef) : undefined;
    if (existing?.dir) return existing;
    const handle = await this.workspaces.prepare({
      tenantId: worker.tenantId,
      workerId: worker.workerId,
      repoUrl: this.mappedUrl(repo),
    });
    if (!handle.dir) throw new Error('CodingLoopHandler needs a git-clone workspace directory.');
    this.handles.set(handle.id, handle);
    return handle;
  }

  private resetLast(): void {
    this.lastTimings.materialize = 0;
    this.lastTimings.edit = 0;
    this.lastTimings.test = 0;
    this.lastTimings.diff = 0;
    this.lastExecs = [];
    this.lastPatch = '';
    this.lastPublishDir = null;
    this.lastUsage = undefined;
  }

  private async timed<T>(
    phase: 'materialize' | 'edit' | 'test' | 'diff',
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.lastTimings[phase] += Date.now() - started;
    }
  }
}

export function mergeBoundText(repo: string, number: number, sha: string): string {
  return `Merge pull request #${number} in ${repo} at ${sha}`;
}

export function mergeAction(repo: string, number: number, sha: string): ProposedAction {
  return { kind: 'merge', boundText: mergeBoundText(repo, number, sha) };
}

/** Parses `Merge pull request #N in owner/name at <sha>`. */
export function parseMergeBound(
  boundText: string,
): { repo: string; number: number; sha: string } | undefined {
  const match = /^Merge pull request #(\d+) in (\S+) at ([0-9a-f]{7,40})$/i.exec(boundText.trim());
  if (!match) return undefined;
  return { number: Number(match[1]), repo: match[2] as string, sha: match[3] as string };
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

function boxTest(
  ran: { stdout: string; stderr: string; exitCode: number },
  command: string,
): TestResult {
  const stdout = ran.stdout.trimEnd();
  const stderr = ran.stderr.trimEnd();
  return {
    ok: ran.exitCode === 0,
    output: [
      `exit=${ran.exitCode}`,
      `stdout: ${stdout || '(empty)'}`,
      `stderr: ${stderr || '(empty)'}`,
    ].join('\n'),
    command,
  };
}

export function formatModelUsage(usage: {
  tokens?: number;
  usdMicros?: number;
  inputTokens?: number;
  outputTokens?: number;
}): string {
  const parts = [
    usage.inputTokens !== undefined ? `input=${usage.inputTokens}` : undefined,
    usage.outputTokens !== undefined ? `output=${usage.outputTokens}` : undefined,
    `tokens=${usage.tokens ?? 0}`,
    `usd_micros=${usage.usdMicros ?? 0}`,
    usage.usdMicros !== undefined
      ? `usd=${((usage.usdMicros ?? 0) / 1_000_000).toFixed(6)}`
      : undefined,
  ].filter(Boolean);
  return parts.join(' ');
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
