import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCloudRunnersFromEnv } from '../index.js';
import { envModelAccess } from './live-access.js';

/**
 * Real sandbox, real CLI, real model calls, real spend. It runs only when all three variables
 * are set (plus INSTABOX_MACHINE_ID); CI and the people working on this package leave them unset.
 */
const live =
  process.env.MAKA_CLOUD_LIVE === '1' &&
  Boolean(process.env.INSTABOX_API_KEY) &&
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  Boolean(process.env.INSTABOX_MACHINE_ID);

test('live smoke: the Claude runner completes a trivial brief in a real sandbox', {
  skip: !live,
  timeout: 15 * 60_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runners-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const taskId = `live${Date.now()}`;
  const briefPath = join(dir, 'brief.md');
  const resultPath = join(dir, 'result.json');
  await writeFile(
    briefPath,
    'Create a file hello.txt containing the word hello, then report what you did.',
  );

  const { claude } = createCloudRunnersFromEnv(process.env, { modelAccess: envModelAccess() });
  const handle = await claude.start({ taskId, runner: 'claude-agent-sdk', briefPath, resultPath });
  let outcome = '';
  for await (const event of handle.events) if (event.type !== 'progress') outcome = event.type;
  assert.equal(outcome, 'finished');
  assert.ok(JSON.parse(await readFile(resultPath, 'utf8')).summary);
});
