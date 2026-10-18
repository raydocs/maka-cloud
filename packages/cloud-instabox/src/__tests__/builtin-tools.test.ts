import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildBuiltinTools } from '@maka/runtime/builtin-tools';
import { setup, type Harness } from './harness.js';

const hasRipgrep = (() => {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Maka's own built-in tools, driven against the fake sandbox through `options.executor`. */
describe('built-in tools on an instabox executor', () => {
  let h: Harness;
  let tools: ReturnType<typeof buildBuiltinTools>;
  beforeEach(async () => {
    h = await setup();
    tools = buildBuiltinTools({ executor: h.executor });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const run = async (name: string, args: unknown): Promise<any> => {
    const found = tools.find((candidate) => candidate.name === name);
    assert.ok(found, `${name} tool missing`);
    return await found.impl(args as never, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd: h.work,
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    });
  };

  it('Write, Read and Edit work through the sandbox', async () => {
    const written = await run('Write', { path: 'notes.txt', content: 'alpha\nbeta\n' });
    assert.ok(written);
    assert.equal(await fs.readFile(join(h.work, 'notes.txt'), 'utf8'), 'alpha\nbeta\n');

    await run('Edit', { path: 'notes.txt', old_string: 'beta', new_string: 'gamma' });
    assert.equal(await fs.readFile(join(h.work, 'notes.txt'), 'utf8'), 'alpha\ngamma\n');

    const read = await run('Read', { path: 'notes.txt' });
    assert.match(JSON.stringify(read), /gamma/);
  });

  it('Bash runs in the sandbox cwd', async () => {
    const result = await run('Bash', { command: 'pwd', boundary_intent: 'workspace' });
    assert.match(JSON.stringify(result), new RegExp(h.work.replaceAll('/', '\\/')));
  });

  it('Glob lists matches', async () => {
    await fs.writeFile(join(h.work, 'a.ts'), '');
    await fs.writeFile(join(h.work, 'b.md'), '');
    const result = await run('Glob', { pattern: '*.ts' });
    assert.deepEqual(result, { files: ['a.ts'], truncated: false });
  });

  it('Grep finds content', { skip: !hasRipgrep }, async () => {
    await fs.writeFile(join(h.work, 'a.ts'), 'const needle = 1;\n');
    const result = await run('Grep', { pattern: 'needle' });
    assert.equal(result.matchedLines, 1);
  });

  it('refuses to read outside the workspace', async () => {
    await fs.writeFile(join(h.outside, 'secret.txt'), 'secret');
    await assert.rejects(
      run('Read', { path: join(h.outside, 'secret.txt') }),
      /session cwd|permission|outside/i,
    );
    assert.equal(h.fake.requestsTo('GET', /\/files$/).length, 0);
  });

  it('does not offer ApplyPatch, which needs descriptor pinning a remote sandbox cannot give', () => {
    assert.equal(
      tools.some((candidate) => candidate.name === 'apply_patch'),
      false,
    );
  });
});
