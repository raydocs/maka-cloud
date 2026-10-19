import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCloudRunners } from '../index.js';
import { FixedMachineProvider } from '../providers.js';
import { collect, deferred, setup, settles, terminal } from './harness.js';

const TOOL = '#!/bin/sh\necho "cite-check says hi"\n';
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** The exec calls that carried a chunk of a tool. */
function chunkCalls(h: Awaited<ReturnType<typeof setup>>): number {
  return h.fake.execRequests.filter((request) => request.body.envs?.MAKA_TOOL_TMP).length;
}

async function installedTool(home: string, name = 'cite-check'): Promise<Buffer> {
  return await fs.readFile(join(home, '.maka-cli', 'bin', name));
}

test('a tool is installed on the PATH of runs, once for tasks that start together and not again later', async (t) => {
  const h = await setup({ cloud: { sandboxTools: [{ name: 'cite-check', content: TOOL }] } });
  t.after(() => h.cleanup());
  const [a, b] = await Promise.all([
    h.spec('tsk_tool_a').then((s) => h.runners.claude.start(s)),
    h.spec('tsk_tool_b').then((s) => h.runners.claude.start(s)),
  ]);
  assert.equal(terminal(await collect(a))?.type, 'finished');
  assert.equal(terminal(await collect(b))?.type, 'finished');

  assert.equal((await installedTool(h.home)).toString(), TOOL);
  const mode = (await fs.stat(join(h.home, '.maka-cli', 'bin', 'cite-check'))).mode & 0o777;
  assert.equal(mode, 0o755);
  assert.equal(
    await fs.readFile(join(h.root, '.setup', 'tool-cite-check.sha256'), 'utf8'),
    sha(TOOL),
  );
  assert.equal(chunkCalls(h), 1, 'concurrent runs share one install');
  const left = (await fs.readdir(join(h.home, '.maka-cli', 'bin'))).filter((name) =>
    name.endsWith('.tmp'),
  );
  assert.deepEqual(left, []);

  // The run script puts the directory first on PATH.
  const { env } = await h.cliCall('claude', 1);
  const path = env.split('\n').find((line) => line.startsWith('PATH=')) ?? '';
  assert.ok(path.startsWith(`PATH=${h.home}/.maka-cli/bin:`), path);

  const later = await collect(await h.runners.claude.start(await h.spec('tsk_tool_c')));
  assert.equal(terminal(later)?.type, 'finished');
  assert.equal(chunkCalls(h), 1, 'the marker matches: no second install');
});

test('a tool whose content changed is installed again, and a restarted process finds the marker', async (t) => {
  const h = await setup({ cloud: { sandboxTools: [{ name: 'cite-check', content: TOOL }] } });
  t.after(() => h.cleanup());
  await collect(await h.runners.claude.start(await h.spec('tsk_v1')));
  assert.equal(chunkCalls(h), 1);

  const same = h.makeRunners();
  await collect(await same.claude.start(await h.spec('tsk_v1b')));
  assert.equal(chunkCalls(h), 1, 'a new process with the same tool does not install');

  const next = `${TOOL}# v2\n`;
  const updated = h.makeRunners({ sandboxTools: [{ name: 'cite-check', content: next }] });
  assert.equal(
    terminal(await collect(await updated.claude.start(await h.spec('tsk_v2'))))?.type,
    'finished',
  );
  assert.equal(chunkCalls(h), 2);
  assert.equal((await installedTool(h.home)).toString(), next);
  assert.equal(
    await fs.readFile(join(h.root, '.setup', 'tool-cite-check.sha256'), 'utf8'),
    sha(next),
  );
});

test('a tool larger than one chunk arrives byte for byte', async (t) => {
  const content = Buffer.alloc(700 * 1024);
  for (let i = 0; i < content.length; i++) content[i] = (i * 31 + (i >> 8)) & 0xff;
  const h = await setup({ cloud: { sandboxTools: [{ name: 'big-tool', content }] } });
  t.after(() => h.cleanup());
  assert.equal(
    terminal(await collect(await h.runners.claude.start(await h.spec('tsk_big'))))?.type,
    'finished',
  );
  assert.ok((await installedTool(h.home, 'big-tool')).equals(content));
  assert.equal(chunkCalls(h), 3);
});

test('a failed install fails the task before the CLI starts, leaves no half file, and the next task installs', async (t) => {
  const h = await setup({ cloud: { sandboxTools: [{ name: 'cite-check', content: TOOL }] } });
  t.after(() => h.cleanup());
  let failed = false;
  h.fake.onExec = (request) => {
    if (!failed && request.body.envs?.MAKA_TOOL_TMP) {
      failed = true;
      return { status: 400, error: { code: 'bad_request', message: 'no', retryable: false } };
    }
    return undefined;
  };
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_toolfail')));
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(
    end?.type === 'failed' ? end.reason : '',
    /installing cite-check in the sandbox failed/,
  );
  assert.equal(await h.cliCalls('claude'), 0);
  assert.deepEqual(h.revoked, ['tsk_toolfail']);
  assert.equal(h.fake.leases.size, 0);
  await assert.rejects(installedTool(h.home), { code: 'ENOENT' });

  const retry = await collect(await h.runners.claude.start(await h.spec('tsk_toolretry')));
  assert.equal(terminal(retry)?.type, 'finished');
  assert.equal((await installedTool(h.home)).toString(), TOOL);
});

test('a chunk that arrives damaged is never put in place', async (t) => {
  const h = await setup({ cloud: { sandboxTools: [{ name: 'cite-check', content: TOOL }] } });
  t.after(() => h.cleanup());
  h.fake.onExec = (request) =>
    request.body.envs?.MAKA_TOOL_TMP
      ? { stdin: Buffer.from('#!/bin/sh\necho tampered\n').toString('base64') }
      : undefined;
  const end = terminal(await collect(await h.runners.claude.start(await h.spec('tsk_damaged'))));
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', /arrived damaged/);
  await assert.rejects(installedTool(h.home), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(join(h.root, '.setup', 'tool-cite-check.sha256')), {
    code: 'ENOENT',
  });
  assert.deepEqual(
    (await fs.readdir(join(h.home, '.maka-cli', 'bin'))).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('cancel while the tool is being installed ends the run at once and releases everything', async (t) => {
  const h = await setup({ cloud: { sandboxTools: [{ name: 'cite-check', content: TOOL }] } });
  t.after(() => h.cleanup());
  const entered = deferred();
  const release = deferred();
  h.fake.onExec = (request) => {
    if (!request.body.envs?.MAKA_TOOL_TMP) return undefined;
    entered.resolve();
    return { hold: release.promise };
  };
  const handle = await h.runners.claude.start(await h.spec('tsk_toolcancel'));
  await entered.promise;
  await handle.cancel();
  const rest = await settles(collect(handle));
  assert.notEqual(rest, 'stuck', 'a cancelled run does not wait for the install');
  assert.equal(
    rest === 'stuck' ? undefined : terminal(rest),
    undefined,
    'a cancelled run reports no outcome',
  );
  assert.equal(await h.cliCalls('claude'), 0);
  assert.deepEqual(h.revoked, ['tsk_toolcancel']);
  assert.equal(h.fake.leases.size, 0);
  assert.equal(h.runners.fleet.openRuns, 0);
  assert.equal(h.runners.fleet.leaseRenewals, 0);

  // The install the cancelled run was waiting for finishes by itself; the next run finds it done.
  release.resolve();
  const next = await collect(await h.runners.claude.start(await h.spec('tsk_toolafter')));
  assert.equal(terminal(next)?.type, 'finished');
  assert.equal((await installedTool(h.home)).toString(), TOOL);
});

test('tool names and content are checked when the runners are built', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const build = (sandboxTools: { name: string; content: string }[]) =>
    createCloudRunners({
      client: h.client,
      sandboxes: new FixedMachineProvider(h.fake.machineId),
      sandboxTools,
    });
  assert.throws(() => build([{ name: 'Cite Check', content: TOOL }]), /Invalid sandbox tool name/);
  assert.throws(() => build([{ name: '../x', content: TOOL }]), /Invalid sandbox tool name/);
  assert.throws(() => build([{ name: 'claude', content: TOOL }]), /name is taken/);
  assert.throws(() => build([{ name: 'codex', content: TOOL }]), /name is taken/);
  assert.throws(
    () =>
      build([
        { name: 'a', content: TOOL },
        { name: 'a', content: TOOL },
      ]),
    /name is taken/,
  );
  assert.throws(() => build([{ name: 'empty', content: '' }]), /between 1 byte/);
});
