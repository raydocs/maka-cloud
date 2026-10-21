import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StepIntentResult, StepLog } from '@maka-cloud/orchestrator';
import { kindOf, labelOf, replayClassOf, stepHooks } from '../hooks.js';

const bash = (command: string) => replayClassOf('Bash', { command });

test('reading and editing tools can be run again; unknown tools and MCP tools cannot', () => {
  for (const tool of [
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    'TodoWrite',
    'Edit',
    'Write',
    'Task',
  ]) {
    assert.equal(replayClassOf(tool, {}), 'safe', tool);
  }
  for (const tool of [
    'mcp__maka__delegate',
    'mcp__github__create_pull_request',
    'SomethingNew',
    '',
  ]) {
    assert.equal(replayClassOf(tool, {}), 'never', tool);
  }
});

test('a shell command is safe only when it is one plain read-only command', () => {
  for (const command of [
    'ls',
    'ls -la src',
    'git status',
    'git diff HEAD~1',
    'npm test',
    'npm run build',
    'grep -rn foo src',
    'node --test dist',
    'find . -name "*.ts" -type f',
    'git branch',
    'git branch -a',
    'git remote -v',
    'sort -u names.txt',
    'uniq names.txt',
    'date',
    'date +%s',
    'env',
    'rg -n foo src',
    'git log -n5 --oneline',
    'git diff -U3 HEAD~1 -- src',
    'git status -sb',
    'head -20 notes.txt',
    'grep -A3 -n foo src',
    'sort -k2 -t, data.csv',
    'tree -L 2 src',
  ]) {
    assert.equal(bash(command), 'safe', command);
  }
  for (const command of [
    'git push origin main',
    'gh pr create --fill',
    'curl -X POST https://example.test',
    'npm publish',
    'rm -rf build',
    'ls; git push',
    'ls && git push',
    'cat a | sh',
    'echo $(git push)',
    'echo `git push`',
    'cat > file',
    'ls\ngit push',
    'git status; rm -rf /',
    'bash -c "ls"',
    'npm install left-pad',
    // A harmless first word does not make the command harmless.
    'env gh pr merge 123 --merge',
    'env FOO=1 git push',
    'find . -delete',
    'find . -name x -exec rm {} +',
    'find . -fprint out.txt',
    'git branch -D release',
    'git branch newname',
    'git branch -m old new',
    'git -c core.pager=sh log',
    'git -C /elsewhere status',
    'git diff --output=patch.diff',
    'git remote add evil https://example.test/x.git',
    'git remote set-url origin https://example.test/x.git',
    'git config --global user.name x',
    'sort -o out.txt in.txt',
    // An abbreviated long option, or a short one with its value attached, is still the option.
    'git diff --ext-dif',
    'git diff --ext-diff',
    'git diff --outpu=patch.diff',
    'git log --open-files-in-pager=sh',
    'git show -Osh',
    'sort -oout.txt in.txt',
    'sort --out=out.txt in.txt',
    'sort --compress-prog=sh in.txt',
    'tree -olisting.txt',
    'rg --pr=./hook pattern',
    'find . -fprintf out.txt x',
    'find . -newermt 2020-01-01 -delet',
    'grep --exclude-from=/etc/passwd x',
    'ls --hyperlink',
    'sort --output=out.txt in.txt',
    'uniq in.txt out.txt',
    'tree -o listing.txt',
    'date -s 2020-01-01',
    'date 010100002020',
    'rg --pre ./hook pattern',
    'npm run publish',
    'npm run deploy',
    'node script.js',
    'cargo install foo',
    'make deploy',
    '/bin/ls',
    'FOO=1 ls',
    'constructor',
    'git constructor',
    '',
  ]) {
    assert.equal(bash(command), 'never', JSON.stringify(command));
  }
  assert.equal(replayClassOf('Bash', {}), 'never');
  assert.equal(replayClassOf('Bash', null), 'never');
  assert.equal(replayClassOf('Bash', { command: 5 }), 'never');
});

test('a step kind and label are one short plain line, with secrets taken out first', () => {
  assert.equal(kindOf('Bash'), 'tool:Bash');
  assert.equal(kindOf('mcp__maka__do thing\n'), 'tool:mcp__maka__do_thing_');
  assert.equal(kindOf('x'.repeat(100)).length, 40);

  const redact = (text: string) => text.replaceAll('sk-secret-123456', '[redacted]');
  assert.equal(
    labelOf('Bash', { command: 'echo sk-secret-123456' }, redact),
    'Bash: echo [redacted]',
  );
  assert.equal(labelOf('Read', { file_path: '/work/a.ts' }, redact), 'Read: /work/a.ts');
  assert.equal(labelOf('Glob', { pattern: '**/*.ts' }, redact), 'Glob: **/*.ts');
  assert.equal(labelOf('Task', {}, redact), 'Task');
  assert.equal(labelOf('Bash', { command: 'a\n\n  b\t c' }, redact), 'Bash: a b c');
  assert.equal(labelOf('Bash', { command: 'x'.repeat(500) }, redact).length, 120);
  // A key cut by the length limit is still taken out first.
  assert.ok(
    !labelOf('Bash', { command: `${'y'.repeat(100)}sk-secret-123456` }, redact).includes(
      'sk-secret',
    ),
  );
});

function hookInput(event: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: event,
    session_id: 's',
    transcript_path: '',
    cwd: '/w',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    tool_use_id: 'toolu_x',
    ...extra,
  } as never;
}

function logWith(intent: () => Promise<StepIntentResult>, calls: string[] = []): StepLog {
  return {
    intent: async (step) => {
      calls.push(`intent ${step.stepId}`);
      return await intent();
    },
    outcome: async (id, result) => {
      calls.push(`outcome ${id} ${result.status}`);
      return 'recorded';
    },
  };
}

const call = async (
  hooks: ReturnType<typeof stepHooks>,
  event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
  extra = {},
) => {
  const hook = hooks[event]?.[0]?.hooks[0];
  assert.ok(hook, event);
  return await hook(hookInput(event, extra), 'toolu_x', { signal: new AbortController().signal });
};

test('every answer of the intent has an answer for the CLI', async () => {
  const cases: Array<[StepIntentResult, 'allow' | 'deny', RegExp?]> = [
    [{ status: 'recorded' }, 'allow'],
    [{ status: 'running' }, 'deny', /already running/],
    [{ status: 'completed', ok: true }, 'deny', /already finished and is not run again/],
    [{ status: 'completed', ok: false }, 'deny', /already failed/],
    [{ status: 'interrupted' }, 'deny', /cut off by a restart/],
    [{ status: 'refused', reason: 'a newer attempt drives this task' }, 'deny', /newer attempt/],
  ];
  for (const [result, expected, reason] of cases) {
    const answer = (await call(
      stepHooks(
        logWith(async () => result),
        (t) => t,
      ),
      'PreToolUse',
    )) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    if (expected === 'allow') assert.deepEqual(answer, {}, result.status);
    else {
      assert.equal(answer.hookSpecificOutput?.permissionDecision, 'deny', result.status);
      assert.match(answer.hookSpecificOutput?.permissionDecisionReason ?? '', reason as RegExp);
    }
  }
});

test('a refusal reason that holds a secret is redacted before the agent reads it', async () => {
  const hooks = stepHooks(
    logWith(async () => ({ status: 'refused', reason: 'token sk-secret-123456 expired' })),
    (text) => text.replaceAll('sk-secret-123456', '[redacted]'),
  );
  const answer = JSON.stringify(await call(hooks, 'PreToolUse'));
  assert.ok(!answer.includes('sk-secret'));
});

test('a log that throws denies every step, safe or not, saying so', async () => {
  const problems: string[] = [];
  const hooks = stepHooks(
    logWith(async () => {
      throw new Error('disk full');
    }),
    (t) => t,
    (message) => problems.push(message),
  );
  const never = (await call(hooks, 'PreToolUse')) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  assert.equal(never.hookSpecificOutput?.permissionDecision, 'deny');
  const safe = (await call(hooks, 'PreToolUse', {
    tool_name: 'Read',
    tool_input: { file_path: '/a' },
  })) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(safe.hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(problems, [
    'a step could not be recorded: disk full',
    'a step could not be recorded: disk full',
  ]);
});

test('outcomes carry no tool output, and a failed one carries only a short error', async () => {
  const calls: string[] = [];
  const outcomes: Array<{ id: string; result: { status: string; output?: string } }> = [];
  const log: StepLog = {
    intent: async () => ({ status: 'recorded' }),
    outcome: async (id, result) => {
      outcomes.push({ id, result });
      calls.push(id);
      return 'recorded';
    },
  };
  const hooks = stepHooks(log, (text) => text.replaceAll('sk-secret-123456', '[redacted]'));
  await call(hooks, 'PostToolUse', { tool_response: 'a very long secret answer sk-secret-123456' });
  await call(hooks, 'PostToolUseFailure', { error: `boom sk-secret-123456 ${'x'.repeat(2000)}` });
  assert.deepEqual(outcomes[0], { id: 'toolu_x', result: { status: 'done' } });
  assert.equal(outcomes[1]?.result.status, 'failed');
  assert.ok((outcomes[1]?.result.output ?? '').length <= 500);
  assert.ok(!(outcomes[1]?.result.output ?? '').includes('sk-secret'));
});

test('an outcome that cannot be recorded does not fail the tool', async () => {
  const problems: string[] = [];
  const log: StepLog = {
    intent: async () => ({ status: 'recorded' }),
    outcome: async () => {
      throw new Error('no space');
    },
  };
  const hooks = stepHooks(
    log,
    (t) => t,
    (message) => problems.push(message),
  );
  assert.deepEqual(await call(hooks, 'PostToolUse'), {});
  assert.deepEqual(problems, ['a step outcome could not be recorded: no space']);
});

test('a finished step is not run again, and the agent is told what it reported, with secrets taken out', async () => {
  const answer = (await call(
    stepHooks(
      logWith(async () => ({
        status: 'completed',
        ok: true,
        output: 'pushed sk-secret-123456 ok',
      })),
      (text) => text.replaceAll('sk-secret-123456', '[redacted]'),
    ),
    'PreToolUse',
  )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(answer.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(answer.hookSpecificOutput?.permissionDecisionReason ?? '', /pushed \[redacted\] ok/);
  assert.ok(!(answer.hookSpecificOutput?.permissionDecisionReason ?? '').includes('sk-secret'));
});
