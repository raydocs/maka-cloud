import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { FakeRunner } from '@maka-cloud/orchestrator';
import { codingPlaybook } from '@maka-cloud/playbooks/coding';
import type { CloudRunners, CloudRunnersOptions, ModelAccess } from '@maka-cloud/runners';
import { readStackConfig } from '../config.js';
import { STACK_PLAYBOOKS, type Stack, startStack } from '../stack.js';

interface Started {
  stack: Stack;
  options: Partial<CloudRunnersOptions>;
  claude: FakeRunner;
  modelRequests: () => number;
  /** The path and API key of each model request. */
  modelKeys: string[];
  sweeps: string[][];
}

async function start(
  t: TestContext,
  publicUrl?: string,
  env: NodeJS.ProcessEnv = {},
): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-stack-'));
  let requests = 0;
  const modelKeys: string[] = [];
  const model = createServer((req, res) => {
    requests += 1;
    modelKeys.push(`${req.url} ${req.headers['x-api-key'] ?? req.headers.authorization}`);
    req.resume();
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
      INSTABOX_MACHINE_ID: 'mch_test',
      ...(publicUrl === undefined ? {} : { MAKA_CLOUD_MCP_PUBLIC_URL: publicUrl }),
    }),
    port: 0,
  };
  config.mcp.port = 0;
  config.gateway.port = 0;
  const claude = new FakeRunner({
    name: 'claude-agent-sdk',
    onStart: (run) => {
      setImmediate(() => void run.complete());
    },
  });
  const codex = new FakeRunner({ name: 'codex' });
  const sweeps: string[][] = [];
  let options: Partial<CloudRunnersOptions> = {};
  const stack = await startStack(config, env, {
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
  t.after(async () => {
    await stack.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { stack, options, claude, modelRequests: () => requests, modelKeys, sweeps };
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

test('a stack that fails to start closes its gateway', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-stack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = readStackConfig({
    MAKA_CLOUD_DATA_DIR: dir,
    ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    INSTABOX_API_KEY: 'ibx-test-not-a-key',
    INSTABOX_MACHINE_ID: 'mch_test',
  });
  config.gateway.port = 0;
  let issued: Promise<ModelAccess> | undefined;
  await assert.rejects(
    startStack(
      config,
      { ANTHROPIC_API_KEY: 'sk-test-not-a-key' },
      {
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
