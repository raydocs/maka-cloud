import assert from 'node:assert/strict';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createECDH } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { CloudRunners } from '@maka-cloud/runners';
import { readStackConfig } from '../config.js';
import { type Stack, type StackDependencies, startStack } from '../stack.js';

const SANDBOXES = JSON.stringify({ inv_000000000001: 'mch_test' });
const LINUX = existsSync('/proc/self/fd');

/** The files of `dir` this process holds open (Linux only: the descriptors say it for certain). */
function openFilesUnder(dir: string): string[] {
  const held: string[] = [];
  for (const fd of readdirSync('/proc/self/fd')) {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      if (target.startsWith(dir)) held.push(target);
    } catch {
      // The descriptor of the directory listing itself, closed by now.
    }
  }
  return held;
}

async function dataDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-start-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function configFor(dir: string, env: NodeJS.ProcessEnv = {}) {
  const config = readStackConfig({
    MAKA_CLOUD_DATA_DIR: dir,
    ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    INSTABOX_API_KEY: 'ibx-test-not-a-key',
    MAKA_CLOUD_SANDBOXES: SANDBOXES,
    ...env,
  });
  config.port = 0;
  config.mcp.port = 0;
  config.gateway.port = 0;
  return config;
}

const ENV = { ANTHROPIC_API_KEY: 'sk-test-not-a-key' };
const FLEET = () => ({ runners: [], sweepOrphans: async () => ({}) }) as unknown as CloudRunners;

const fails = (
  config: ReturnType<typeof configFor>,
  env: NodeJS.ProcessEnv,
  deps: StackDependencies,
) =>
  startStack(config, env, deps).then(
    async (stack: Stack) => {
      await stack.close();
      throw new Error('the stack was expected not to start');
    },
    (error: unknown) => error,
  );

test('a stack that cannot bind its gateway port leaves no database open', {
  skip: !LINUX,
}, async (t) => {
  const dir = await dataDir(t);
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => taken.close(() => resolve())));
  const config = configFor(dir);
  config.gateway.port = (taken.address() as AddressInfo).port;
  config.gateway.host = '127.0.0.1';
  const error = await fails(config, ENV, { createRunners: FLEET });
  assert.ok(error instanceof Error);
  assert.deepEqual(openFilesUnder(dir), [], 'the spend journal and the invites file are closed');
});

test('a stack whose fleet cannot be built leaves no database open', { skip: !LINUX }, async (t) => {
  const dir = await dataDir(t);
  const error = await fails(configFor(dir), ENV, {
    createRunners: () => {
      throw new Error('no fleet');
    },
  });
  assert.match(String((error as Error).message), /no fleet/u);
  assert.deepEqual(openFilesUnder(dir), []);
});

test('a stack whose cloud cannot start leaves no database open and no port listening', {
  skip: !LINUX,
}, async (t) => {
  const dir = await dataDir(t);
  const device = createECDH('prime256v1');
  device.generateKeys();
  const env = {
    ...ENV,
    CLOUD_PUSH_VAPID_PUBLIC: device.getPublicKey().toString('base64url'),
    CLOUD_PUSH_VAPID_PRIVATE: 'not-a-private-key-secret',
    CLOUD_PUSH_SUBJECT: 'mailto:ops@example.test',
  };
  const error = await fails(configFor(dir, env), env, { createRunners: FLEET });
  assert.match(String((error as Error).message), /Web Push/u);
  assert.deepEqual(openFilesUnder(dir), []);
});

test('a stack that started and was closed, twice, leaves no database open', {
  skip: !LINUX,
}, async (t) => {
  const dir = await dataDir(t);
  const stack = await startStack(configFor(dir), ENV, { createRunners: FLEET });
  assert.ok(openFilesUnder(dir).length > 0, 'a running stack holds its databases');
  await stack.close();
  await stack.close();
  // Maka's own runtime store (conductor/maka/runtime.sqlite) is opened by the upstream runtime
  // and the conductor never closes it, so it stays open until the process ends: not asserted here.
  assert.deepEqual(
    openFilesUnder(dir).filter((file) => !file.includes(`${join(dir, 'conductor')}/`)),
    [],
    'every database of the stack itself is closed',
  );
});
