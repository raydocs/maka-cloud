import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { FakeRunner } from '@maka-cloud/orchestrator';
import { codingPlaybook } from '@maka-cloud/playbooks/coding';
import type { CloudRunners, CloudRunnersOptions } from '@maka-cloud/runners';
import { readStackConfig } from '../config.js';
import { STACK_PLAYBOOKS, type Stack, startStack } from '../stack.js';

interface Started {
  stack: Stack;
  options: Partial<CloudRunnersOptions>;
  claude: FakeRunner;
  modelRequests: () => number;
  sweeps: string[][];
}

async function start(t: TestContext, publicUrl?: string): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-stack-'));
  let requests = 0;
  const model = createServer((_req, res) => {
    requests += 1;
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
  const claude = new FakeRunner({
    name: 'claude-agent-sdk',
    onStart: (run) => {
      setImmediate(() => void run.complete());
    },
  });
  const codex = new FakeRunner({ name: 'codex' });
  const sweeps: string[][] = [];
  let options: Partial<CloudRunnersOptions> = {};
  const stack = await startStack(
    config,
    {},
    {
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
    },
  );
  t.after(async () => {
    await stack.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { stack, options, claude, modelRequests: () => requests, sweeps };
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
