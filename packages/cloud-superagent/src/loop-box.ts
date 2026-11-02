import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxExecResult, SandboxPort } from './sandbox.js';

const run = promisify(execFile);

/** Relative to the sandbox cwd (FakeSandbox root / Instabox home). */
export const BOX_REPO = 'maka-loop/repo';

export function isPublicCloneUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

/** https without userinfo, or an absolute local path / file:// for tests. */
export function assertSafeCloneTarget(url: string): string {
  if (isPublicCloneUrl(url)) return url;
  if (url.startsWith('file://')) {
    const path = url.slice('file://'.length);
    if (!path.startsWith('/') || path.includes('..') || path.includes('\0')) {
      throw new Error('file clone URL must be an absolute path without ..');
    }
    return path;
  }
  if (url.startsWith('/') && !url.includes('..') && !url.includes('\0') && !url.includes(' ')) {
    return url;
  }
  throw new Error(
    'Clone URL must be http(s) without credentials, or an absolute local path. Tokens never go in the box.',
  );
}

export function safeRelPath(rel: string): string {
  if (!rel || rel.includes('..') || rel.startsWith('/') || rel.includes('\0')) {
    throw new Error(`refusing unsafe box path ${rel}`);
  }
  return rel;
}

export async function packTar(dir: string): Promise<Buffer> {
  const { stdout } = await run('tar', ['-czf', '-', '-C', dir, '.'], {
    encoding: 'buffer',
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export interface BoxExecLog {
  cmd: string;
  cwd?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function formatBoxExec(log: BoxExecLog, clip = 800): string {
  const stdout = clipText(log.stdout, clip);
  const stderr = clipText(log.stderr, clip);
  return [
    `$ ${log.cmd}${log.cwd ? `  (cwd=${log.cwd})` : ''}`,
    `exit=${log.exitCode}`,
    `stdout: ${stdout || '(empty)'}`,
    `stderr: ${stderr || '(empty)'}`,
  ].join('\n');
}

export function formatBoxExecSummary(logs: readonly BoxExecLog[]): string {
  if (logs.length === 0) return '(no box execs)';
  return logs
    .map((log) => `${log.cmd}  exit=${log.exitCode}${log.cwd ? ` cwd=${log.cwd}` : ''}`)
    .join('\n');
}

/**
 * Reset `dir` to HEAD (clean checkout), then apply the box's
 * `git diff --cached`. Whatever ran the tests is what ships.
 */
export async function applyBoxPatch(dir: string, patch: string): Promise<void> {
  await run('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', 'reset', '--hard', 'HEAD']);
  await run('git', ['-C', dir, 'clean', '-fd']);
  if (!patch.trim()) return;
  const patchDir = await mkdtemp(join(tmpdir(), 'maka-box-patch-'));
  const patchFile = join(patchDir, 'box.patch');
  await writeFile(patchFile, patch);
  try {
    await run('git', [
      '-C',
      dir,
      '-c',
      'core.hooksPath=/dev/null',
      'apply',
      '--whitespace=nowarn',
      patchFile,
    ]);
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(
      `box patch did not apply to the clean host checkout: ${err.stderr || err.stdout || err.message}`,
    );
  } finally {
    await rm(patchDir, { recursive: true, force: true });
  }
}

/**
 * Untrusted work inside the sandbox: materialize the repo, apply host-computed
 * edits, run install/test, pull a diff back. Secrets stay on the host.
 */
export class BoxWorkspace {
  readonly execs: BoxExecLog[] = [];

  constructor(
    private readonly sandbox: SandboxPort,
    private readonly machineId: string,
  ) {}

  async materialize(source: { clone?: string; hostDir?: string }): Promise<'clone' | 'upload'> {
    await this.sandbox.ensureRunning(this.machineId);
    const wiped = await this.exec('rm -rf maka-loop && mkdir -p maka-loop');
    if (wiped.exitCode !== 0) throw new Error(`box mkdir failed: ${tail(wiped)}`);
    if (source.clone) {
      const target = assertSafeCloneTarget(source.clone);
      const cloned = await this.exec(`git clone --depth 1 ${shellQuote(target)} ${BOX_REPO}`, {
        timeoutSeconds: 120,
      });
      if (cloned.exitCode !== 0) throw new Error(`box clone failed: ${tail(cloned)}`);
      return 'clone';
    }
    if (!source.hostDir) throw new Error('BoxWorkspace.materialize needs clone or hostDir.');
    const tgz = await packTar(source.hostDir);
    const put = await this.exec('mkdir -p maka-loop && base64 -d > maka-loop/src.tgz', {
      stdin: tgz.toString('base64'),
    });
    if (put.exitCode !== 0) throw new Error(`box upload failed: ${tail(put)}`);
    const extract = await this.exec(
      `mkdir -p ${BOX_REPO} && tar -xzf maka-loop/src.tgz -C ${BOX_REPO}`,
    );
    if (extract.exitCode !== 0) throw new Error(`box extract failed: ${tail(extract)}`);
    return 'upload';
  }

  async writeFiles(files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const safe = safeRelPath(rel);
      const dest = `${BOX_REPO}/${safe}`;
      const result = await this.exec(`mkdir -p "$(dirname "${dest}")" && base64 -d > "${dest}"`, {
        stdin: Buffer.from(content).toString('base64'),
      });
      if (result.exitCode !== 0) throw new Error(`box write ${safe} failed: ${tail(result)}`);
    }
  }

  async snapshot(): Promise<string> {
    const result = await this.exec(
      `cd ${BOX_REPO} && for f in *; do if [ -f "$f" ]; then echo "### $f"; head -c 4000 "$f"; echo; fi; done`,
    );
    return result.stdout;
  }

  async run(command: string, timeoutSeconds = 180): Promise<SandboxExecResult> {
    return this.exec(command, { cwd: BOX_REPO, timeoutSeconds });
  }

  async pullPatch(): Promise<string> {
    const result = await this.exec(
      `cd ${BOX_REPO} && git add -A && git -c core.hooksPath=/dev/null diff --cached`,
    );
    return result.stdout;
  }

  private async exec(
    cmd: string,
    extras: { stdin?: string; timeoutSeconds?: number; cwd?: string } = {},
  ): Promise<SandboxExecResult> {
    const result = await this.sandbox.exec(this.machineId, { cmd, ...extras });
    this.execs.push({
      cmd,
      ...(extras.cwd ? { cwd: extras.cwd } : {}),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return result;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tail(result: SandboxExecResult): string {
  return `${result.stderr}${result.stdout}`.trim().slice(0, 400);
}

function clipText(text: string, max: number): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}
