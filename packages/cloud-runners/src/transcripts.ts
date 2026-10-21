import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { TaskId } from '@maka-cloud/orchestrator';
import type { RemoteMachine } from './machine.js';
import { errorMessage } from './shell.js';

/**
 * The conversation of a Claude task, kept off the sandbox. The Agent SDK mirrors every transcript
 * line the CLI writes to a `SessionStore`; this is what that store keeps, so a task can go on from
 * where it was on a sandbox that has none of its files. Lines are the CLI's own JSON lines, as
 * text, already scrubbed of the run's secrets.
 */
export interface TranscriptStore {
  /**
   * Adds lines to the end of a transcript. A line that carries a `uuid` already stored for the
   * same transcript is skipped, so a batch sent again lands once. Rejects with `TranscriptFull`
   * past the task's cap, and for a project key other than the one the task's transcripts use.
   */
  append(taskId: TaskId, key: TranscriptKey, lines: readonly TranscriptLine[]): Promise<void>;
  /** Where a task's main transcript of a session is kept, and how many lines it has. */
  locate(taskId: TaskId, sessionId: string): Promise<TranscriptInfo | undefined>;
  /** A page of a main transcript: lines after `cursor` (the `next` of the page before), up to ~`maxBytes`. */
  read(taskId: TaskId, sessionId: string, cursor?: number, maxBytes?: number): Promise<TranscriptPage>;
  /** Removes everything kept for a task. */
  deleteTask(taskId: TaskId): Promise<void>;
}

export interface TranscriptKey {
  projectKey: string;
  sessionId: string;
  /** Set for a subagent's transcript. Kept, but not put back on a sandbox. */
  subpath?: string;
}

export interface TranscriptLine {
  /** One line of the CLI's JSONL file, without its newline. */
  json: string;
  uuid?: string;
}

export interface TranscriptInfo {
  projectKey: string;
  lines: number;
}

export interface TranscriptPage {
  lines: string[];
  /** Pass as `cursor` for the next page; absent on the last. */
  next?: number;
}

export interface TranscriptLimits {
  /** One line of the CLI's file (a tool result can be large). */
  maxLineBytes: number;
  /** One append. */
  maxBatchBytes: number;
  /** Everything one task keeps. */
  maxTaskBytes: number;
  /** Distinct sessions (and subagent transcripts) one task keeps. */
  maxTranscripts: number;
}

export const DEFAULT_TRANSCRIPT_LIMITS: TranscriptLimits = {
  maxLineBytes: 16 * 1024 * 1024,
  maxBatchBytes: 64 * 1024 * 1024,
  maxTaskBytes: 256 * 1024 * 1024,
  maxTranscripts: 64,
};

export class TranscriptFull extends Error {
  override name = 'TranscriptFull';
}

/** A directory name under `projects/`: the CLI's name for the working directory, plain characters only. */
const PROJECT_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,219}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SUBPATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*){0,3}$/u;

export const isProjectKey = (value: string): boolean => PROJECT_KEY.test(value) && value !== '..';
export const isSessionId = (value: string): boolean => SESSION_ID.test(value);

/** Whether a key may be stored; the reason when not. */
export function keyProblem(key: TranscriptKey): string | undefined {
  if (!isProjectKey(key.projectKey)) return 'its project key is not a plain directory name';
  if (!isSessionId(key.sessionId)) return 'its session id is not a UUID';
  if (key.subpath !== undefined && (key.subpath.length > 200 || !SUBPATH.test(key.subpath))) {
    return 'its subpath is not a plain relative path';
  }
  return undefined;
}

/** Shared by the stores: the part of an append that does not depend on where lines are kept. */
export function checkAppend(
  key: TranscriptKey,
  lines: readonly TranscriptLine[],
  limits: TranscriptLimits,
): void {
  const problem = keyProblem(key);
  if (problem !== undefined) throw new Error(`transcript refused: ${problem}`);
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line.json);
    if (size > limits.maxLineBytes) {
      throw new TranscriptFull(`a transcript line of ${size} bytes is over the ${limits.maxLineBytes} cap`);
    }
    bytes += size;
  }
  if (bytes > limits.maxBatchBytes) {
    throw new TranscriptFull(`a batch of ${bytes} bytes is over the ${limits.maxBatchBytes} cap`);
  }
}

interface MemoryTranscript {
  projectKey: string;
  subpath: string;
  lines: string[];
  uuids: Set<string>;
}

/** Transcripts in memory, for tests and for a deployment that does not restore onto new sandboxes. */
export class MemoryTranscriptStore implements TranscriptStore {
  private readonly tasks = new Map<
    TaskId,
    { projectKey: string; bytes: number; transcripts: Map<string, MemoryTranscript> }
  >();
  private readonly limits: TranscriptLimits;

  constructor(limits: Partial<TranscriptLimits> = {}) {
    this.limits = { ...DEFAULT_TRANSCRIPT_LIMITS, ...limits };
  }

  async append(taskId: TaskId, key: TranscriptKey, lines: readonly TranscriptLine[]): Promise<void> {
    checkAppend(key, lines, this.limits);
    let task = this.tasks.get(taskId);
    if (task && task.projectKey !== key.projectKey) {
      throw new Error('transcript refused: the task keeps its transcripts under another project key');
    }
    const name = `${key.sessionId}/${key.subpath ?? ''}`;
    const known = task?.transcripts.get(name);
    if (!known && (task?.transcripts.size ?? 0) >= this.limits.maxTranscripts) {
      throw new TranscriptFull(`the task already keeps ${this.limits.maxTranscripts} transcripts`);
    }
    const fresh = lines.filter((line) => line.uuid === undefined || !known?.uuids.has(line.uuid));
    const added = fresh.reduce((sum, line) => sum + Buffer.byteLength(line.json), 0);
    if ((task?.bytes ?? 0) + added > this.limits.maxTaskBytes) {
      throw new TranscriptFull(`the task's transcripts are over the ${this.limits.maxTaskBytes} byte cap`);
    }
    if (!task) {
      task = { projectKey: key.projectKey, bytes: 0, transcripts: new Map() };
      this.tasks.set(taskId, task);
    }
    const transcript = known ?? {
      projectKey: key.projectKey,
      subpath: key.subpath ?? '',
      lines: [],
      uuids: new Set<string>(),
    };
    task.transcripts.set(name, transcript);
    const seen = new Set<string>();
    for (const line of lines) {
      if (line.uuid !== undefined) {
        if (transcript.uuids.has(line.uuid) || seen.has(line.uuid)) continue;
        seen.add(line.uuid);
        transcript.uuids.add(line.uuid);
      }
      transcript.lines.push(line.json);
      task.bytes += Buffer.byteLength(line.json);
    }
  }

  async locate(taskId: TaskId, sessionId: string): Promise<TranscriptInfo | undefined> {
    const transcript = this.tasks.get(taskId)?.transcripts.get(`${sessionId}/`);
    return transcript && { projectKey: transcript.projectKey, lines: transcript.lines.length };
  }

  async read(
    taskId: TaskId,
    sessionId: string,
    cursor = 0,
    maxBytes = 1024 * 1024,
  ): Promise<TranscriptPage> {
    const all = this.tasks.get(taskId)?.transcripts.get(`${sessionId}/`)?.lines ?? [];
    const lines: string[] = [];
    let bytes = 0;
    let index = cursor;
    while (index < all.length && (lines.length === 0 || bytes < maxBytes)) {
      const line = all[index] as string;
      lines.push(line);
      bytes += Buffer.byteLength(line);
      index++;
    }
    return index < all.length ? { lines, next: index } : { lines };
  }

  async deleteTask(taskId: TaskId): Promise<void> {
    this.tasks.delete(taskId);
  }
}

export interface MirrorOptions {
  taskId: TaskId;
  store: TranscriptStore;
  /** Takes the run's secrets out of a line before it is kept. */
  redact(text: string): string;
  /** A batch that was refused or could not be kept. The SDK also reports it in its message stream. */
  onProblem?(message: string): void;
}

/**
 * The SDK's `SessionStore` for one task. The SDK hands it every line the CLI writes to its
 * transcript, and it keeps them in the task's `TranscriptStore`: only under this task, only for
 * keys that are plain names, every line scrubbed of the run's secrets first, and in the order they
 * came.
 *
 * It never gives lines back to the SDK. A resumed conversation is put on the sandbox by
 * `restoreTranscript` before the CLI starts, where the CLI reads it as it reads any of its own
 * files; `load` answers "nothing", so the SDK does not unpack a copy on the host and does not
 * rewrite the CLI's environment.
 */
export function transcriptSessionStore(options: MirrorOptions): SessionStore {
  const { taskId, store, redact } = options;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      const run = async (): Promise<void> => {
        const lines = entries.map((entry) => scrubbed(entry, redact));
        await store.append(taskId, key, lines);
      };
      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next.catch((error) => {
        options.onProblem?.(`a transcript batch was not kept: ${errorMessage(error)}`);
        throw error;
      });
    },
    async load(): Promise<null> {
      return null;
    },
  };
}

/**
 * One entry as a transcript line. The text is scrubbed whole and must still be one JSON object, or
 * the entry is refused (an entry that cannot be scrubbed safely is not kept).
 */
function scrubbed(entry: SessionStoreEntry, redact: (text: string) => string): TranscriptLine {
  if (typeof entry !== 'object' || entry === null || typeof entry.type !== 'string') {
    throw new Error('transcript refused: an entry is not an object with a type');
  }
  const text = redact(JSON.stringify(entry));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('transcript refused: an entry could not be scrubbed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('transcript refused: an entry could not be scrubbed');
  }
  const uuid = (parsed as { uuid?: unknown }).uuid;
  return typeof uuid === 'string' && uuid.length <= 100 ? { json: text, uuid } : { json: text };
}

export type RestoreResult =
  /** The sandbox has the transcript, as far as the store knows it. */
  | { status: 'present'; projectKey: string }
  | { status: 'restored'; projectKey: string; lines: number }
  /** The store has nothing for this session. */
  | { status: 'absent' };

/**
 * Makes the sandbox hold a session's transcript before the CLI is asked to resume it. A sandbox
 * that has the file with at least as many lines as the store is left alone (it is the same
 * conversation, and its own copy may be ahead of what was mirrored); otherwise the store's copy is
 * written in place, atomically.
 */
export async function restoreTranscript(input: {
  machine: RemoteMachine;
  store: TranscriptStore;
  taskId: TaskId;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<RestoreResult> {
  const { machine, store, taskId, sessionId } = input;
  if (!isSessionId(sessionId)) return { status: 'absent' };
  const info = await store.locate(taskId, sessionId);
  if (!info) return { status: 'absent' };
  if (!isProjectKey(info.projectKey)) {
    throw new Error('the stored transcript is under a project key that is not a plain name');
  }
  if ((await machine.transcriptLines(taskId, info.projectKey, sessionId)) >= info.lines) {
    return { status: 'present', projectKey: info.projectKey };
  }
  await machine.installTranscript({
    dirName: taskId,
    projectKey: info.projectKey,
    sessionId,
    bytes: transcriptBytes(store, taskId, sessionId),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { status: 'restored', projectKey: info.projectKey, lines: info.lines };
}

async function* transcriptBytes(
  store: TranscriptStore,
  taskId: TaskId,
  sessionId: string,
): AsyncGenerator<Buffer> {
  let cursor: number | undefined;
  for (;;) {
    const page = await store.read(taskId, sessionId, cursor);
    if (page.lines.length > 0) yield Buffer.from(`${page.lines.join('\n')}\n`, 'utf8');
    if (page.next === undefined) return;
    cursor = page.next;
  }
}
