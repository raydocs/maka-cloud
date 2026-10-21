import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ReplayClass, StepLog } from '@maka-cloud/orchestrator';
import { errorMessage } from './shell.js';

/** How long the CLI waits for a hook to answer, in seconds. A step is one small append. */
const HOOK_TIMEOUT_SECONDS = 30;
const LABEL_CHARS = 120;
const KIND_CHARS = 40;

/** Tools that only read, search or keep notes. Running one again changes nothing. */
const SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'TodoRead',
  'WebSearch',
  'WebFetch',
  'BashOutput',
  'KillShell',
  'ExitPlanMode',
  // The files of the task's own workspace: the same edit again leaves the same file.
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  // A subagent's own tool calls are steps of their own.
  'Task',
  'Agent',
]);

/**
 * A shell command that only looks: one plain command, no pipes, redirects, substitutions or
 * separators, whose program and first argument are on this list. Anything else may do something
 * that must not happen twice (a push, a request, a message), so it is `never`.
 */
const READ_ONLY_COMMAND =
  /^(?:ls|cat|head|tail|wc|pwd|echo|printf|grep|rg|find|stat|file|diff|sort|uniq|tree|which|env|date|true|false|sleep|test|\[|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|blame|describe|remote\s+-v)|npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check)(?::\S+)?)|npx\s+(?:tsc|biome|eslint|vitest|jest)|node\s+--test|pnpm\s+(?:test|lint|typecheck|build)|yarn\s+(?:test|lint|typecheck|build)|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|build|vet)|pytest|tsc|make\s+(?:test|check|lint|build))(?:\s|$)/u;
const SHELL_OPERATORS = /[;&|<>`$\n\r\\(){}]/u;

/** Whether a tool call can be run again after a crash. Unknown tools and commands are `never`. */
export function replayClassOf(toolName: string, toolInput: unknown): ReplayClass {
  if (SAFE_TOOLS.has(toolName)) return 'safe';
  if (toolName === 'Bash') {
    const command = commandOf(toolInput);
    if (
      command !== undefined &&
      !SHELL_OPERATORS.test(command) &&
      READ_ONLY_COMMAND.test(command.trim())
    ) {
      return 'safe';
    }
  }
  return 'never';
}

function commandOf(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

/** The step kind for a tool: `tool:<name>`, with only plain characters of the name. */
export function kindOf(toolName: string): string {
  return `tool:${toolName.replace(/[^A-Za-z0-9_.-]/gu, '_')}`.slice(0, KIND_CHARS);
}

/**
 * What a person reading the step list sees: the tool and the one thing it works on. The agent's
 * own text is untrusted and may hold secrets, so it goes through `redact`, and the log keeps one
 * short printable line (the log cleans control characters; the cut is made here, after redacting).
 */
export function labelOf(
  toolName: string,
  toolInput: unknown,
  redact: (text: string) => string,
): string {
  const input =
    typeof toolInput === 'object' && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : {};
  const subject = [
    input.command,
    input.file_path,
    input.path,
    input.url,
    input.pattern,
    input.query,
    input.description,
  ].find((value) => typeof value === 'string' && value !== '');
  const name = toolName.replace(/[^A-Za-z0-9_.-]/gu, '_');
  const text = typeof subject === 'string' ? `${name}: ${subject}` : name;
  return redact(text).replace(/\s+/gu, ' ').trim().slice(0, LABEL_CHARS);
}

const ALLOW = {};

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * The CLI's hooks that write the step log. Before a tool runs, its intent is made durable and only
 * then does the hook answer, so the CLI cannot start a tool whose intent is not on record. After the
 * tool, its outcome is recorded; the outcome carries no tool output (the log holds metadata, the
 * transcript holds content).
 *
 * A step that cannot be recorded does not run when it is `never`: a crash would then leave an
 * effect nobody knows about. A `safe` one runs, since it can run again.
 */
export function stepHooks(
  steps: StepLog,
  redact: (text: string) => string,
  onProblem: (message: string) => void = () => undefined,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const pre: HookCallback = async (input) => {
    const call = input as PreToolUseHookInput;
    const replay = replayClassOf(call.tool_name, call.tool_input);
    try {
      const result = await steps.intent({
        stepId: call.tool_use_id,
        kind: kindOf(call.tool_name),
        replay,
        label: labelOf(call.tool_name, call.tool_input, redact),
      });
      switch (result.status) {
        case 'recorded':
        case 'running':
        case 'completed':
          return ALLOW;
        case 'interrupted':
          return deny(
            'This step was cut off by a restart and may or may not have taken effect. Check the real state before trying it again.',
          );
        case 'refused':
          return deny(`This step was not started: ${redact(result.reason)}`);
      }
    } catch (error) {
      onProblem(`a step could not be recorded: ${redact(errorMessage(error))}`);
      if (replay === 'never') {
        return deny(
          'This step was not started: the step log is not available, so its effect could not be recovered after a crash.',
        );
      }
      return ALLOW;
    }
    return ALLOW;
  };

  const post: HookCallback = async (input) => {
    const call = input as PostToolUseHookInput;
    await record(call.tool_use_id, { status: 'done' });
    return ALLOW;
  };

  const failed: HookCallback = async (input) => {
    const call = input as PostToolUseFailureHookInput;
    await record(call.tool_use_id, {
      status: 'failed',
      output: redact(String(call.error ?? ''))
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 500),
    });
    return ALLOW;
  };

  async function record(
    stepId: string,
    result: { status: 'done' | 'failed'; output?: string },
  ): Promise<void> {
    try {
      await steps.outcome(stepId, result);
    } catch (error) {
      // The step stays "running" in the log; the next attempt marks it interrupted, which is the
      // safe reading of a step whose end nobody saw.
      onProblem(`a step outcome could not be recorded: ${redact(errorMessage(error))}`);
    }
  }

  return {
    PreToolUse: [{ hooks: [pre], timeout: HOOK_TIMEOUT_SECONDS }],
    PostToolUse: [{ hooks: [post], timeout: HOOK_TIMEOUT_SECONDS }],
    PostToolUseFailure: [{ hooks: [failed], timeout: HOOK_TIMEOUT_SECONDS }],
  };
}
