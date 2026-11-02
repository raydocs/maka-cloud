/**
 * Command allow/deny for BYOM. Denylist always wins. The first binary must
 * be on the allowlist. Shells (`sh`/`bash`) stay allowlisted so SandboxPort
 * `cmd` strings work; the denylist is then the last line on the full string.
 */

export interface CommandPolicy {
  allowBinaries: string[];
  deny: RegExp[];
  maxRuntimeSeconds: number;
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
  'sh',
  'bash',
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
  'env',
  'which',
  'test',
];

export const DEFAULT_MAX_RUNTIME_SECONDS = 15 * 60;

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  allowBinaries: [...DEFAULT_ALLOWED_BINARIES],
  deny: [...DEFAULT_DENIED_COMMANDS],
  maxRuntimeSeconds: DEFAULT_MAX_RUNTIME_SECONDS,
};

export type CommandDecision =
  | { ok: true; binary: string; timeoutSeconds: number }
  | { ok: false; reason: 'denied' | 'not_allowlisted'; binary?: string };

export function firstBinary(cmd: string): string | undefined {
  const parts = cmd.trim().split(/\s+/);
  for (const part of parts) {
    if (!part) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue;
    const base = part.split(/[/\\]/).pop();
    return base || undefined;
  }
  return undefined;
}

export function decideCommand(
  cmd: string,
  policy: CommandPolicy = DEFAULT_COMMAND_POLICY,
  timeoutSeconds?: number,
): CommandDecision {
  const binary = firstBinary(cmd);
  for (const rule of policy.deny) {
    if (rule.test(cmd)) return { ok: false, reason: 'denied', binary };
  }
  if (!binary) return { ok: false, reason: 'not_allowlisted' };
  const allowed = policy.allowBinaries.map((name) => name.toLowerCase());
  if (!allowed.includes(binary.toLowerCase())) {
    return { ok: false, reason: 'not_allowlisted', binary };
  }
  const timeout = Math.min(timeoutSeconds ?? policy.maxRuntimeSeconds, policy.maxRuntimeSeconds);
  return { ok: true, binary, timeoutSeconds: timeout };
}
