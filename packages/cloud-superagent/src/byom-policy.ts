/**
 * Command allow/deny for BYOM. Denylist always wins. argv[0] (basename) must
 * match the allowlist exactly. Shells and wrappers are not on the default
 * list; they require a per-device `allowShell` switch. `SandboxPort` `cmd`
 * strings are tokenized and exec'd as argv — never via `sh -c` unless that
 * switch is on.
 */

export interface CommandPolicy {
  allowBinaries: string[];
  deny: RegExp[];
  maxRuntimeSeconds: number;
  /** Per-call override. Device records own the real switch (default false). */
  allowShell?: boolean;
}

export const DEFAULT_DENIED_COMMANDS: readonly RegExp[] = [
  /\bsudo\b/i,
  /\bdoas\b/i,
  /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)/i,
  /\bcurl\b[\s\S]*169\.254\.169\.254/i,
  /\bwget\b[\s\S]*169\.254\.169\.254/i,
  /\bnc\s/i,
  /\bncat\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bsftp\b/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bdiskutil\b/i,
  /\blaunchctl\b/i,
  /\bosascript\b/i,
  /\bsecurity\s+(add|find|delete|dump)/i,
  /\bdefaults\s+write\b/i,
  /\bdscl\b/i,
  /\bcsrutil\b/i,
  /\bkill(?:all)?\s+-9\s+1\b/i,
  /:\(\)\{:\|:&\};:/,
];

export const DEFAULT_ALLOWED_BINARIES: readonly string[] = [
  'git',
  'npm',
  'npx',
  'node',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'pip',
  'pip3',
  'cargo',
  'go',
  'make',
  'xcodebuild',
  'swift',
  'clang',
  'gcc',
  'g++',
  'rustc',
  'java',
  'javac',
  'ruby',
  'bundle',
  'pod',
  'fastlane',
  'xcrun',
  'swiftlint',
  'prettier',
  'eslint',
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'pytest',
  'ruff',
  'mypy',
  'echo',
  'ls',
  'cat',
  'true',
  'false',
  'uname',
  'pwd',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'tar',
  'unzip',
  'zip',
  'diff',
  'patch',
  'rg',
  'grep',
  'find',
  'sed',
  'awk',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'which',
  'test',
];

/** Interpreters that take a script or `-c`. Matched on argv[0] basename. */
export const SHELL_INTERPRETERS: readonly string[] = [
  'sh',
  'bash',
  'zsh',
  'dash',
  'ash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'mksh',
  'busybox',
];

/** Wrappers that can launch an arbitrary argv, including a shell. */
export const SHELL_WRAPPERS: readonly string[] = [
  'env',
  'xargs',
  'nice',
  'nohup',
  'stdbuf',
  'time',
  'timeout',
  'watch',
  'script',
  'unbuffer',
  'rlwrap',
];

const SHELL_INTERPRETER_SET = new Set(SHELL_INTERPRETERS);
const SHELL_WRAPPER_SET = new Set(SHELL_WRAPPERS);
const SHELL_META = new Set(['|', '&', ';', '<', '>', '`', '\n', '\r']);

export const DEFAULT_MAX_RUNTIME_SECONDS = 15 * 60;

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  allowBinaries: [...DEFAULT_ALLOWED_BINARIES],
  deny: [...DEFAULT_DENIED_COMMANDS],
  maxRuntimeSeconds: DEFAULT_MAX_RUNTIME_SECONDS,
  allowShell: false,
};

export type CommandRefusal = 'denied' | 'not_allowlisted' | 'shell_not_allowed';

export type CommandDecision =
  | { ok: true; binary: string; timeoutSeconds: number; viaShell: boolean; argv: string[] }
  | { ok: false; reason: CommandRefusal; binary?: string };

export interface ParsedCommand {
  argv: string[];
  needsShell: boolean;
}

export function commandBasename(part: string): string {
  const trimmed = part.trim();
  if (!trimmed) return '';
  return trimmed.split(/[/\\]/).pop() ?? '';
}

export function isShellInterpreter(name: string): boolean {
  return SHELL_INTERPRETER_SET.has(name.toLowerCase());
}

export function isShellWrapper(name: string): boolean {
  return SHELL_WRAPPER_SET.has(name.toLowerCase());
}

/**
 * Tokenize a SandboxPort `cmd` string into argv without running a shell.
 * Quotes group arguments. Unquoted `| & ; < > \` $ \` and newlines mean
 * the string needs a shell. Quoted `$HOME` stays the literal `$HOME`.
 */
export function parseCommand(cmd: string): ParsedCommand {
  const argv: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  let needsShell = false;

  const flush = (): void => {
    if (!inToken) return;
    argv.push(current);
    current = '';
    inToken = false;
  };

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    if (ch === '\\' || ch === '$') {
      needsShell = true;
      current += ch;
      inToken = true;
      continue;
    }
    if (SHELL_META.has(ch)) {
      needsShell = true;
      flush();
      if ((ch === '>' || ch === '<' || ch === '&' || ch === '|') && cmd[i + 1] === ch) {
        i += 1;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) needsShell = true;
  flush();

  if (argv[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    needsShell = true;
  }

  return { argv, needsShell };
}

export function firstBinary(cmd: string): string | undefined {
  const { argv } = parseCommand(cmd);
  for (const part of argv) {
    if (!part) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue;
    const base = commandBasename(part);
    return base || undefined;
  }
  return undefined;
}

function allowlisted(argv0: string, binary: string, allow: readonly string[]): boolean {
  return allow.includes(binary) || allow.includes(argv0);
}

export function decideCommand(
  cmd: string,
  policy: CommandPolicy = DEFAULT_COMMAND_POLICY,
  timeoutSeconds?: number,
): CommandDecision {
  const allowShell = policy.allowShell === true;
  const parsed = parseCommand(cmd);
  const argv0 = parsed.argv[0];
  const binary = argv0 ? commandBasename(argv0) : undefined;

  for (const rule of policy.deny) {
    if (rule.test(cmd)) return { ok: false, reason: 'denied', binary };
  }

  if (!binary || !argv0) return { ok: false, reason: 'not_allowlisted' };

  const shellBinary = isShellInterpreter(binary) || isShellWrapper(binary);
  const needsShell = parsed.needsShell || shellBinary;

  if (needsShell && !allowShell) {
    return { ok: false, reason: 'shell_not_allowed', binary };
  }

  if (!shellBinary && !allowlisted(argv0, binary, policy.allowBinaries)) {
    return { ok: false, reason: 'not_allowlisted', binary };
  }

  const timeout = Math.min(timeoutSeconds ?? policy.maxRuntimeSeconds, policy.maxRuntimeSeconds);
  return {
    ok: true,
    binary,
    timeoutSeconds: timeout,
    viaShell: needsShell && allowShell,
    argv: parsed.argv,
  };
}
