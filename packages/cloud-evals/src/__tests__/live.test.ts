import assert from 'node:assert/strict';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqliteSpendJournal } from '@maka-cloud/gateway';
import { explicitSpendCaps, InviteStore } from '@maka-cloud/host';
import type { CloudRunners, CloudRunnersOptions } from '@maka-cloud/runners';
import { createLiveDeps, type EvalDeps } from '../live.js';
import { makeSpec } from '../spec-gen.js';
import type { SubjectId } from '../types.js';
import { TASK, tempDir } from './fixtures.js';

const ANTHROPIC_KEY = 'sk-ant-master-not-a-key';
const OPENAI_KEY = 'sk-openai-master-not-a-key';
const CODEX_PRICE = JSON.stringify([
  {
    vendor: 'openai',
    model: 'gpt-test',
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 4,
    maxOutputTokens: 4096,
  },
]);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Vendor {
  url: string;
  /** `path key` of every model request the vendor received (token counts are free and not listed). */
  seen: string[];
}

async function fakeVendor(t: TestContext): Promise<Vendor> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    if (req.url?.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":12}');
      return;
    }
    seen.push(`${req.url} ${req.headers['x-api-key'] ?? req.headers.authorization}`);
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

interface Setup {
  env: NodeJS.ProcessEnv;
  /** The data directory of the server the run is booked to. */
  serverDir: string;
  /** The invite the run is booked to. */
  inviteId: string;
  invites: InviteStore;
  stateDir: string;
  workRoot: string;
  built: Partial<CloudRunnersOptions>[];
  load(subjects?: readonly SubjectId[]): Promise<EvalDeps>;
}

async function setup(
  t: TestContext,
  over: NodeJS.ProcessEnv = {},
  vendorUrl?: string,
): Promise<Setup> {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'data');
  await mkdir(dataDir);
  await writeFile(
    join(dataDir, 'swe-bench-verified.jsonl'),
    `${JSON.stringify({
      instance_id: 'a__a-1',
      repo: 'a/a',
      base_commit: 'b'.repeat(40),
      problem_statement: 'statement',
      test_patch: 'patch',
      FAIL_TO_PASS: ['f'],
      PASS_TO_PASS: ['p'],
    })}\n`,
  );
  // The server the run is booked to has run here: it has an invites file and a spend journal.
  const serverDir = join(dir, 'server');
  await mkdir(serverDir);
  const invites = new InviteStore(join(serverDir, 'invites.db'));
  t.after(() => invites.close());
  const inviteId = invites.create('evals').inviteId;
  // ...and has written down the caps it runs under, as the stack does at each start.
  const serverJournal = new SqliteSpendJournal(join(serverDir, 'gateway-spend.db'));
  serverJournal.setSpendPolicy({
    inviteDailyUsd: 5,
    inviteMonthlyUsd: 50,
    serverDailyUsd: 25,
    ...explicitSpendCaps(over),
  });
  serverJournal.close();
  const env: NodeJS.ProcessEnv = {
    MAKA_CLOUD_DATA_DIR: serverDir,
    MAKA_EVALS_INVITE_ID: inviteId,
    MAKA_EVALS_DATA_DIR: dataDir,
    MAKA_EVALS_PYTHON: 'python3',
    INSTABOX_API_KEY: 'ibx-test-not-a-key',
    INSTABOX_MACHINE_ID: 'mch_test',
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    OPENAI_API_KEY: OPENAI_KEY,
    MAKA_CLOUD_GATEWAY_MODELS: CODEX_PRICE,
    MAKA_CLOUD_GATEWAY_PORT: String(await freePort()),
    ...(vendorUrl === undefined
      ? {}
      : { ANTHROPIC_BASE_URL: vendorUrl, OPENAI_BASE_URL: vendorUrl }),
    ...over,
  };
  const stateDir = join(dir, 'out');
  const built: Partial<CloudRunnersOptions>[] = [];
  return {
    env,
    serverDir,
    inviteId,
    invites,
    stateDir,
    workRoot: join(dir, 'work'),
    built,
    async load(subjects) {
      const spec = makeSpec({
        suite: 'swe-bench-verified',
        tasks: [TASK],
        benchmarkVersion: 'sha256:0000000000000000',
        taskBudgetUsd: 1,
        totalBudgetUsd: 3,
        mode: 'live',
        ...(subjects ? { subjects } : {}),
      });
      await mkdir(join(dir, 'work'), { recursive: true });
      const deps = await createLiveDeps(spec, join(dir, 'work'), env, {
        stateDir,
        createRunners: (options) => {
          built.push(options);
          const stub = { name: 'stub' };
          return {
            runners: [stub, stub],
            claude: { ...stub, name: 'claude-agent-sdk' },
            codex: { ...stub, name: 'codex' },
            fleet: {},
          } as unknown as CloudRunners;
        },
      });
      t.after(() => deps.close?.());
      return deps;
    },
  };
}

test('a live run without a key for a subject’s vendor is refused before anything is built', async (t) => {
  const s = await setup(t, { OPENAI_API_KEY: '' });
  await assert.rejects(s.load(), /OPENAI_API_KEY is not set/u);
  assert.equal(s.built.length, 0, 'no fleet was built');
  // A Claude-only spec needs no OpenAI key.
  await s.load(['claude-agent-sdk']);
  assert.equal(s.built.length, 1);
});

test('a live run with Codex but no OpenAI price is refused', async (t) => {
  const s = await setup(t, { MAKA_CLOUD_GATEWAY_MODELS: '[]' });
  await assert.rejects(s.load(), /no OpenAI model/u);
  assert.equal(s.built.length, 0);
});

test('a live run without the sandbox fleet or its settings is refused', async (t) => {
  const s = await setup(t, { INSTABOX_MACHINE_ID: '' });
  await assert.rejects(s.load(), /INSTABOX_MACHINE_ID is not set/u);
  const bad = await setup(t, { MAKA_CLOUD_GATEWAY_MODELS: 'not json' });
  await assert.rejects(bad.load(), /MAKA_CLOUD_GATEWAY_MODELS is not JSON/u);
});

test('sandbox runs get a gateway token for their own budget, never a vendor key', async (t) => {
  const vendor = await fakeVendor(t);
  const s = await setup(t, {}, vendor.url);
  const deps = await s.load();
  assert.equal(s.built.length, 1);
  const access = s.built[0]?.modelAccess;
  assert.ok(access, 'the fleet gets the gateway’s model access');

  const claude = await access.issue({
    taskId: 'tsk_a',
    runner: 'claude-agent-sdk',
    budgetUsd: 0.01,
  });
  const codex = await access.issue({ taskId: 'tsk_b', runner: 'codex', budgetUsd: 0.5 });
  for (const grant of [claude, codex]) {
    assert.match(grant.apiKey, /^mkg_/u);
    assert.ok(grant.meter, 'spend is metered by the gateway, request by request');
    const shown = JSON.stringify({ ...grant, revoke: undefined, meter: undefined });
    assert.ok(!shown.includes(ANTHROPIC_KEY) && !shown.includes(OPENAI_KEY));
    assert.ok(!grant.baseUrl?.startsWith(vendor.url), 'the sandbox is pointed at the gateway');
  }
  await assert.rejects(
    access.issue({ taskId: 'tsk_c', runner: 'claude-agent-sdk' }),
    /no budget/u,
    'a run without a budget gets no access',
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
  const tooDear = await ask(64_000);
  assert.equal(tooDear.status, 402, 'a request the cell’s cap cannot cover is refused');
  await tooDear.arrayBuffer();
  assert.deepEqual(vendor.seen, [], 'and never reaches the vendor');
  const sent = await ask(100);
  await sent.arrayBuffer();
  assert.deepEqual(vendor.seen, [`/v1/messages ${ANTHROPIC_KEY}`], 'the host adds the key');

  await deps.close?.();
  await assert.rejects(ask(100), 'the gateway no longer listens once the run is over');
  assert.equal(vendor.seen.length, 1);
});

test('the spend journal lives in the experiment directory, not the scratch directory', async (t) => {
  const s = await setup(t);
  await s.load();
  assert.ok((await stat(join(s.stateDir, 'gateway-spend.db'))).isFile());
});

/** One model request through the run's gateway token. */
async function ask(s: Setup, deps: EvalDeps, taskId = 'tsk_cap'): Promise<number> {
  void deps;
  const access = s.built.at(-1)?.modelAccess;
  assert.ok(access);
  const grant = await access.issue({ taskId, runner: 'claude-agent-sdk', budgetUsd: 1 });
  const response = await fetch(`${grant.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': grant.apiKey },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  await response.arrayBuffer();
  return response.status;
}

test('a live run is booked to an invite of the server it runs next to, and counts against its caps', async (t) => {
  const vendor = await fakeVendor(t);
  const s = await setup(t, {}, vendor.url);
  const deps = await s.load();
  assert.equal(await ask(s, deps), 500, 'within the caps, the vendor answered');
  assert.equal(vendor.seen.length, 1);
  const db = new DatabaseSync(join(s.serverDir, 'gateway-spend.db'), { readOnly: true });
  t.after(() => db.close());
  const rows = db.prepare('SELECT DISTINCT account FROM account_spend').all() as Array<{
    account: string;
  }>;
  assert.deepEqual(
    rows.map((row) => row.account),
    [s.inviteId],
    'the spend is the invite’s, in the server’s own ledger',
  );
  // The invite's own limit applies to the benchmark too.
  s.invites.setLimits(s.inviteId, { dailyUsd: 0 });
  assert.equal(await ask(s, deps, 'tsk_cap2'), 402);
  assert.equal(vendor.seen.length, 1, 'the refused request never reached the vendor');
});

test('with the server’s daily cap at zero a live run sends nothing', async (t) => {
  const vendor = await fakeVendor(t);
  const s = await setup(t, { MAKA_CLOUD_SERVER_DAILY_USD: '0' }, vendor.url);
  const deps = await s.load();
  assert.equal(await ask(s, deps), 402);
  assert.deepEqual(vendor.seen, []);
});

test('a live run whose environment sets a cap the server does not run under is refused before anything is built', async (t) => {
  const vendor = await fakeVendor(t);
  const s = await setup(t, {}, vendor.url);
  // The server runs under $25 a day; this environment says $100.
  s.env.MAKA_CLOUD_SERVER_DAILY_USD = '100';
  await assert.rejects(s.load(), /MAKA_CLOUD_SERVER_DAILY_USD/u);
  assert.equal(s.built.length, 0, 'no runner was built');
  assert.deepEqual(vendor.seen, []);
});

test('a live run is refused when the server never wrote its caps down, and does not use its own', async (t) => {
  const s = await setup(t);
  const db = new DatabaseSync(join(s.serverDir, 'gateway-spend.db'));
  db.exec('DELETE FROM spend_policy');
  db.close();
  await assert.rejects(s.load(), /not written its spending limits/u);
  assert.equal(s.built.length, 0);
});

test('while the server is paused a live run sends nothing, and resuming lets it through', async (t) => {
  const vendor = await fakeVendor(t);
  const s = await setup(t, {}, vendor.url);
  const deps = await s.load();
  const paused = join(s.serverDir, 'paused');
  await writeFile(paused, '{}');
  const refused = await ask(s, deps);
  assert.ok(refused >= 400 && refused !== 500, `refused, got ${refused}`);
  assert.deepEqual(vendor.seen, []);
  await rm(paused);
  assert.equal(await ask(s, deps, 'tsk_after'), 500, 'the vendor answered once resumed');
  assert.equal(vendor.seen.length, 1);
});

test('a live run without the server’s data directory or an invite to book to is refused before anything is built', async (t) => {
  for (const [name, over, expected] of [
    ['no server directory', { MAKA_CLOUD_DATA_DIR: '' }, /MAKA_CLOUD_DATA_DIR is not set/u],
    ['no invite', { MAKA_EVALS_INVITE_ID: '' }, /MAKA_EVALS_INVITE_ID is not set/u],
    ['unknown invite', { MAKA_EVALS_INVITE_ID: 'inv_nobody' }, /not an active invite/u],
  ] as const) {
    const s = await setup(t, over);
    await assert.rejects(s.load(), expected, name);
    assert.equal(s.built.length, 0, `${name}: no fleet was built`);
  }
  const revoked = await setup(t);
  revoked.invites.revoke(revoked.inviteId);
  await assert.rejects(revoked.load(), /not an active invite/u);
  assert.equal(revoked.built.length, 0);
});

test('a server directory that has never run is refused, and one that is the experiment directory too', async (t) => {
  const fresh = await setup(t);
  await rm(join(fresh.serverDir, 'gateway-spend.db'), { force: true });
  await rm(join(fresh.serverDir, 'gateway-spend.db-wal'), { force: true });
  await rm(join(fresh.serverDir, 'gateway-spend.db-shm'), { force: true });
  await assert.rejects(fresh.load(), /has not run here/u);
  assert.equal(fresh.built.length, 0);
  const same = await setup(t);
  same.env.MAKA_CLOUD_DATA_DIR = same.stateDir;
  await assert.rejects(same.load(), /is the server data directory/u);
});
