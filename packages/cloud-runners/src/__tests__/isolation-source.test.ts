import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// These sources export scripts as string/template literals, sometimes with fixed shell fragments.
const STRING = /^(?:`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*")/u;

function builtArguments(text: string): boolean {
  // Skip quoted strings and comments; a template or a + anywhere in the balanced call is refused.
  const tokens =
    /'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[`+()]/gu;
  let depth = 1;
  for (const [token] of text.matchAll(tokens)) {
    if (token === '(') depth++;
    if (token === ')' && --depth === 0) return false;
    if (token === '`' || token === '+') return true;
  }
  return false;
}

function problems(text: string, file: string): string[] {
  const found: string[] = [];
  if (/\bgetFile\s*\(/u.test(text)) found.push('getFile call');
  for (const match of text.matchAll(/\bexport\s+const\s+(\w+_SCRIPT)(?:\s*:\s*string)?\s*=\s*/gu)) {
    const shell = STRING.exec(text.slice(match.index + match[0].length))?.[0] ?? '';
    // Both `set -u` and the existing `set -eu` enable nounset. Remove the opening quote first.
    if (!/(?:^|[\n;])\s*set\s+-[a-z]*u[a-z]*(?:\s|;|$)/u.test(shell.slice(1, -1))) {
      found.push(`${match[1]} lacks set -u`);
    }
  }
  if (basename(file) !== 'machine.ts') {
    for (const match of text.matchAll(/\basAgentUser\s*\(/gu)) {
      if (builtArguments(text.slice(match.index + match[0].length))) {
        found.push('asAgentUser with a built string');
      }
    }
  }
  return found;
}

async function sources(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(path)));
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

test('runner and playbook sources preserve the isolation boundaries (F12)', async () => {
  const violations: string[] = [];
  for (const relative of ['../../src/', '../../../cloud-playbooks/src/']) {
    for (const file of await sources(fileURLToPath(new URL(relative, import.meta.url)))) {
      for (const problem of problems(await readFile(file, 'utf8'), file)) {
        violations.push(`${file}: ${problem}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the source guard recognizes shell prologues and fixed versus built commands', () => {
  assert.deepEqual(
    problems(
      `
    export const SAFE_SCRIPT = \`set -eu\necho "$VALUE"\`;
    asAgentUser('"$cli" --version', user);
    asAgentUser(commandLine, user, names);
  `,
      'scripts.ts',
    ),
    [],
  );
  assert.deepEqual(
    problems(
      `
    client.getFile (path);
    export const UNSAFE_SCRIPT = \`rm -f "$VALUE"\`;
    export const SAFE_SCRIPT = \`set -u\necho "$VALUE"\`;
    asAgentUser(('echo ' + command), user);
    asAgentUser(\`echo \${command}\`, user);
    asAgentUser(\`echo fixed\`, user);
  `,
      'scripts.ts',
    ),
    [
      'getFile call',
      'UNSAFE_SCRIPT lacks set -u',
      'asAgentUser with a built string',
      'asAgentUser with a built string',
      'asAgentUser with a built string',
    ],
  );
  assert.deepEqual(problems('asAgentUser(`echo ${command}`, user)', 'machine.ts'), []);
});
