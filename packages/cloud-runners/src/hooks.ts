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
/** How much of a finished step's recorded result goes back to the agent that asks for it again. */
const COMPLETED_OUTPUT_CHARS = 1_000;

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
 * Shell commands that only look, decided by the program and its arguments, not by the program
 * alone: `find . -delete`, `sort -o file` and `git branch -D x` start with a harmless program and
 * are not harmless. Each entry says which argument lists of its program are safe; a program, a
 * subcommand or a form that is not here is `never`.
 */
const WITHOUT =
  (...banned: string[]) =>
  (args: string[]) =>
    !args.some((arg) => banned.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
const ANYTHING = () => true;
const GIT_READ_BANNED = WITHOUT('--output', '--ext-diff', '--open-files-in-pager', '-O');
const GIT_BRANCH_LISTING = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all']);

const READ_ONLY_PROGRAMS: Record<string, (args: string[]) => boolean> = {
  ls: ANYTHING,
  cat: ANYTHING,
  head: ANYTHING,
  tail: ANYTHING,
  wc: ANYTHING,
  pwd: ANYTHING,
  echo: ANYTHING,
  printf: ANYTHING,
  grep: ANYTHING,
  stat: ANYTHING,
  diff: ANYTHING,
  which: ANYTHING,
  true: ANYTHING,
  false: ANYTHING,
  sleep: ANYTHING,
  test: ANYTHING,
  '[': ANYTHING,
  // Runs a program when given arguments; bare, it prints the environment.
  env: (args) => args.length === 0,
  rg: WITHOUT('--pre', '--pre-glob', '--hostname-bin'),
  tree: WITHOUT('-o'),
  file: WITHOUT('-C', '--compile'),
  sort: WITHOUT('-o', '--output', '--compress-program'),
  // A second positional argument is the file it writes.
  uniq: (args) => args.filter((arg) => !arg.startsWith('-')).length <= 1,
  // Setting the clock takes a bare argument; only a `+format` or none reads it.
  date: (args) =>
    args.every((arg) => arg.startsWith('+') || ['-u', '--utc', '-I', '-R'].includes(arg)),
  find: WITHOUT(
    '-delete',
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
    '-fprint',
    '-fprint0',
    '-fprintf',
    '-fls',
  ),
  tsc: ANYTHING,
  pytest: ANYTHING,
};

/** `<program> <subcommand>` pairs and their argument rules, for programs that do more than look. */
const READ_ONLY_SUBCOMMANDS: Record<string, Record<string, (args: string[]) => boolean>> = {
  git: {
    status: GIT_READ_BANNED,
    diff: GIT_READ_BANNED,
    log: GIT_READ_BANNED,
    show: GIT_READ_BANNED,
    'rev-parse': GIT_READ_BANNED,
    'ls-files': GIT_READ_BANNED,
    blame: GIT_READ_BANNED,
    describe: GIT_READ_BANNED,
    // Listing only: -d, -D, -m, -c and a bare name create, move or delete branches.
    branch: (args) => args.every((arg) => GIT_BRANCH_LISTING.has(arg)),
    remote: (args) => args.length === 1 && args[0] === '-v',
  },
  // Runs the project's own script of that name: repeatable, as a build or test is.
  npm: {
    test: ANYTHING,
    run: (args) => /^(?:test|build|lint|typecheck|check)(?::\S+)?$/u.test(args[0] ?? ''),
  },
  pnpm: { test: ANYTHING, lint: ANYTHING, typecheck: ANYTHING, build: ANYTHING },
  yarn: { test: ANYTHING, lint: ANYTHING, typecheck: ANYTHING, build: ANYTHING },
  npx: {
    tsc: ANYTHING,
    biome: ANYTHING,
    eslint: ANYTHING,
    vitest: ANYTHING,
    jest: ANYTHING,
  },
  node: { '--test': ANYTHING },
  cargo: { test: ANYTHING, check: ANYTHING, build: ANYTHING, clippy: ANYTHING },
  go: { test: ANYTHING, build: ANYTHING, vet: ANYTHING },
  make: { test: ANYTHING, check: ANYTHING, lint: ANYTHING, build: ANYTHING },
};
const SHELL_OPERATORS = /[;&|<>`$\n\r\\(){}]/u;

/** Whether a tool call can be run again after a crash. Unknown tools and commands are `never`. */
export function replayClassOf(toolName: string, toolInput: unknown): ReplayClass {
  if (SAFE_TOOLS.has(toolName)) return 'safe';
  if (toolName === 'Bash') {
    const command = commandOf(toolInput);
    if (command !== undefined && !SHELL_OPERATORS.test(command) && readsOnly(command)) {
      return 'safe';
    }
  }
  return 'never';
}

/** One plain command whose program and arguments are on the list above. Quotes are looked through. */
function readsOnly(command: string): boolean {
  const words = command
    .trim()
    .split(/\s+/u)
    .map((word) => word.replaceAll(/["']/gu, ''));
  const [program, ...args] = words;
  if (program === undefined || program === '') return false;
  const subcommands = READ_ONLY_SUBCOMMANDS[program];
  if (subcommands !== undefined) {
    const [subcommand, ...rest] = args;
    const rule = subcommand === undefined ? undefined : subcommands[subcommand];
    return rule !== undefined && Object.hasOwn(subcommands, subcommand as string) && rule(rest);
  }
  return (
    Object.hasOwn(READ_ONLY_PROGRAMS, program) && (READ_ONLY_PROGRAMS[program]?.(args) ?? false)
  );
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

/** The most message text one hook answer carries; the rest waits for the next step. */
export const STEER_CONTEXT_CHARS = 16_000;

/** Where messages for the agent wait until a step ends. */
export interface SteerInbox {
  /** Takes the messages that fit in `maxChars` (the first always does), oldest first. */
  take(maxChars: number): Array<{ steerId: string; text: string }>;
}

/**
 * The text the agent reads. The messages are the owner's own words, sent while it worked; they are
 * marked as such so they are not mistaken for the output of the tool that just ran.
 */
export function steerContext(
  messages: ReadonlyArray<{ text: string }>,
  redact: (text: string) => string,
): string {
  const many = messages.length > 1;
  return [
    `The user sent you ${many ? `${messages.length} messages` : 'a message'} while you were working. ${
      many ? 'They are' : 'It is'
    } not part of the output of the step that just ended. Read ${many ? 'them' : 'it'} now and take ${
      many ? 'them' : 'it'
    } into account from your next step on:`,
    ...messages.map((message) => `<user_message>\n${redact(message.text)}\n</user_message>`),
  ].join('\n');
}

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
 * A step that cannot be recorded does not run, whatever its class: a crash would leave an effect
 * nobody knows about, and a `safe` step is only safe to repeat when the log knows it ran.
 */
export function stepHooks(
  steps: StepLog,
  redact: (text: string) => string,
  onProblem: (message: string) => void = () => undefined,
  inbox?: SteerInbox,
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
          return ALLOW;
        case 'running':
          // This attempt started the step and has seen no outcome: a second executor would do it
          // twice at once.
          return deny(
            'This step is already running. Wait for it to finish instead of starting it again.',
          );
        case 'completed':
          // A hook cannot hand the CLI a result in place of running the tool, so the recorded
          // one goes in the reason, and the step does not run again.
          return deny(
            `This step already ${result.ok ? 'finished' : 'failed'} and is not run again.${
              result.output === undefined
                ? ''
                : ` What it reported: ${redact(result.output).slice(0, COMPLETED_OUTPUT_CHARS)}`
            }`,
          );
        case 'interrupted':
          return deny(
            'This step was cut off by a restart and may or may not have taken effect. Check the real state before trying it again.',
          );
        case 'refused':
          return deny(`This step was not started: ${redact(result.reason)}`);
      }
    } catch (error) {
      onProblem(`a step could not be recorded: ${redact(errorMessage(error))}`);
      // Whatever the class: a step with no intent on record is a step the log cannot account for,
      // and "it can run again" is only true of one the log knows about.
      return deny(
        'This step was not started: the step log is not available, so what the step does could not be recorded. Try again in a moment.',
      );
    }
    return ALLOW;
  };

  /**
   * What the owner sent while the agent worked, put in front of it after the step that just ended.
   * A broken inbox never breaks the step: the messages stay where they are for the next one.
   */
  function waiting(event: 'PostToolUse' | 'PostToolUseFailure') {
    if (!inbox) return ALLOW;
    try {
      const messages = inbox.take(STEER_CONTEXT_CHARS);
      if (messages.length === 0) return ALLOW;
      return {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: steerContext(messages, redact),
        },
      };
    } catch (error) {
      onProblem(`a message for the agent could not be handed over: ${redact(errorMessage(error))}`);
      return ALLOW;
    }
  }

  const post: HookCallback = async (input) => {
    const call = input as PostToolUseHookInput;
    await record(call.tool_use_id, { status: 'done' });
    return waiting('PostToolUse');
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
    return waiting('PostToolUseFailure');
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
