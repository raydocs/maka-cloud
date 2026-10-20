import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SqliteSpendJournal } from '@maka-cloud/gateway';
import { InviteStore } from '@maka-cloud/server';
import { FakeRunner } from '@maka-cloud/orchestrator';
import { codingPlaybook } from '@maka-cloud/playbooks/coding';
import type { CloudRunners, CloudRunnersOptions, ModelAccess } from '@maka-cloud/runners';
import { listBackups, restoreBackup, verifyBackup } from '../backup.js';
import { backupLayoutOf, readStackConfig } from '../config.js';
import { openServerLedger } from '../spend.js';
import {
  PAUSED_NOTICE,
  STACK_PLAYBOOKS,
  type Stack,
  type StackDependencies,
  startStack,
} from '../stack.js';

/** The machine of the invite the tests create first; any other invite has none. */
const SANDBOXES = JSON.stringify({ inv_000000000001: 'mch_test' });

interface Started {
  stack: Stack;
  options: Partial<CloudRunnersOptions>;
  claude: FakeRunner;
  modelRequests: () => number;
  /** The path and API key of each model request. */
  modelKeys: string[];
  /** Resolves at the first Messages request the model server gets. */
  firstMessage: Promise<void>;
  sweeps: string[][];
  dataDir: string;
  /** The invite that owns every task of `owners` unless a test maps it to another. */
  inviteId: string;
  /** Which invite owns a task, for the tasks the tests issue model access to directly. */
  owners: Map<string, string>;
  /** What the stack warned about. */
  warnings: string[];
}

async function start(
  t: TestContext,
  publicUrl?: string,
  env: NodeJS.ProcessEnv = {},
  /** False: tasks are owned only through conversations, as in the product. */
  ownerSeam = true,
  extra: Partial<StackDependencies> = {},
  /** Settings that depend on the data directory, such as an invite made in it before the start. */
  prepare?: (dir: string) => NodeJS.ProcessEnv,
): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-stack-'));
  env = { ...env, ...prepare?.(dir) };
  let requests = 0;
  const modelKeys: string[] = [];
  let messageArrived = (): void => undefined;
  const firstMessage = new Promise<void>((resolve) => {
    messageArrived = resolve;
  });
  const model = createServer((req, res) => {
    requests += 1;
    modelKeys.push(`${req.url} ${req.headers['x-api-key'] ?? req.headers.authorization}`);
    if (req.url?.endsWith('/v1/messages')) messageArrived();
    req.resume();
    if (req.url === '/v1/tools/search') {
      const results = [{ title: 'Tides', url: 'https://e.test/tides', snippet: 'High at noon.' }];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results }));
      return;
    }
    if (req.url?.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":12}');
      return;
    }
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  const config = {
    ...readStackConfig({
      MAKA_CLOUD_DATA_DIR: dir,
      ANTHROPIC_API_KEY: 'sk-test-not-a-key',
      ANTHROPIC_BASE_URL: modelUrl,
      INSTABOX_API_KEY: 'ibx-test-not-a-key',
      MAKA_CLOUD_SANDBOXES: SANDBOXES,
      ...(publicUrl === undefined ? {} : { MAKA_CLOUD_MCP_PUBLIC_URL: publicUrl }),
      ...Object.fromEntries(
        Object.entries(env).filter(
          ([name]) =>
            name.startsWith('CLOUD_PUSH_') ||
            name === 'MAKA_CLOUD_SANDBOXES' ||
            name === 'MAKA_CLOUD_BACKUP_DIR' ||
            name === 'MAKA_CLOUD_SPEND_ALERT_USD' ||
            name === 'MAKA_CLOUD_OWNER_INVITE' ||
            name === 'MAKA_CLOUD_SERVER_DAILY_USD' ||
            name === 'MAKA_CLOUD_INVITE_DAILY_USD' ||
            name === 'MAKA_CLOUD_INVITE_MONTHLY_USD',
        ),
      ),
    }),
    port: 0,
  };
  config.mcp.port = 0;
  config.gateway.port = 0;
  // The fake model server also answers as the search provider.
  if (env.DEEPSEEK_API_KEY !== undefined) config.gateway.searchBaseUrl = modelUrl;
  const claude = new FakeRunner({
    name: 'claude-agent-sdk',
    onStart: (run) => {
      setImmediate(() => void run.complete());
    },
  });
  const codex = new FakeRunner({ name: 'codex' });
  const sweeps: string[][] = [];
  let options: Partial<CloudRunnersOptions> = {};
  let inviteId = '';
  const owners = new Map<string, string>();
  const warnings: string[] = [];
  const stack = await startStack(config, env, {
    ...extra,
    pausePollMs: 10,
    onWarning: (message) => warnings.push(message),
    ...(ownerSeam
      ? { ownerOfTask: (taskId) => owners.get(taskId) ?? (inviteId === '' ? undefined : inviteId) }
      : {}),
    createRunners: (given) => {
      options = given;
      return {
        runners: [claude, codex],
        claude,
        codex,
        fleet: {},
        sweepOrphans: async (known: Iterable<string>) => {
          sweeps.push([...known]);
          return { stopped: [], failed: [] };
        },
      } as unknown as CloudRunners;
    },
  });
  inviteId = stack.cloud.server.invites.create('stack test').inviteId;
  t.after(async () => {
    await stack.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    stack,
    options,
    claude,
    modelRequests: () => requests,
    modelKeys,
    firstMessage,
    sweeps,
    dataDir: dir,
    inviteId,
    owners,
    warnings,
  };
}

test('starting the stack runs nothing: no model request and no task until a user posts a message', async (t) => {
  const { stack, claude, modelRequests, sweeps } = await start(t);
  await stack.cloud.server.orchestrator.settled();
  assert.equal(modelRequests(), 0);
  assert.equal(claude.runs.length, 0);
  assert.deepEqual(sweeps, [[]], 'leftover sandbox runs are swept once, against the restored log');
  const health = await fetch(`${stack.cloud.server.url}/v1/conversations`);
  assert.equal(health.status, 401, 'the public API is up and needs an invite');
});

test('the fleet gets the bundled cite-check tool and a resumable session store', async (t) => {
  const { options } = await start(t);
  assert.equal(options.sandboxTools?.length, 1);
  const tool = options.sandboxTools?.[0];
  assert.equal(tool?.name, 'cite-check');
  assert.ok(tool);
  assert.equal(
    Buffer.from(tool.content).subarray(0, 2).toString(),
    '#!',
    'the tool is a script with a shebang',
  );
  assert.ok(
    options.sessions,
    'runner sessions are kept on disk so a task can resume after a restart',
  );
  assert.equal(
    options.mcpUrlForSandbox,
    undefined,
    'without a public URL the task gets the local one',
  );
});

test('sandbox runs get a gateway token bound to their budget, never the vendor key', async (t) => {
  const { stack, options, modelKeys } = await start(t, undefined, {
    ANTHROPIC_API_KEY: 'sk-master-not-a-key',
    OPENAI_API_KEY: 'sk-master-openai-not-a-key',
  });
  const access = options.modelAccess;
  assert.ok(access, 'the stack hands the fleet its model access');
  const claude = await access.issue({
    taskId: 'tsk_one',
    runner: 'claude-agent-sdk',
    budgetUsd: 0.01,
    budgetRootId: 'tsk_one',
  });
  assert.match(claude.apiKey, /^mkg_/u);
  assert.equal(claude.baseUrl, `${stack.gateway.server.url}/anthropic`);
  assert.ok(claude.meter, 'spend is metered per request');
  const codex = await access.issue({ taskId: 'tsk_two', runner: 'codex', budgetUsd: 1 });
  assert.equal(codex.baseUrl, `${stack.gateway.server.url}/openai/v1`);
  assert.equal(codex.searchUrl, undefined, 'no search key, no search');
  await assert.rejects(
    access.issue({ taskId: 'tsk_three', runner: 'claude-agent-sdk' }),
    /no budget/u,
  );

  const ask = (maxTokens: number) =>
    fetch(`${claude.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': claude.apiKey },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  const sent = await ask(100);
  assert.equal(sent.status, 500, 'the vendor answered');
  await sent.arrayBuffer();
  assert.deepEqual(
    modelKeys,
    ['/v1/messages sk-master-not-a-key'],
    'the vendor key is added on the host',
  );
  const tooDear = await ask(64_000);
  assert.equal(tooDear.status, 402, 'a request the budget cannot cover is refused');
  await tooDear.arrayBuffer();
  assert.deepEqual(
    modelKeys.filter((line) => line.startsWith('/v1/messages ')),
    ['/v1/messages sk-master-not-a-key'],
    'and never reaches the vendor',
  );

  await access.revokeForTask?.('tsk_one');
  const revoked = await ask(100);
  assert.equal(revoked.status, 401);
  await revoked.arrayBuffer();
});

test("a task's model requests are written to the spend journal a restart reads back", async (t) => {
  const { options, dataDir } = await start(t, undefined, {
    ANTHROPIC_API_KEY: 'sk-master-not-a-key',
  });
  const access = options.modelAccess;
  assert.ok(access);
  const grant = await access.issue({
    taskId: 'tsk_spend',
    runner: 'claude-agent-sdk',
    budgetUsd: 1,
    budgetRootId: 'tsk_spend',
  });
  const sent = await fetch(`${grant.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': grant.apiKey },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  await sent.arrayBuffer();
  // A second journal on the same file stands in for the next process.
  const next = new SqliteSpendJournal(join(dataDir, 'gateway-spend.db'));
  t.after(() => next.close());
  assert.deepEqual(
    next.unrecorded().map((spend) => spend.taskId),
    ['tsk_spend'],
    'the request was journaled under its task in the data directory',
  );
});

test('with a search key, runs get the web-search tool and a search paid from their token', async (t) => {
  const { stack, options, modelKeys } = await start(t, undefined, {
    OPENAI_API_KEY: 'sk-master-openai-not-a-key',
    DEEPSEEK_API_KEY: 'sk-search-not-a-key',
  });
  assert.deepEqual(
    options.sandboxTools?.map((tool) => tool.name),
    ['cite-check', 'web-search'],
  );
  const access = options.modelAccess;
  assert.ok(access);
  const codex = await access.issue({ taskId: 'tsk_s', runner: 'codex', budgetUsd: 0.01 });
  assert.equal(codex.searchUrl, `${stack.gateway.server.url}/search`);
  const response = await fetch(codex.searchUrl ?? '', {
    method: 'POST',
    headers: { authorization: `Bearer ${codex.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'tides' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    results: [{ title: 'Tides', url: 'https://e.test/tides', snippet: 'High at noon.' }],
  });
  assert.deepEqual(modelKeys, ['/v1/tools/search Bearer sk-search-not-a-key']);
  assert.equal(codex.meter?.spentUsd(), 0.00075, 'the call is paid from the run’s budget');
});

test('the conductor’s model requests go through the gateway, which adds the vendor key', async (t) => {
  const { stack, modelKeys, firstMessage } = await start(t, undefined, {
    ANTHROPIC_API_KEY: 'sk-master-not-a-key',
  });
  const token = stack.cloud.server.invites.create('test').token;
  const api = (path: string, body: unknown) =>
    fetch(`${stack.cloud.server.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const created = (await (await api('/v1/conversations', {})).json()) as {
    conversationId: string;
  };
  const posted = await api(`/v1/conversations/${created.conversationId}/messages`, {
    text: 'Hello.',
  });
  assert.equal(posted.status, 202);
  await firstMessage;
  const messages = modelKeys.filter((line) => line.startsWith('/v1/messages '));
  assert.ok(messages.length >= 1);
  assert.ok(
    messages.every((line) => line === '/v1/messages sk-master-not-a-key'),
    `the vendor gets the gateway's key only: ${messages.join(', ')}`,
  );
});

test('a stack that fails to start closes its gateway', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-stack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = readStackConfig({
    MAKA_CLOUD_DATA_DIR: dir,
    ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    INSTABOX_API_KEY: 'ibx-test-not-a-key',
    MAKA_CLOUD_SANDBOXES: SANDBOXES,
  });
  config.gateway.port = 0;
  let issued: Promise<ModelAccess> | undefined;
  await assert.rejects(
    startStack(
      config,
      { ANTHROPIC_API_KEY: 'sk-test-not-a-key' },
      {
        ownerOfTask: () => 'inv_early',
        createRunners: (given) => {
          issued = given.modelAccess?.issue({
            taskId: 'tsk_early',
            runner: 'claude-agent-sdk',
            budgetUsd: 1,
          });
          throw new Error('no fleet');
        },
      },
    ),
    /no fleet/u,
  );
  assert.ok(issued);
  const { baseUrl } = await issued;
  await assert.rejects(
    fetch(`${baseUrl}/v1/messages`, { method: 'POST', body: '{}' }),
    /fetch failed/u,
    'the gateway no longer listens',
  );
});

test('the MCP public URL replaces the local one for tasks', async (t) => {
  const { options, stack } = await start(t, 'https://mcp.example.test/mcp');
  assert.equal(
    options.mcpUrlForSandbox?.(stack.cloud.server.mcpUrl),
    'https://mcp.example.test/mcp',
  );
});

test('the input policy asks the restored orchestrator: finished tasks of the same conversation only', async (t) => {
  const { stack, options, claude } = await start(t);
  const orchestrator = stack.cloud.server.orchestrator;
  const policy = options.inputs;
  assert.ok(policy);
  const issued = orchestrator.issueSession();
  const session = orchestrator.authenticate(issued.token);
  assert.ok(session);
  const first = await orchestrator.delegate(session, { runner: 'claude-agent-sdk', brief: 'a' });
  await orchestrator.wait(session, first.taskId, 5_000);
  const second = await orchestrator.delegate(session, { runner: 'claude-agent-sdk', brief: 'b' });
  await orchestrator.wait(session, second.taskId, 5_000);
  assert.equal(claude.runs.length, 2);
  assert.equal(await policy.check({ target: second.taskId, source: first.taskId }), undefined);

  const other = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(other);
  const stranger = await orchestrator.delegate(other, { runner: 'claude-agent-sdk', brief: 'c' });
  await orchestrator.wait(other, stranger.taskId, 5_000);
  assert.match(
    String(await policy.check({ target: second.taskId, source: stranger.taskId })),
    /not part of this conversation/,
  );
  assert.match(
    String(await policy.check({ target: second.taskId, source: 'tsk_unknown' })),
    /not part of this conversation/,
  );
});

test('a task runs on the machine of the invite that owns it, and on no other', async (t) => {
  const inviteA = 'inv_aaaaaaaaaaaa';
  const inviteB = 'inv_bbbbbbbbbbbb';
  const { stack, options } = await start(t, undefined, {
    MAKA_CLOUD_SANDBOXES: JSON.stringify({ [inviteA]: 'mch_a', [inviteB]: 'mch_b' }),
  });
  const { tenantOf, sandboxes } = options;
  assert.ok(tenantOf && sandboxes, 'the stack decides the tenant and the sandboxes of its fleet');
  assert.equal((await sandboxes.acquire({ tenantId: inviteA, taskId: 't1' })).machineId, 'mch_a');
  assert.equal((await sandboxes.acquire({ tenantId: inviteB, taskId: 't2' })).machineId, 'mch_b');
  assert.deepEqual(sandboxes.knownMachines(), ['mch_a', 'mch_b']);
  // An invite with no machine of its own gets none, not a neighbour's.
  await assert.rejects(
    sandboxes.acquire({ tenantId: 'inv_cccccccccccc', taskId: 't3' }),
    /No sandbox is assigned/,
  );
  await assert.rejects(sandboxes.acquire({ tenantId: 'default', taskId: 't4' }), /No sandbox/);

  // A task that no invite owns has no tenant: it cannot start, so it cannot land anywhere.
  const orchestrator = stack.cloud.server.orchestrator;
  const loose = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(loose);
  const task = await orchestrator.delegate(loose, { runner: 'claude-agent-sdk', brief: 'x' });
  assert.throws(() => tenantOf(task.taskId), /no owning invite/);
  assert.throws(() => tenantOf('tsk_unknown'), /no owning invite/);
});

test('coding tasks go to the coding runner, and the stack runs the coding playbook with its pull request tool', async (t) => {
  const { stack, claude } = await start(t);
  const orchestrator = stack.cloud.server.orchestrator;
  const session = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(session);
  const task = await orchestrator.delegate(session, { runner: 'coding', brief: 'fix it' });
  const view = await orchestrator.wait(session, task.taskId, 5_000);
  assert.equal(view.state, 'failed');
  assert.match(view.failureReason ?? '', /coding-task/, 'the coding runner read the brief');
  assert.equal(claude.runs.length, 0, 'nothing reached an agent');
  assert.deepEqual(
    STACK_PLAYBOOKS.map((playbook) => playbook.id),
    ['research', 'coding', 'free'],
  );
  assert.equal(STACK_PLAYBOOKS[1], codingPlaybook);
});

/** A VAPID key pair the way a deployment would generate one: a P-256 key, base64url. */
function vapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    // A private key is 32 bytes, but getPrivateKey() drops leading zero bytes (1 key in 256).
    privateKey: Buffer.concat([Buffer.alloc(32), ecdh.getPrivateKey()])
      .subarray(-32)
      .toString('base64url'),
  };
}

test('the Web Push routes answer 404 without CLOUD_PUSH_* and serve the public key with it', async (t) => {
  const key = (started: Started, token: string) =>
    fetch(`${started.stack.cloud.server.url}/v1/push/key`, {
      headers: { authorization: `Bearer ${token}` },
    });
  const off = await start(t);
  assert.equal(
    (await key(off, off.stack.cloud.server.invites.create('off').token)).status,
    404,
    'push is off without its settings',
  );

  const vapid = vapidKeys();
  const on = await start(t, undefined, {
    CLOUD_PUSH_VAPID_PUBLIC: vapid.publicKey,
    CLOUD_PUSH_VAPID_PRIVATE: vapid.privateKey,
    CLOUD_PUSH_SUBJECT: 'mailto:ops@example.test',
  });
  const answer = await key(on, on.stack.cloud.server.invites.create('on').token);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { publicKey: vapid.publicKey });
});

test('Web Push settings that cannot sign stop the start, without the key in the message', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-stack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vapid = vapidKeys();
  const env = {
    ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    CLOUD_PUSH_VAPID_PUBLIC: vapid.publicKey,
    CLOUD_PUSH_VAPID_PRIVATE: 'not-a-private-key-secret',
    CLOUD_PUSH_SUBJECT: 'mailto:ops@example.test',
  };
  const config = readStackConfig({
    MAKA_CLOUD_DATA_DIR: dir,
    INSTABOX_API_KEY: 'ibx-test-not-a-key',
    MAKA_CLOUD_SANDBOXES: SANDBOXES,
    ...env,
  });
  config.port = 0;
  config.mcp.port = 0;
  config.gateway.port = 0;
  await assert.rejects(
    startStack(config, env, {
      createRunners: () =>
        ({ runners: [], sweepOrphans: async () => ({}) }) as unknown as CloudRunners,
    }).then((stack) => stack.close()),
    (error: Error) => {
      assert.match(error.message, /Web Push/u);
      assert.ok(!error.message.includes('not-a-private-key-secret'));
      return true;
    },
  );
});

test('model access is charged to the invite that owns the task, and a task nobody owns gets none', async (t) => {
  const { stack, options, modelKeys, owners } = await start(t, undefined, {
    ANTHROPIC_API_KEY: 'sk-master-not-a-key',
  });
  const invites = stack.cloud.server.invites;
  const open = invites.create('open').inviteId;
  const shut = invites.create('shut').inviteId;
  owners.set('tsk_open', open);
  owners.set('tsk_shut', shut);
  invites.setLimits(shut, { dailyUsd: 0 });
  const access = options.modelAccess;
  assert.ok(access);
  const grant = async (taskId: string) =>
    access.issue({ taskId, runner: 'claude-agent-sdk', budgetUsd: 1, budgetRootId: taskId });
  const ask = async (given: ModelAccess) => {
    const response = await fetch(`${given.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': given.apiKey },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await response.arrayBuffer();
    return response.status;
  };
  const sentToVendor = () => modelKeys.filter((line) => line.startsWith('/v1/messages ')).length;

  // The invite whose daily limit is 0 spends nothing; the other is not affected by it.
  assert.equal(await ask(await grant('tsk_shut')), 402);
  assert.equal(sentToVendor(), 0, 'the refused request never reached the vendor');
  assert.equal(await ask(await grant('tsk_open')), 500, 'the vendor answered');
  assert.equal(sentToVendor(), 1);
  // A change from the command line (here the same store) applies to the running server.
  invites.setLimits(shut, { dailyUsd: 5 });
  assert.equal(await ask(await grant('tsk_shut')), 500);
  assert.equal(sentToVendor(), 2);
  invites.revoke(shut);
  assert.equal(await ask(await grant('tsk_shut')), 402, 'a revoked invite may not spend');
  assert.equal(sentToVendor(), 2);
});

test('a spending limit that stops a task nobody can be told about is warned, and still refuses', async (t) => {
  const { stack, options, modelKeys, owners, warnings } = await start(t, undefined, {
    ANTHROPIC_API_KEY: 'sk-master-not-a-key',
  });
  const shut = stack.cloud.server.invites.create('shut').inviteId;
  stack.cloud.server.invites.setLimits(shut, { dailyUsd: 0 });
  owners.set('tsk_shut', shut);
  const access = options.modelAccess;
  assert.ok(access);
  const given = await access.issue({
    taskId: 'tsk_shut',
    runner: 'claude-agent-sdk',
    budgetUsd: 1,
    budgetRootId: 'tsk_shut',
  });
  const response = await fetch(`${given.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': given.apiKey },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  await response.arrayBuffer();
  assert.equal(response.status, 402);
  assert.deepEqual(
    modelKeys.filter((line) => line.startsWith('/v1/messages ')),
    [],
  );
  assert.equal(
    warnings.filter((message) => /no conversation could be told/u.test(message)).length,
    1,
    'a limit with nobody to tell is never silent',
  );
});

test('a task that no conversation owns gets no model access, and nothing reaches the vendor', async (t) => {
  const { stack, options, modelKeys } = await start(t, undefined, {}, false);
  const orchestrator = stack.cloud.server.orchestrator;
  const loose = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(loose);
  const task = await orchestrator.delegate(loose, { runner: 'claude-agent-sdk', brief: 'x' });
  const access = options.modelAccess;
  assert.ok(access);
  for (const taskId of [task.taskId, 'tsk_unknown']) {
    await assert.rejects(
      access.issue({ taskId, runner: 'claude-agent-sdk', budgetUsd: 1 }),
      /no owning invite/u,
    );
  }
  assert.deepEqual(modelKeys, []);
});

test('pausing refuses the next model request at once as unavailable, and resuming allows it', async (t) => {
  const { stack, options, modelKeys } = await start(t, undefined, {
    ANTHROPIC_API_KEY: 'sk-master-not-a-key',
  });
  const access = options.modelAccess;
  assert.ok(access);
  const grant = await access.issue({
    taskId: 'tsk_paused',
    runner: 'claude-agent-sdk',
    budgetUsd: 1,
    budgetRootId: 'tsk_paused',
  });
  const ask = async () => {
    const response = await fetch(`${grant.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': grant.apiKey },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await response.text();
    return { status: response.status, text };
  };
  const sent = () => modelKeys.filter((line) => line.startsWith('/v1/messages ')).length;

  assert.equal((await ask()).status, 500, 'the vendor answered');
  assert.equal(sent(), 1);
  stack.pause.pause();
  const refused = await ask();
  assert.equal(refused.status, 503, 'unavailable, not out of budget');
  assert.match(refused.text, /spending is paused/u);
  assert.equal(sent(), 1, 'the paused request never reached the vendor');
  assert.equal(grant.meter?.spentUsd(), 0, 'and cost nothing');
  stack.pause.resume();
  assert.equal((await ask()).status, 500, 'spending is allowed again');
  assert.equal(sent(), 2);
});

test('while paused the stack stops what is open through the conductor, and closing twice closes once', async (t) => {
  const { stack } = await start(t);
  const stops: Array<[string, string]> = [];
  const asked = deferred();
  const conductor = stack.cloud.conductor;
  conductor.stopAll = async (reason, notice) => {
    stops.push([reason, notice]);
    asked.resolve();
    return 0;
  };
  assert.deepEqual(stops, [], 'not paused: nothing is stopped');
  stack.pause.pause();
  await asked.promise;
  assert.equal(stops[0]?.[0], 'paused');
  assert.equal(stops[0]?.[1], PAUSED_NOTICE);
  stack.pause.resume();
  await stack.close();
  await stack.close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a running stack backs itself up: the copy restores, holds no key and no push subscription', async (t) => {
  const backupDir = await mkdtemp(join(tmpdir(), 'cloud-host-backups-'));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  const vapid = vapidKeys();
  const env = {
    MAKA_CLOUD_BACKUP_DIR: backupDir,
    CLOUD_PUSH_VAPID_PUBLIC: vapid.publicKey,
    CLOUD_PUSH_VAPID_PRIVATE: vapid.privateKey,
    CLOUD_PUSH_SUBJECT: 'mailto:ops@example.test',
  };
  const started = await start(t, undefined, env);
  const { stack, dataDir } = started;
  const invite = stack.cloud.server.invites.create('backed up');
  const headers = { authorization: `Bearer ${invite.token}`, 'content-type': 'application/json' };
  const created = await fetch(`${stack.cloud.server.url}/v1/conversations`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const { conversationId } = (await created.json()) as { conversationId: string };
  const deviceSecret = randomBytes(16).toString('base64url');
  const subscribed = await fetch(`${stack.cloud.server.url}/v1/push/subscriptions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      keys: { p256dh: vapid.publicKey, auth: deviceSecret },
    }),
  });
  assert.equal(subscribed.status, 201);

  const done = await stack.backup();
  const layout = backupLayoutOf(dataDir);
  const manifest = await verifyBackup(done.path, layout);
  for (const name of ['cloud.db', 'invites.db', 'supervisor.db', 'gateway-spend.db']) {
    assert.ok(
      manifest.files.some((file) => file.path === name),
      `${name} is in the backup`,
    );
  }
  const secrets = [
    'sk-test-not-a-key',
    'ibx-test-not-a-key',
    vapid.privateKey,
    deviceSecret,
    invite.token,
    invite.token.split('.')[1] ?? 'missing',
  ];
  for (const file of manifest.files) {
    const bytes = await readFile(join(done.path, file.path));
    for (const secret of secrets) {
      assert.ok(
        !bytes.includes(Buffer.from(secret)),
        `${file.path} holds no ${secret.slice(0, 6)}…`,
      );
    }
  }

  await stack.close();
  const restored = await restoreBackup({
    dataDir,
    backupDir,
    stamp: done.stamp,
    layout,
  });
  assert.ok(restored.files >= 4);
  const cloud = new DatabaseSync(join(dataDir, 'cloud.db'), { readOnly: true });
  assert.equal(
    cloud
      .prepare('SELECT count(*) AS n FROM conversations WHERE conversation_id = ?')
      .get(conversationId)?.n,
    1,
    'the conversation survived the round trip',
  );
  assert.equal(cloud.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n, 0);
  cloud.close();
  const invites = new DatabaseSync(join(dataDir, 'invites.db'), { readOnly: true });
  assert.equal(
    invites.prepare('SELECT count(*) AS n FROM invites WHERE invite_id = ?').get(invite.inviteId)
      ?.n,
    1,
  );
  invites.close();
});

test('the stack writes the day’s backup by itself once it is running, and says so', async (t) => {
  const backupDir = await mkdtemp(join(tmpdir(), 'cloud-host-backups-'));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  let written: (event: string) => void = () => undefined;
  const first = new Promise<string>((resolve) => {
    written = resolve;
  });
  const events: Array<[string, Record<string, string | number>]> = [];
  const started = await start(t, undefined, { MAKA_CLOUD_BACKUP_DIR: backupDir }, true, {
    backupTiming: { firstTickMs: 5, tickMs: 5 },
    onInfo: (event, fields) => {
      events.push([event, fields]);
      if (event === 'backup.written') written(String(fields.stamp));
    },
  });
  const stamp = await first;
  assert.deepEqual(
    (await listBackups(backupDir)).map((entry) => entry.stamp),
    [stamp],
  );
  assert.equal(events[0]?.[0], 'backup.written');
  await started.stack.close();
  assert.deepEqual(started.warnings, [], 'nothing was reported');
});

test('without MAKA_CLOUD_BACKUP_DIR the stack writes no backups and refuses to be asked for one', async (t) => {
  const started = await start(t);
  await assert.rejects(started.stack.backup(), /MAKA_CLOUD_BACKUP_DIR is not set/u);
});

test('the owner’s devices are told once when the day’s spend reaches the alert amount, and nobody else’s', async (t) => {
  const vapid = vapidKeys();
  const calls: Array<{ endpoint: string; headers: Record<string, string> }> = [];
  let owner: { inviteId: string; token: string } | undefined;
  const started = await start(
    t,
    undefined,
    {
      CLOUD_PUSH_VAPID_PUBLIC: vapid.publicKey,
      CLOUD_PUSH_VAPID_PRIVATE: vapid.privateKey,
      CLOUD_PUSH_SUBJECT: 'mailto:ops@example.test',
      MAKA_CLOUD_SPEND_ALERT_USD: '1',
    },
    true,
    {
      spendAlertTiming: { pollMs: 3_600_000 },
      pushTransport: async (request) => {
        calls.push({ endpoint: request.endpoint, headers: request.headers });
        return { status: 201 };
      },
    },
    (dir) => {
      // The owner exists before the stack starts, so its id can be set as the alert's owner.
      const store = new InviteStore(join(dir, 'invites.db'));
      owner = store.create('owner');
      store.close();
      return { MAKA_CLOUD_OWNER_INVITE: owner.inviteId };
    },
  );
  assert.ok(owner);
  const other = started.stack.cloud.server.invites.create('someone else');
  const subscribe = async (token: string, endpoint: string): Promise<void> => {
    const response = await fetch(`${started.stack.cloud.server.url}/v1/push/subscriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint,
        keys: { p256dh: vapid.publicKey, auth: randomBytes(16).toString('base64url') },
      }),
    });
    assert.equal(response.status, 201);
  };
  const ownerDevice = 'https://fcm.googleapis.com/fcm/send/owner-1';
  const otherDevice = 'https://fcm.googleapis.com/fcm/send/other-1';
  await subscribe(owner.token, ownerDevice);
  await subscribe(other.token, otherDevice);

  // Another process books spend into the same ledger file the gateway counts against.
  const books = new SqliteSpendJournal(join(started.dataDir, 'gateway-spend.db'));
  t.after(() => books.close());
  const ledger = books.accountLedger({
    limitsOf: () => ({ dailyUsd: 100, monthlyUsd: 1000 }),
    serverDailyUsd: () => 1000,
  });
  assert.deepEqual(ledger.reserve({ inviteId: other.inviteId }, 'k1', 0.6), { ok: true });
  await started.stack.checkSpendAlert();
  assert.equal(calls.length, 0, 'below the amount nobody is told');

  assert.deepEqual(ledger.reserve({ inviteId: other.inviteId }, 'k2', 0.5), { ok: true });
  await started.stack.checkSpendAlert();
  assert.deepEqual(
    calls.map((call) => call.endpoint),
    [ownerDevice],
    'only the owner’s device, once',
  );
  assert.equal(calls[0]?.headers.Urgency, 'high');
  await started.stack.checkSpendAlert();
  await started.stack.checkSpendAlert();
  assert.equal(calls.length, 1, 'asking again the same day sends nothing');
});

test('without a spend alert set the check does nothing', async (t) => {
  const started = await start(t);
  await started.stack.checkSpendAlert();
});

/** A process of its own, like the evals next to a running server: its environment is its own. */
function evalProcess(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string; err: string }> {
  const index = fileURLToPath(new URL('../index.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', script, index],
      { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out, err }));
  });
}

/** What the evals do: open the server's ledger from the data directory and reserve $0.25 until refused. */
const BOOK_UNTIL_REFUSED = `
const index = process.argv.at(-1);
const { readStackConfig, openServerLedger, explicitSpendCaps } = await import(index);
const env = process.env;
const config = readStackConfig({ ...env }, { sandboxes: 'single-machine' });
const ledger = openServerLedger(config, explicitSpendCaps ? { expected: explicitSpendCaps(env) } : undefined);
let granted = 0;
for (let i = 0; i < 100; i += 1) {
  const result = ledger.accounts.reserve({ inviteId: env.MAKA_EVALS_INVITE_ID }, 'eval-' + i, 0.25);
  if (!result.ok) break;
  granted += 1;
}
console.log(granted);
ledger.close();
`;

function evalEnv(started: Started, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MAKA_CLOUD_DATA_DIR: started.dataDir,
    MAKA_EVALS_INVITE_ID: started.inviteId,
    ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    INSTABOX_API_KEY: 'ibx-test-not-a-key',
    INSTABOX_MACHINE_ID: 'mch_eval',
    ...extra,
  };
}

test('another process booking spend on the server runs under the server’s caps, not its own settings', async (t) => {
  // The server's daily cap is $1; the evals' environment says nothing, so its own default is $25.
  const started = await start(t, undefined, { MAKA_CLOUD_SERVER_DAILY_USD: '1' });
  const run = await evalProcess(BOOK_UNTIL_REFUSED, evalEnv(started));
  assert.equal(run.code, 0, run.err);
  assert.equal(
    Number(run.out.trim()) * 0.25,
    1,
    `the evals booked $${Number(run.out.trim()) * 0.25} against a server that allows $1 a day`,
  );
});

test('an evals process whose own cap differs from the running server’s refuses to start', async (t) => {
  const started = await start(t, undefined, { MAKA_CLOUD_SERVER_DAILY_USD: '1' });
  const run = await evalProcess(
    BOOK_UNTIL_REFUSED,
    evalEnv(started, { MAKA_CLOUD_SERVER_DAILY_USD: '25' }),
  );
  assert.notEqual(run.code, 0, 'it did not start');
  assert.match(run.err, /MAKA_CLOUD_SERVER_DAILY_USD/u);
  assert.equal(run.out.trim(), '', 'and booked nothing');
  const same = await evalProcess(
    BOOK_UNTIL_REFUSED,
    evalEnv(started, { MAKA_CLOUD_SERVER_DAILY_USD: '1' }),
  );
  assert.equal(same.code, 0, same.err);
});

test('the server’s caps are read at each booking: a restart with other caps applies to a ledger already open', async (t) => {
  const started = await start(t, undefined, { MAKA_CLOUD_SERVER_DAILY_USD: '1' });
  const config = readStackConfig(
    {
      MAKA_CLOUD_DATA_DIR: started.dataDir,
      ANTHROPIC_API_KEY: 'sk-test-not-a-key',
      INSTABOX_API_KEY: 'ibx-test-not-a-key',
      INSTABOX_MACHINE_ID: 'mch_eval',
    },
    { sandboxes: 'single-machine' },
  );
  const ledger = openServerLedger(config);
  t.after(() => ledger.close());
  const account = { inviteId: started.inviteId };
  let granted = 0;
  while (ledger.accounts.reserve(account, `a-${granted}`, 0.25).ok) granted += 1;
  assert.equal(granted, 4);
  // The server restarts with a daily cap of $2: it writes its caps down again.
  const journal = new SqliteSpendJournal(config.gatewaySpendPath);
  t.after(() => journal.close());
  journal.setSpendPolicy({ ...config.spend, serverDailyUsd: 2 });
  assert.equal(ledger.accounts.reserve(account, 'after-restart', 0.25).ok, true);
});

test('a data directory whose server never wrote its caps down is not booked to', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-nopolicy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = readStackConfig(
    {
      MAKA_CLOUD_DATA_DIR: dir,
      ANTHROPIC_API_KEY: 'sk-test-not-a-key',
      INSTABOX_API_KEY: 'ibx-test-not-a-key',
      INSTABOX_MACHINE_ID: 'mch_eval',
    },
    { sandboxes: 'single-machine' },
  );
  new InviteStore(config.invitesPath).close();
  new SqliteSpendJournal(config.gatewaySpendPath).close();
  assert.throws(() => openServerLedger(config), /caps|limits/u);
});
