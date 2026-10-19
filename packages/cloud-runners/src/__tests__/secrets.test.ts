import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  API_KEY,
  collect,
  filesContaining,
  filesUnder,
  MCP_TOKEN,
  setup,
  terminal,
} from './harness.js';

const NEEDLES = [API_KEY, MCP_TOKEN];

/** Everything on the sandbox's disk that a snapshot would hold, bar the fake CLI's own call log. */
async function diskHits(h: Awaited<ReturnType<typeof setup>>): Promise<string[]> {
  const hits = await filesContaining([h.root, h.home, h.logRoot], NEEDLES);
  return hits.filter((path) => !path.startsWith(join(h.home, 'fake-cli')));
}

test('neither the model key nor the MCP token is on the sandbox disk when a snapshot is taken', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('leakout');
  const atSnapshot: string[][] = [];
  const create = h.client.createSnapshot.bind(h.client);
  h.client.createSnapshot = async (...args) => {
    atSnapshot.push(await diskHits(h));
    return await create(...args);
  };
  const spec = await h.spec('tsk_secret', {
    mcp: { url: 'http://127.0.0.1:1/mcp', token: MCP_TOKEN },
  });
  const events = await collect(await h.runners.claude.start(spec));

  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(atSnapshot.length, 1, 'a snapshot was taken');
  assert.deepEqual(atSnapshot[0], [], 'the CLI printed both secrets; none may be in a snapshot');
  assert.deepEqual(await diskHits(h), [], 'nor after the run');
  assert.ok(!JSON.stringify(events).includes(API_KEY));
  assert.ok(!JSON.stringify(events).includes(MCP_TOKEN));
});

test('raw CLI output is deleted when the run ends, whichever way it ends', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('leakfail');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_secret_fail')));
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  assert.match(last?.type === 'failed' ? last.reason : '', /key is \[redacted\]/);
  assert.ok(!JSON.stringify(events).includes(API_KEY));
  assert.deepEqual(await diskHits(h), []);
  assert.deepEqual(await filesUnder(h.logRoot), []);
});

test('raw output is not written to a disk-backed directory: the run refuses to start', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('leakout');
  // A directory on the same disk as the work root: not memory-backed.
  const onDisk = await fs.mkdtemp(join(h.tmp, 'disk-logs-'));
  const runners = h.makeRunners({ logRoot: onDisk });
  const events = await collect(await runners.claude.start(await h.spec('tsk_disk')));
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  assert.match(last?.type === 'failed' ? last.reason : '', /memory-backed/);
  assert.equal(await h.cliCalls('claude'), 0, 'the CLI was not started');
  assert.deepEqual(await filesContaining([h.root, h.home, onDisk], NEEDLES), []);
});

for (const vendor of ['claude', 'codex'] as const) {
  for (const mode of ['leakedge-plain', 'leakedge-guard', 'leakedge-json']) {
    test(`a secret cut by a length cap does not reach the failure or the notes (${vendor}, ${mode})`, async (t) => {
      const h = await setup();
      t.after(() => h.cleanup());
      await h.setMode(mode);
      const taskId = `tsk_edge_${vendor}_${mode.replace('leakedge-', '')}`;
      const spec = await h.spec(taskId, vendor === 'codex' ? { runner: 'codex' } : {});
      const events = await collect(await h.runners[vendor].start(spec));

      const last = terminal(events);
      assert.equal(last?.type, 'failed');
      assert.match(last?.type === 'failed' ? last.reason : '', /\[redacted\]/);
      // The cap used to cut the key in the middle, which no longer matched and went out in part.
      assert.ok(
        !JSON.stringify(events).includes(API_KEY.slice(0, 8)),
        `no piece of the key is left: ${JSON.stringify(events)}`,
      );
    });
  }
}
