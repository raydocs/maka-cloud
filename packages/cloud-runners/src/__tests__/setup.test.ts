import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_CLI } from './fake-cli.js';
import { collect, setup, terminal } from './harness.js';

const INSTALL = `mkdir -p "$HOME/.maka-cli/bin"
cat > "$HOME/.maka-cli/bin/claude" <<'FAKE_CLI_EOF'
${CLAUDE_CLI}
FAKE_CLI_EOF
chmod +x "$HOME/.maka-cli/bin/claude"
echo installed >> "$HOME/install-count"`;

async function installs(home: string): Promise<number> {
  const text = await fs.readFile(join(home, 'install-count'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).length;
}

test('the CLI is installed once, even for tasks that start together, and skipped afterwards', async (t) => {
  const h = await setup({
    installClis: false,
    cloud: { installCommands: { 'claude-agent-sdk': INSTALL } },
  });
  t.after(() => h.cleanup());
  const [a, b] = await Promise.all([
    h.spec('tsk_inst_a').then((s) => h.runners.claude.start(s)),
    h.spec('tsk_inst_b').then((s) => h.runners.claude.start(s)),
  ]);
  assert.equal(terminal(await collect(a))?.type, 'finished');
  assert.equal(terminal(await collect(b))?.type, 'finished');
  assert.equal(await installs(h.home), 1);
  await fs.stat(join(h.root, '.setup', 'claude-9.9.9.ok'));

  const later = await collect(await h.runners.claude.start(await h.spec('tsk_inst_c')));
  assert.equal(terminal(later)?.type, 'finished');
  assert.equal(await installs(h.home), 1, 'marker and version match: no second install');
});

test('two server processes installing at once share one install through the lock', async (t) => {
  const h = await setup({
    installClis: false,
    cloud: { installCommands: { 'claude-agent-sdk': `sleep 0.3\n${INSTALL}` } },
  });
  t.after(() => h.cleanup());
  const other = h.makeRunners();
  const [a, b] = await Promise.all([
    h.spec('tsk_proc_a').then((s) => h.runners.claude.start(s)),
    h.spec('tsk_proc_b').then((s) => other.claude.start(s)),
  ]);
  assert.equal(terminal(await collect(a))?.type, 'finished');
  assert.equal(terminal(await collect(b))?.type, 'finished');
  assert.equal(await installs(h.home), 1);
});

test('a failed install fails the task with its output, and the next task tries again', async (t) => {
  const h = await setup({
    installClis: false,
    cloud: {
      installCommands: {
        'claude-agent-sdk': `[ -f "$HOME/allow" ] || { echo "registry unreachable"; exit 3; }\n${INSTALL}`,
      },
    },
  });
  t.after(() => h.cleanup());
  const failed = terminal(await collect(await h.runners.claude.start(await h.spec('tsk_inst_f1'))));
  assert.equal(failed?.type, 'failed');
  const reason = failed?.type === 'failed' ? failed.reason : '';
  assert.match(reason, /installing claude@9\.9\.9 in the sandbox failed/);
  assert.match(reason, /registry unreachable/);

  await fs.writeFile(join(h.home, 'allow'), '');
  const retried = await collect(await h.runners.claude.start(await h.spec('tsk_inst_f2')));
  assert.equal(terminal(retried)?.type, 'finished');
});

test('an install that prints a token fails the task without it', async (t) => {
  const h = await setup({
    installClis: false,
    cloud: {
      installCommands: {
        'claude-agent-sdk':
          'echo "npm ERR! 401 Authorization: Bearer npm_abcdef0123456789abcdef"; exit 4',
      },
    },
  });
  t.after(() => h.cleanup());
  const failed = terminal(
    await collect(await h.runners.claude.start(await h.spec('tsk_inst_tok'))),
  );
  assert.equal(failed?.type, 'failed');
  const reason = failed?.type === 'failed' ? failed.reason : '';
  assert.match(reason, /npm ERR! 401/);
  assert.ok(!reason.includes('abcdef0123456789'), reason);
});

test('a different pinned version is installed over an older one', async (t) => {
  const h = await setup({
    cloud: {
      versions: { 'claude-agent-sdk': '10.0.0', codex: '9.9.9' },
      installCommands: {
        'claude-agent-sdk': `${INSTALL.replace('fake 9.9.9', 'x')}\nsed -i 's/9\\.9\\.9/10.0.0/' "$HOME/.maka-cli/bin/claude"`,
      },
    },
  });
  t.after(() => h.cleanup());
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_inst_v')));
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await installs(h.home), 1);
});
