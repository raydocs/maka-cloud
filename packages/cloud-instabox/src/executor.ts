import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import {
  ATTACHMENT_MIME_SNIFF_BYTES,
  MAX_READ_IMAGE_BYTES,
  READ_IMAGE_TOO_LARGE_MESSAGE,
  sniffAttachmentMimeType,
} from '@maka/core/attachments';
import { GrepSearchError, searchFiles, type GrepRunner } from '@maka/runtime/grep-search';
import { ImageFileError, isSupportedImagePath, validateImageBytes } from '@maka/runtime/image-file';
import { readTextLineWindow } from '@maka/runtime/text-line-window';
import type {
  WorkspaceExecInput,
  WorkspaceExecResult,
  WorkspaceExecutor,
  WorkspaceExecutorFacts,
  WorkspaceGlobInput,
  WorkspaceGlobResult,
  WorkspaceGrepInput,
  WorkspaceGrepResult,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceResolvePathInput,
  WorkspaceResolvePathResult,
  WorkspaceWriteFileInput,
  WorkspaceWriteFileResult,
  WorkspaceWriteLockKeyInput,
  WorkspaceWriteLockKeyResult,
} from '@maka/runtime/workspace-executor';
import { Minimatch } from 'minimatch';
import type { SandboxApi } from './api.js';
import type { InstaboxExecRequest, InstaboxExecResult } from './client.js';
import { InstaboxApiError } from './errors.js';
import { INSTABOX_WORKSPACE_EXECUTOR_FACTS } from './facts.js';
import {
  containmentError,
  isInsidePosix,
  isPosixAbsolute,
  literalGlobPrefix,
  shellQuote,
} from './paths.js';
import {
  KILL_SCRIPT,
  LIST_SCRIPT,
  READ_CHUNK_SCRIPT,
  REMOVE_TEMP_SCRIPT,
  RESOLVE_SCRIPT,
  WRITE_CHUNK_SCRIPT,
  newMarker,
  parseFramed,
} from './scripts.js';

/** `GET /files` returns at most this many bytes of text. */
const FILES_API_MAX_BYTES = 256 * 1024;
/** Raw bytes per read or write chunk: 512 KiB is ~683 KiB of base64, under exec's 1 MiB caps. */
const CHUNK_BYTES = 512 * 1024;
/** Whole-file ceiling for chunked reads and writes through the sandbox. */
export const INSTABOX_MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_EXEC_TIMEOUT_SECONDS = 600;
const HELPER_TIMEOUT_SECONDS = 120;
const KILL_TIMEOUT_MS = 15_000;
const MAX_CMD_CHARS = 60_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface InstaboxWorkspaceExecutorOptions {
  client: SandboxApi;
  /** Sandbox id (`m_...`) or name. */
  machineId: string;
  /** Overrides the default facts, for example when the sandbox owner enabled Vault items. */
  facts?: WorkspaceExecutorFacts;
}

interface ResolvedPath {
  root: string;
  path: string;
  type: string;
  size: number;
}

type ResolveMode = 'existing' | 'writable' | 'entry';

export class InstaboxWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts: WorkspaceExecutorFacts;
  private readonly client: SandboxApi;
  private readonly machineId: string;

  constructor(options: InstaboxWorkspaceExecutorOptions) {
    this.client = options.client;
    this.machineId = options.machineId;
    this.facts = options.facts ?? INSTABOX_WORKSPACE_EXECUTOR_FACTS;
  }

  async exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    if (input.argv || input.fdInputs?.length) {
      throw new Error(
        'An instabox sandbox runs commands through bash -lc; argv and fd inputs from a host sandbox wrapper are not supported.',
      );
    }
    if (!isPosixAbsolute(input.cwd)) {
      throw new Error(`Command cwd must be an absolute sandbox path; received ${input.cwd}.`);
    }
    const token = randomUUID();
    const request: InstaboxExecRequest = {
      cmd: input.command,
      cwd: input.cwd,
      envs: { ...cleanEnv(input.env), MAKA_EXEC_TOKEN: token },
      timeoutSeconds: toTimeoutSeconds(input.timeoutMs),
    };
    let result: InstaboxExecResult;
    try {
      result = await this.run(request, input.abortSignal);
    } catch (error) {
      if (!input.abortSignal?.aborted) throw error;
      // Dropping the HTTP request does not stop the remote process group.
      await this.killByToken(token);
      return { stdout: '', stderr: '', exitCode: 130, timedOut: false, aborted: true };
    }
    // Output arrives whole, not as a stream, so it is forwarded once after the command exits.
    if (result.stdout) input.emitOutput?.('stdout', result.stdout);
    if (result.stderr) input.emitOutput?.('stderr', result.stderr);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.timedOut ? 124 : result.exitCode,
      // instabox reports one flag for both streams.
      stdoutTruncated: result.truncated,
      stderrTruncated: result.truncated,
      timedOut: result.timedOut,
      aborted: false,
    };
  }

  async resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    const resolved = await this.resolveInScope('existing', input);
    return { path: resolved.path };
  }

  async resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    const resolved = await this.resolveInScope('writable', input);
    return { path: resolved.path };
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    // Canonicalised like the resolvers but with no containment check: escapes are
    // rejected by the resolvers inside the lock.
    const resolved = await this.resolve(input.semantics === 'entry' ? 'entry' : 'writable', input);
    return { key: `${this.machineId}:${resolved.path}` };
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    const signal = input.abortSignal;
    // Containment first: GET /files reads as root, exec runs as the dev user.
    const file = await this.resolveInScope('existing', {
      cwd: input.cwd,
      path: input.path,
      label: 'Read',
      scope: 'workspace',
    });
    if (!file.type.startsWith('regular')) {
      throw Object.assign(new Error(`Not a regular file: ${file.path}`), { code: 'EISDIR' });
    }
    if (file.size > INSTABOX_MAX_FILE_BYTES) {
      throw new Error(
        `File is ${file.size} bytes; reading through the sandbox is limited to ${INSTABOX_MAX_FILE_BYTES} bytes. Read a slice with a shell command instead.`,
      );
    }
    const purpose = input.imagePurpose === 'chat' ? 'chat' : 'model';

    if (isSupportedImagePath(file.path)) {
      return validateImageBytes(await this.readBytes(file.path, file.size, signal), purpose);
    }
    if (file.size === 0) return { content: '' };
    if (file.size <= FILES_API_MAX_BYTES) {
      const text = await this.readTextViaFilesApi(file, signal);
      if (text !== undefined)
        return { content: readTextLineWindow(text, input.offset, input.limit) };
    }
    const bytes = await this.readBytes(file.path, file.size, signal);
    const sniffed = sniffAttachmentMimeType(bytes.subarray(0, ATTACHMENT_MIME_SNIFF_BYTES));
    if (sniffed && sniffed !== 'application/pdf') return validateImageBytes(bytes, purpose);
    return {
      content: readTextLineWindow(Buffer.from(bytes).toString('utf8'), input.offset, input.limit),
    };
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    if (!isPosixAbsolute(input.path)) {
      throw new Error(`Write path must be an absolute sandbox path; received ${input.path}.`);
    }
    const bytes = Buffer.from(input.content, 'utf8');
    if (bytes.length > INSTABOX_MAX_FILE_BYTES) {
      throw new Error(
        `Content is ${bytes.length} bytes; writing through the sandbox is limited to ${INSTABOX_MAX_FILE_BYTES} bytes.`,
      );
    }
    // Same directory as the target so the final rename is atomic.
    const tmp = posix.join(posix.dirname(input.path), `.maka-${randomUUID()}.tmp`);
    const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    for (let index = 0; index < chunks; index++) {
      const slice = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      let result: InstaboxExecResult;
      try {
        result = await this.run({
          cmd: WRITE_CHUNK_SCRIPT,
          envs: {
            MAKA_TMP: tmp,
            MAKA_PATH: input.path,
            MAKA_SIZE: String(bytes.length),
            MAKA_FIRST: index === 0 ? '1' : '0',
            MAKA_LAST: index === chunks - 1 ? '1' : '0',
          },
          stdin: slice.toString('base64'),
          timeoutSeconds: HELPER_TIMEOUT_SECONDS,
        });
      } catch (error) {
        await this.removeTemp(tmp);
        throw error;
      }
      if (result.exitCode !== 0 || result.timedOut) {
        await this.removeTemp(tmp);
        throw new Error(writeFailureMessage(input.path, index, chunks, result));
      }
    }
    return { ok: true, path: input.path, bytes: bytes.length };
  }

  async globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    const limit = input.limit ?? 200;
    let listing;
    try {
      listing = await this.runFramed(
        LIST_SCRIPT,
        { MAKA_CWD: input.cwd, MAKA_SUB: literalGlobPrefix(input.pattern) || '.' },
        input.abortSignal,
      );
    } catch (error) {
      if (!(error instanceof OutputTooLargeError)) throw error;
      throw new Error(
        'Glob matched against more entries than one sandbox response can carry (1 MiB). Use a more specific pattern or a deeper Glob cwd.',
      );
    }
    const { fields, result } = listing;
    if (fields[0] === 'ERR') throw pathError(fields[1] ?? 'glob failed', input.cwd);
    if (fields.at(-1) !== '0') {
      throw new Error(`Glob listing failed: ${tail(result.stderr) || 'find exited non-zero'}`);
    }
    const matcher = new Minimatch(input.pattern, { dot: false });
    const matches = fields
      .slice(0, -1)
      .map((entry) => (entry.startsWith('./') ? entry.slice(2) : entry))
      .filter((entry) => entry !== '' && entry !== '.' && matcher.match(entry))
      .sort();
    return { files: matches.slice(0, limit), truncated: matches.length > limit };
  }

  async grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    const run: GrepRunner = async (request) => {
      if (request.abortSignal?.aborted) {
        throw new GrepSearchError('Grep was cancelled; search totals are unknown.');
      }
      const cmd = `rg ${request.args.map(shellQuote).join(' ')}`;
      if (cmd.length > MAX_CMD_CHARS) {
        throw new GrepSearchError('Grep pattern is too long to send to the sandbox.');
      }
      let result: InstaboxExecResult;
      try {
        result = await this.run(
          { cmd, cwd: request.cwd, timeoutSeconds: toTimeoutSeconds(request.timeoutMs) },
          request.abortSignal,
        );
      } catch (error) {
        if (request.abortSignal?.aborted) {
          throw new GrepSearchError('Grep was cancelled; search totals are unknown.');
        }
        throw error;
      }
      if (result.timedOut) {
        throw new GrepSearchError(
          'Grep timed out; search totals are unknown. Retry with a narrower path or glob.',
        );
      }
      if (result.exitCode === 127) {
        throw new Error(
          'ripgrep (rg) is not installed in the instabox sandbox. Install it there, or search with a shell command.',
        );
      }
      if (result.truncated) {
        throw new GrepSearchError(
          'Grep output exceeded one sandbox response (1 MiB); search totals are unknown. Retry with a narrower path or glob.',
        );
      }
      try {
        request.onStdout(Buffer.from(result.stdout, 'utf8'));
      } catch {
        throw new GrepSearchError(
          'Grep returned invalid search output; search totals are unknown.',
        );
      }
      return { exitCode: result.exitCode, stderrTail: result.stderr.slice(-16 * 1024) };
    };
    return await searchFiles({ ...input, executable: 'rg' }, run);
  }

  /** exec, resuming a paused sandbox once if it answers `machine_not_running`. */
  private async run(
    request: InstaboxExecRequest,
    signal?: AbortSignal,
  ): Promise<InstaboxExecResult> {
    const options = signal ? { signal } : {};
    try {
      return await this.client.exec(this.machineId, request, options);
    } catch (error) {
      if (!(error instanceof InstaboxApiError) || error.code !== 'machine_not_running') throw error;
      // 409 means the command was never started, so one retry cannot run it twice.
      await this.client.ensureRunning(this.machineId, options);
      return await this.client.exec(this.machineId, request, options);
    }
  }

  private async runFramed(
    script: string,
    envs: Record<string, string>,
    signal?: AbortSignal,
    stdin?: string,
  ): Promise<{ fields: string[]; result: InstaboxExecResult }> {
    const marker = newMarker();
    const result = await this.run(
      {
        cmd: script,
        envs: { ...envs, MAKA_M: marker },
        timeoutSeconds: HELPER_TIMEOUT_SECONDS,
        ...(stdin === undefined ? {} : { stdin }),
      },
      signal,
    );
    const fields = parseFramed(result.stdout, marker);
    if (!fields && result.truncated) throw new OutputTooLargeError();
    if (!fields || (result.exitCode !== 0 && fields[0] !== 'ERR')) {
      throw new Error(
        `instabox helper script failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout)}`,
      );
    }
    return { fields, result };
  }

  private async resolve(
    mode: ResolveMode,
    input: { cwd: string; path: string },
    signal?: AbortSignal,
  ): Promise<ResolvedPath> {
    if (!isPosixAbsolute(input.cwd)) {
      throw new Error(`Session cwd must be an absolute sandbox path; received ${input.cwd}.`);
    }
    const { fields } = await this.runFramed(
      RESOLVE_SCRIPT,
      { MAKA_CWD: input.cwd, MAKA_PATH: input.path, MAKA_MODE: mode },
      signal,
    );
    if (fields[0] !== 'OK') throw pathError(fields[1] ?? 'path resolution failed', input.path);
    const [, root = '', path = '', stat = ''] = fields;
    const [type = '', size = '0'] = stat.split('|');
    return { root, path, type, size: Number(size) };
  }

  private async resolveInScope(
    mode: 'existing' | 'writable',
    input: WorkspaceResolvePathInput,
  ): Promise<ResolvedPath> {
    if (input.scope === 'host') {
      throw Object.assign(
        new Error(
          `${input.label} cannot use host path scope: an instabox sandbox has no host paths.`,
        ),
        { code: 'EACCES' },
      );
    }
    const resolved = await this.resolve(mode, input);
    if (!isInsidePosix(resolved.root, resolved.path)) {
      throw containmentError(resolved.root, input.path, resolved.path, input.label);
    }
    return resolved;
  }

  /**
   * Text from `GET /files`, or undefined when the response cannot be trusted as the
   * whole file. The API gives an empty `content` for both an empty text file and a
   * binary one, so non-empty files with empty content, binary files, truncated
   * responses and byte-count mismatches all fall back to an exec read.
   */
  private async readTextViaFilesApi(
    file: ResolvedPath,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    // GET /files reads as root, so it only ever sees a path already checked against the root.
    if (!isInsidePosix(file.root, file.path)) {
      throw containmentError(file.root, file.path, file.path, 'Read');
    }
    const options = signal ? { signal } : {};
    let response;
    try {
      response = await this.client.getFile(this.machineId, file.path, options);
    } catch (error) {
      if (!(error instanceof InstaboxApiError) || error.code !== 'machine_not_running') throw error;
      await this.client.ensureRunning(this.machineId, options);
      response = await this.client.getFile(this.machineId, file.path, options);
    }
    if (response.type !== 'file' || response.binary || response.truncated) return undefined;
    const content = response.content;
    if (!content || Buffer.byteLength(content, 'utf8') !== file.size) return undefined;
    return content;
  }

  private async readBytes(path: string, size: number, signal?: AbortSignal): Promise<Uint8Array> {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, size - offset);
      const { fields } = await this.runFramed(
        READ_CHUNK_SCRIPT,
        { MAKA_PATH: path, MAKA_OFFSET: String(offset), MAKA_LENGTH: String(length) },
        signal,
      );
      if (fields[0] !== 'OK') throw pathError(fields[1] ?? 'read failed', path);
      parts.push(Buffer.from(fields[1] ?? '', 'base64'));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== size) {
      throw new Error(
        `File changed while it was being read (expected ${size} bytes, received ${bytes.length}); retry.`,
      );
    }
    return bytes;
  }

  private async removeTemp(tmp: string): Promise<void> {
    try {
      await this.run({
        cmd: REMOVE_TEMP_SCRIPT,
        envs: { MAKA_TMP: tmp },
        timeoutSeconds: 30,
      });
    } catch {
      // Best effort: the original error is the one worth reporting.
    }
  }

  private async killByToken(token: string): Promise<void> {
    try {
      await this.client.exec(
        this.machineId,
        { cmd: KILL_SCRIPT, envs: { MAKA_KILL_TOKEN: token }, timeoutSeconds: 15 },
        { signal: AbortSignal.timeout(KILL_TIMEOUT_MS) },
      );
    } catch {
      // The sandbox may be gone; there is nothing further to stop.
    }
  }
}

class OutputTooLargeError extends Error {
  constructor() {
    super('The sandbox response was cut off at 1 MiB.');
  }
}

function cleanEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' && ENV_NAME.test(name)) clean[name] = value;
  }
  return clean;
}

function toTimeoutSeconds(timeoutMs: number): number {
  return Math.min(MAX_EXEC_TIMEOUT_SECONDS, Math.max(1, Math.ceil(timeoutMs / 1000)));
}

function tail(text: string): string {
  return text.trim().slice(-500);
}

function pathError(message: string, path: string): Error {
  const code = /no such file|not a directory/i.test(message) ? 'ENOENT' : 'EIO';
  return Object.assign(new Error(message || `Cannot resolve ${path}`), { code });
}

function writeFailureMessage(
  path: string,
  index: number,
  chunks: number,
  result: InstaboxExecResult,
): string {
  const reason = result.timedOut
    ? 'the sandbox timed out'
    : ((
        {
          1: 'could not create a temporary file beside the target (missing directory or no permission)',
          2: 'the chunk could not be decoded or written',
          3: 'the written size did not match the content size',
          4: 'the final rename failed',
        } as Record<number, string>
      )[result.exitCode] ?? `exit code ${result.exitCode}`);
  const detail = tail(result.stderr);
  return `Write to ${path} failed at chunk ${index + 1} of ${chunks}: ${reason}${
    detail ? ` (${detail})` : ''
  }. The existing file was not modified.`;
}
