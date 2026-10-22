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
import { STEER_CLOSING, steerOpening } from './steer-receipts.js';

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
 * are not harmless. Each program says which flags it may have, and any flag not named is `never`:
 * an allowlist, because a list of banned flags is beaten by what the program also accepts (an
 * abbreviated long option, `git diff --ext-dif`, or a short option with its value attached,
 * `sort -oout.txt`). A program, a subcommand or a form that is not here is `never`.
 *
 * What the lists cannot see is configuration: `git status`, `git diff`, `git log` and `git show`
 * run programs named in `.git/config` and `.gitattributes` (`core.fsmonitor`, `diff.external`,
 * `diff.<driver>.textconv`), both in the agent's workspace, and `-c` is refused but the file is
 * not. "Only looks" is a statement about the command line, not a guarantee against a
 * repository's own configuration.
 */
interface Flags {
  /** Single letters that may be given alone or together (`-la`). */
  short?: string;
  /** Single letters that take a value, attached (`-A3`) or as the next word. */
  shortValue?: string;
  /** Long options exactly as written, with no value (`--all`), or with one (`--color` / `--color=auto`). */
  long?: readonly string[];
  /** Long options that take a value, `--name=value` or `--name value`. */
  longValue?: readonly string[];
  /** A bare count as the option, `-5`. */
  count?: boolean;
  /** Attached forms like `-U3`, `-S<text>`: a letter followed by any value. */
  attached?: string;
}

const flagsOnly =
  (allowed: Flags) =>
  (args: string[]): boolean => {
    const short = new Set(allowed.short ?? '');
    const shortValue = new Set(allowed.shortValue ?? '');
    const attached = new Set(allowed.attached ?? '');
    const long = new Set(allowed.long ?? []);
    const longValue = new Set(allowed.longValue ?? []);
    let rest = false;
    for (const arg of args) {
      if (rest || !arg.startsWith('-') || arg === '-') continue;
      if (arg === '--') {
        rest = true;
        continue;
      }
      if (arg.startsWith('--')) {
        const eq = arg.indexOf('=');
        const name = eq === -1 ? arg : arg.slice(0, eq);
        if (long.has(name) || longValue.has(name)) continue;
        return false;
      }
      if (allowed.count === true && /^-\d+$/u.test(arg)) continue;
      let ok = true;
      for (let i = 1; i < arg.length && ok; i++) {
        const letter = arg.charAt(i);
        if (short.has(letter)) continue;
        if (shortValue.has(letter) || attached.has(letter)) {
          // What follows is this option's value, up to the end of the word.
          if (!/^[\w.,:+@%/=*?^$-]*$/u.test(arg.slice(i + 1))) ok = false;
          break;
        }
        ok = false;
      }
      if (!ok) return false;
    }
    return true;
  };

const ANYTHING = () => true;
const COLOR = ['--color', '--no-color'] as const;
const GIT_PRETTY = ['--oneline', '--graph', '--decorate', '--no-decorate', '--abbrev-commit'];
const GIT_DIFF_FLAGS: Flags = {
  short: 'pRwbMC',
  attached: 'U',
  count: false,
  long: [
    ...COLOR,
    '--cached',
    '--staged',
    '--stat',
    '--numstat',
    '--shortstat',
    '--name-only',
    '--name-status',
    '--summary',
    '--patch',
    '--no-patch',
    '--check',
    '--minimal',
    '--patience',
    '--histogram',
    '--no-ext-diff',
    '--ignore-all-space',
    '--ignore-space-change',
    '--ignore-blank-lines',
    '--word-diff',
    '--raw',
    '--merge-base',
    '--full-index',
    '--binary',
  ],
  longValue: ['--unified', '--stat-width', '--word-diff', '--diff-filter', '--relative'],
};
const GIT_LOG_FLAGS: Flags = {
  ...GIT_DIFF_FLAGS,
  short: 'pRwbMCs',
  shortValue: 'n',
  attached: 'USG',
  count: true,
  long: [
    ...(GIT_DIFF_FLAGS.long ?? []),
    ...GIT_PRETTY,
    '--all',
    '--branches',
    '--tags',
    '--remotes',
    '--no-merges',
    '--merges',
    '--first-parent',
    '--follow',
    '--reverse',
    '--topo-order',
    '--date-order',
    '--no-walk',
    '--source',
    '--left-right',
    '--cherry-pick',
    '--root',
    '--patch-with-stat',
  ],
  longValue: [
    ...(GIT_DIFF_FLAGS.longValue ?? []),
    '--max-count',
    '--skip',
    '--since',
    '--until',
    '--after',
    '--before',
    '--author',
    '--committer',
    '--grep',
    '--format',
    '--pretty',
    '--date',
    '--abbrev',
    '--decorate',
  ],
};
const GIT_BRANCH_LISTING = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all']);

const READ_ONLY_PROGRAMS: Record<string, (args: string[]) => boolean> = {
  ls: flagsOnly({
    short: 'aAdFhlLrRStu1ipsnkcgGHUvxX',
    long: [
      '--all',
      '--almost-all',
      '--directory',
      '--classify',
      '--human-readable',
      '--recursive',
      '--reverse',
      '--size',
      '--inode',
      '--dereference',
      ...COLOR,
    ],
  }),
  cat: flagsOnly({
    short: 'nbsAeEtTv',
    long: [
      '--number',
      '--number-nonblank',
      '--squeeze-blank',
      '--show-all',
      '--show-ends',
      '--show-tabs',
    ],
  }),
  head: flagsOnly({
    short: 'qv',
    shortValue: 'nc',
    count: true,
    long: ['--quiet', '--verbose'],
    longValue: ['--lines', '--bytes'],
  }),
  tail: flagsOnly({
    short: 'qv',
    shortValue: 'nc',
    count: true,
    long: ['--quiet', '--verbose'],
    longValue: ['--lines', '--bytes'],
  }),
  wc: flagsOnly({
    short: 'lwcmL',
    long: ['--lines', '--words', '--bytes', '--chars', '--max-line-length'],
  }),
  pwd: flagsOnly({ short: 'LP', long: ['--logical', '--physical'] }),
  echo: ANYTHING,
  printf: ANYTHING,
  grep: flagsOnly({
    short: 'ivnclLrRHhoqswxEFaI',
    shortValue: 'ABCmef',
    long: [
      ...COLOR,
      '--recursive',
      '--dereference-recursive',
      '--ignore-case',
      '--no-ignore-case',
      '--invert-match',
      '--line-number',
      '--count',
      '--files-with-matches',
      '--files-without-match',
      '--word-regexp',
      '--line-regexp',
      '--extended-regexp',
      '--fixed-strings',
      '--basic-regexp',
      '--no-messages',
      '--quiet',
      '--only-matching',
      '--with-filename',
      '--no-filename',
      '--text',
      '--null',
    ],
    longValue: [
      '--include',
      '--exclude',
      '--exclude-dir',
      '--max-count',
      '--context',
      '--after-context',
      '--before-context',
      '--binary-files',
      '--regexp',
      '--file',
    ],
    count: true,
  }),
  stat: flagsOnly({
    short: 'LftZ',
    shortValue: 'c',
    long: ['--dereference', '--file-system', '--terse'],
    longValue: ['--format', '--printf'],
  }),
  diff: flagsOnly({
    short: 'uqrNiwBbydE',
    attached: 'UC',
    long: [
      ...COLOR,
      '--unified',
      '--brief',
      '--recursive',
      '--ignore-case',
      '--new-file',
      '--side-by-side',
      '--ignore-all-space',
      '--ignore-space-change',
      '--ignore-blank-lines',
      '--text',
      '--normal',
    ],
    longValue: ['--unified', '--context', '--exclude', '--width'],
  }),
  which: flagsOnly({ short: 'a', long: ['--all'] }),
  true: ANYTHING,
  false: ANYTHING,
  sleep: ANYTHING,
  test: ANYTHING,
  '[': ANYTHING,
  // Runs a program when given arguments; bare, it prints the environment.
  env: (args) => args.length === 0,
  rg: flagsOnly({
    short: 'inNvwxlLcoHIsSuUFPzaEh',
    shortValue: 'tTgABCmefj',
    long: [
      ...COLOR,
      '--files',
      '--hidden',
      '--no-ignore',
      '--no-ignore-vcs',
      '--ignore-case',
      '--smart-case',
      '--case-sensitive',
      '--line-number',
      '--no-line-number',
      '--count',
      '--files-with-matches',
      '--files-without-match',
      '--fixed-strings',
      '--word-regexp',
      '--line-regexp',
      '--only-matching',
      '--with-filename',
      '--no-filename',
      '--no-heading',
      '--heading',
      '--follow',
      '--invert-match',
      '--multiline',
      '--text',
      '--type-list',
      '--no-messages',
    ],
    longValue: [
      '--glob',
      '--iglob',
      '--type',
      '--type-not',
      '--context',
      '--after-context',
      '--before-context',
      '--max-count',
      '--max-depth',
      '--regexp',
      '--file',
      '--sort',
      '--sortr',
      '--threads',
    ],
  }),
  tree: flagsOnly({
    short: 'adfFiqpugDsrCnthxl',
    shortValue: 'LIP',
    long: ['--dirsfirst', '--noreport', '--gitignore', '--charset'],
    longValue: ['--charset'],
  }),
  file: flagsOnly({
    short: 'bisLzN',
    long: ['--brief', '--mime', '--mime-type', '--mime-encoding', '--dereference'],
  }),
  sort: flagsOnly({
    short: 'bdfghiMnrRuVcCsz',
    shortValue: 'kt',
    long: [
      '--unique',
      '--reverse',
      '--numeric-sort',
      '--ignore-case',
      '--check',
      '--stable',
      '--version-sort',
      '--human-numeric-sort',
      '--month-sort',
      '--general-numeric-sort',
      '--ignore-leading-blanks',
      '--dictionary-order',
      '--zero-terminated',
      '--random-sort',
    ],
    longValue: ['--field-separator', '--key'],
  }),
  // A second positional argument is the file it writes.
  uniq: (args) =>
    flagsOnly({ short: 'cdDiuz', long: ['--count', '--repeated', '--unique', '--ignore-case'] })(
      args,
    ) && args.filter((arg) => !arg.startsWith('-')).length <= 1,
  // Setting the clock takes a bare argument; only a `+format` or none reads it.
  date: (args) =>
    args.every((arg) => arg.startsWith('+') || ['-u', '--utc', '-I', '-R'].includes(arg)),
  find: findReads,
  tsc: ANYTHING,
  pytest: ANYTHING,
};

/** The tests and options of `find` that only look; an action (`-delete`, `-exec`, `-fprint`) is not one. */
const FIND_WORDS = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-type',
  '-maxdepth',
  '-mindepth',
  '-size',
  '-mtime',
  '-atime',
  '-ctime',
  '-mmin',
  '-amin',
  '-cmin',
  '-newer',
  '-empty',
  '-perm',
  '-user',
  '-group',
  '-regex',
  '-iregex',
  '-not',
  '-a',
  '-o',
  '-and',
  '-or',
  '-print',
  '-print0',
  '-prune',
  '-depth',
  '-xdev',
  '-mount',
  '-L',
  '-H',
  '-P',
  '-readable',
  '-writable',
  '-executable',
  '-true',
  '-false',
  '-regextype',
  '-follow',
  '!',
]);

function findReads(args: string[]): boolean {
  return args.every((arg) => !(arg.startsWith('-') || arg === '!') || FIND_WORDS.has(arg));
}

/** `<program> <subcommand>` pairs and their argument rules, for programs that do more than look. */
const READ_ONLY_SUBCOMMANDS: Record<string, Record<string, (args: string[]) => boolean>> = {
  git: {
    status: flagsOnly({
      short: 'sbvu',
      attached: 'u',
      long: [
        ...COLOR,
        '--short',
        '--branch',
        '--porcelain',
        '--long',
        '--ignored',
        '--untracked-files',
        '--ahead-behind',
        '--no-ahead-behind',
        '--renames',
        '--no-renames',
      ],
      longValue: ['--porcelain', '--untracked-files', '--ignored'],
    }),
    diff: flagsOnly(GIT_DIFF_FLAGS),
    log: flagsOnly(GIT_LOG_FLAGS),
    show: flagsOnly(GIT_LOG_FLAGS),
    'rev-parse': flagsOnly({
      long: [
        '--show-toplevel',
        '--abbrev-ref',
        '--short',
        '--git-dir',
        '--absolute-git-dir',
        '--is-inside-work-tree',
        '--is-bare-repository',
        '--verify',
        '--symbolic-full-name',
        '--show-prefix',
        '--show-cdup',
        '--git-common-dir',
        '--quiet',
      ],
      longValue: ['--abbrev-ref', '--short'],
    }),
    'ls-files': flagsOnly({
      short: 'comdsuvtkz',
      long: [
        '--cached',
        '--others',
        '--modified',
        '--deleted',
        '--stage',
        '--unmerged',
        '--ignored',
        '--exclude-standard',
        '--full-name',
        '--directory',
        '--no-empty-directory',
        '--eol',
      ],
    }),
    blame: flagsOnly({
      short: 'wepsln',
      shortValue: 'LMC',
      long: [
        '--porcelain',
        '--line-porcelain',
        '--show-email',
        '--show-name',
        '--show-number',
        '--root',
      ],
      longValue: ['--date'],
    }),
    describe: flagsOnly({
      long: [
        '--tags',
        '--always',
        '--long',
        '--all',
        '--contains',
        '--dirty',
        '--first-parent',
        '--exact-match',
      ],
      longValue: ['--abbrev', '--match', '--exclude', '--candidates', '--dirty'],
    }),
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
/**
 * The shell expands these before the program sees them, and the agent writes the workspace: a file
 * named `-delete` turns `find . *` into `find . -delete`. Quoted, they are plain text. A tilde
 * counts only where the shell expands it (the start of a word, after `=` or `:`), not in `HEAD~1`.
 */
const SHELL_EXPANSIONS = /[*?[]|(?:^|[\s=:])~/u;

/** Whether the command has a glob or tilde the shell would expand; an unbalanced quote counts. */
function expandsUnquoted(command: string): boolean {
  const bare = command.replaceAll(/"[^"]*"|'[^']*'/gu, '');
  return /["']/u.test(bare) || SHELL_EXPANSIONS.test(bare);
}

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
    return (
      rule !== undefined &&
      Object.hasOwn(subcommands, subcommand as string) &&
      (rule === ANYTHING || !expandsUnquoted(command)) &&
      rule(rest)
    );
  }
  const rule = Object.hasOwn(READ_ONLY_PROGRAMS, program) ? READ_ONLY_PROGRAMS[program] : undefined;
  return rule !== undefined && (rule === ANYTHING || !expandsUnquoted(command)) && rule(args);
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
  /**
   * Takes the messages that fit in `maxChars` (the first always does), oldest first. `ref` is the
   * reference of the receipt kept for the handing, which the opening tag carries.
   */
  take(maxChars: number): Promise<Array<{ steerId: string; text: string; ref?: string }>>;
}

/**
 * The text the agent reads. The messages are the owner's own words, sent while it worked; they are
 * marked as such so they are not mistaken for the output of the tool that just ran.
 */
export function steerContext(
  messages: ReadonlyArray<{ steerId?: string; text: string; ref?: string }>,
  redact: (text: string) => string,
): string {
  const many = messages.length > 1;
  return [
    `The user sent you ${many ? `${messages.length} messages` : 'a message'} while you were working. ${
      many ? 'They are' : 'It is'
    } not part of the output of the step that just ended. Read ${many ? 'them' : 'it'} now and take ${
      many ? 'them' : 'it'
    } into account from your next step on:`,
    ...messages.map(
      (message) =>
        `${steerOpening(message.steerId, message.ref)}\n${redact(message.text)}\n${STEER_CLOSING}`,
    ),
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
  async function waiting(event: 'PostToolUse' | 'PostToolUseFailure') {
    if (!inbox) return ALLOW;
    try {
      const messages = await inbox.take(STEER_CONTEXT_CHARS);
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
