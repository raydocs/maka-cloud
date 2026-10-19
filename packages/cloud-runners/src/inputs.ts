import type { TaskId } from '@maka-cloud/orchestrator';
import { type TaskState, isTerminal } from '@maka-cloud/orchestrator';

/**
 * A brief asks for files of other, finished tasks with lines at its very start:
 *
 *     maka-inputs: <taskId> <path> [<path> ...]
 *
 * Paths are relative to that task's workspace. The runner copies them into this task's
 * `workspace/inputs/<taskId>/` before the CLI starts. The brief is written by the delegating
 * parent, and a model can quote hostile text in it, so only the leading block counts: a line of
 * this form anywhere else (also quoted, indented or in a list) fails the task instead of being
 * obeyed or ignored.
 */
export const INPUTS_PREFIX = 'maka-inputs:';

export const MAX_INPUT_LINES = 4;
export const MAX_INPUT_PATHS = 32;
const MAX_PATH_CHARS = 200;

export interface InputRequest {
  source: TaskId;
  paths: string[];
}

export type ParsedInputs = { ok: true; requests: InputRequest[] } | { ok: false; reason: string };

const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/** Components start with a letter, digit or underscore: no `.`, `..` or hidden files. */
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/u;
const LOOKS_LIKE_DIRECTIVE = /^[\s>*+\-#]*maka-inputs\s*:/iu;

export function parseInputRequests(brief: string): ParsedInputs {
  const lines = brief.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  let index = 0;
  while (index < lines.length && (lines[index] as string).trim() === '') index++;

  const bySource = new Map<TaskId, string[]>();
  let count = 0;
  for (; index < lines.length && (lines[index] as string).startsWith(INPUTS_PREFIX); index++) {
    count++;
    if (count > MAX_INPUT_LINES)
      return refused(`more than ${MAX_INPUT_LINES} ${INPUTS_PREFIX} lines`);
    const parts = (lines[index] as string).slice(INPUTS_PREFIX.length).split(' ');
    // Exactly one space after the colon and between words: anything looser is not a request.
    if (parts[0] !== '' || parts.length < 3 || parts.slice(1).some((part) => part === '')) {
      return refused(
        `${INPUTS_PREFIX} line ${count} is not "${INPUTS_PREFIX} <taskId> <path> ..."`,
      );
    }
    const [, source, ...paths] = parts as [string, string, ...string[]];
    if (!SOURCE_ID.test(source))
      return refused(`${INPUTS_PREFIX} line ${count} has an invalid task id`);
    for (const path of paths) {
      if (path.length > MAX_PATH_CHARS || !PATH.test(path)) {
        return refused(
          `${INPUTS_PREFIX} line ${count} has a path that is not a plain relative path`,
        );
      }
    }
    const known = bySource.get(source) ?? [];
    for (const path of paths) if (!known.includes(path)) known.push(path);
    bySource.set(source, known);
  }
  for (; index < lines.length; index++) {
    if (LOOKS_LIKE_DIRECTIVE.test(lines[index] as string)) {
      return refused(`${INPUTS_PREFIX} lines are only read at the very start of the brief`);
    }
  }

  let paths = 0;
  for (const list of bySource.values()) paths += list.length;
  if (paths > MAX_INPUT_PATHS) return refused(`more than ${MAX_INPUT_PATHS} input paths`);
  return { ok: true, requests: [...bySource].map(([source, list]) => ({ source, paths: list })) };
}

function refused(reason: string): ParsedInputs {
  return { ok: false, reason };
}

/**
 * Decides whether `target` may read the files of `source`. Returns undefined to allow, or the reason
 * it may not. The runner has already checked that both belong to the same tenant and that the
 * source's files are on the target's sandbox.
 */
export interface InputPolicy {
  check(input: {
    target: TaskId;
    source: TaskId;
  }): Promise<string | undefined> | string | undefined;
}

/** What `sameConversationInputPolicy` needs from the orchestrator. */
export interface TaskDirectory {
  rootSessionOfTask(taskId: TaskId): string | undefined;
  taskStateOf(taskId: TaskId): TaskState | undefined;
}

/**
 * A task may read the files of a task of its own conversation (the tree under the same root
 * session) once that task has ended. A task never reads its own files this way, and a task of
 * another conversation, or one the orchestrator does not know, is refused whatever its tenant.
 * Ending is final, so checking it here cannot be undone by a later event.
 */
export function sameConversationInputPolicy(orchestrator: TaskDirectory): InputPolicy {
  return {
    check({ target, source }) {
      if (source === target) return 'a task cannot take its own files as inputs';
      const root = orchestrator.rootSessionOfTask(target);
      if (root === undefined || orchestrator.rootSessionOfTask(source) !== root) {
        return `task ${source} is not part of this conversation`;
      }
      const state = orchestrator.taskStateOf(source);
      if (state === undefined || !isTerminal(state)) return `task ${source} has not finished`;
      return undefined;
    },
  };
}
