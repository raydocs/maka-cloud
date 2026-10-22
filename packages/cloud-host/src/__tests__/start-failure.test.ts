import assert from 'node:assert/strict';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createECDH } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { CloudRunners, CloudRunnersOptions } from '@maka-cloud/runners';
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

const AGENT_ENV = { MAKA_CLOUD_AGENT_USER: 'maka-agent', MAKA_CLOUD_AGENT_GROUP: 'maka' };

test('with the agent account set the fleet gets the SDK and the stored conversations, and the stack closes that database', {
  skip: !LINUX,
}, async (t) => {
  const dir = await dataDir(t);
  let given: Partial<CloudRunnersOptions> | undefined;
  const stack = await startStack(configFor(dir, AGENT_ENV), ENV, {
    createRunners: (options) => {
      given = options;
      return FLEET();
    },
  });
  assert.deepEqual(given?.agentChannel, { user: 'maka-agent', group: 'maka' });
  assert.equal(typeof given?.agentSdk?.query, 'function');
  assert.ok(given?.transcripts, 'the conversations are kept');
  assert.ok(existsSync(join(dir, 'transcripts.db')));
  assert.ok(openFilesUnder(dir).some((file) => file.endsWith('transcripts.db')));
  await stack.close();
  assert.deepEqual(
    openFilesUnder(dir).filter((file) => !file.includes(`${join(dir, 'conductor')}/`)),
    [],
  );
});

test('without the agent account the fleet gets neither, and no conversation database is made', async (t) => {
  const dir = await dataDir(t);
  let given: Partial<CloudRunnersOptions> | undefined;
  const stack = await startStack(configFor(dir), ENV, {
    createRunners: (options) => {
      given = options;
      return FLEET();
    },
  });
  t.after(() => stack.close());
  assert.equal(given?.agentSdk, undefined);
  assert.equal(given?.agentChannel, undefined);
  assert.equal(given?.transcripts, undefined);
  assert.ok(!existsSync(join(dir, 'transcripts.db')));
});

test('a stack that fails to start with the agent account set leaves the conversation database closed', {
  skip: !LINUX,
}, async (t) => {
  const dir = await dataDir(t);
  const error = await fails(configFor(dir, AGENT_ENV), ENV, {
    createRunners: () => {
      throw new Error('no fleet');
    },
  });
  assert.match(String((error as Error).message), /no fleet/u);
  assert.deepEqual(openFilesUnder(dir), []);
});

test('a second stack over the data directory of a running one fails and leaves what the first holds', {
  skip: !LINUX,
}, async (t) => {
  const dir = await dataDir(t);
  const first = await startStack(configFor(dir), ENV, { createRunners: FLEET });
  t.after(() => first.close());
  const journalPath = join(dir, 'gateway-spend.db');
  const policy = (): unknown => {
    const db = new DatabaseSync(journalPath);
    try {
      return db.prepare('SELECT * FROM spend_policy').all();
    } finally {
      db.close();
    }
  };
  // A model request of the first process that is in flight: its hold is written down before it is sent.
  const writer = new DatabaseSync(journalPath);
  writer
    .prepare('INSERT INTO holds (key, epoch, task_id, usd, attempt) VALUES (?, ?, ?, ?, ?)')
    .run('k1', 'epoch-of-the-first', 'tsk_1', 2, 1);
  writer.close();
  const before = policy();
  const second = configFor(dir, { MAKA_CLOUD_SERVER_DAILY_USD: '1' });
  const error = await fails(second, ENV, { createRunners: FLEET });
  assert.ok(error instanceof Error);
  assert.match(
    error.name,
    /InUse/u,
    'the second stack is refused for the lock, not for something else',
  );
  const reader = new DatabaseSync(journalPath);
  try {
    assert.equal(
      (reader.prepare('SELECT COUNT(*) AS n FROM holds').get() as { n: number }).n,
      1,
      'the second stack did not take the first one’s open hold for an earlier process’s',
    );
  } finally {
    reader.close();
  }
  assert.deepEqual(policy(), before, 'the second stack wrote no caps of its own');
});
