import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  accountPort,
  Allowance,
  type JournalTotals,
  LimitPort,
  type ReserveResult,
  RUN_LEASE_MS,
  SqliteSpendJournal,
  setRunBudget,
} from '@maka-cloud/gateway';
import { createLiveSmokeDeps, smokeCapProblem, smokeCommand } from '../smoke-live.js';
import { SMOKE_VARIABLES, type SmokeSettings, smokeGate } from '../smoke.js';

const TOKEN = 'mki_secret-token-for-the-smoke-invite';
const INVITE = 'inv_0123456789ab';

const LIVE_ENV: NodeJS.ProcessEnv = {
  MAKA_CLOUD_LIVE: '1',
  MAKA_CLOUD_SMOKE_URL: 'https://cloud.example.com',
  MAKA_CLOUD_SMOKE_TOKEN: TOKEN,
  MAKA_CLOUD_SMOKE_INVITE_ID: INVITE,
  MAKA_CLOUD_SMOKE_REPO: 'scratch-owner/scratch-repo',
  MAKA_CLOUD_SMOKE_MAX_USD: '5',
  MAKA_CLOUD_DATA_DIR: '/var/lib/maka-cloud',
  MAKA_CLOUD_SMOKE_RESTART_CMD: '["systemctl","restart","maka-cloud"]',
};

/** Fails the test if anything outside the gate is touched. */
function untouchable(): {
  io: NonNullable<Parameters<typeof smokeCommand>[1]>;
  touched: string[];
  printed: string[];
} {
  const touched: string[] = [];
  const printed: string[] = [];
  return {
    touched,
    printed,
    io: {
      print: (line) => printed.push(line),
      fetch: (() => {
        touched.push('fetch');
        return Promise.reject(new Error('no request may be sent'));
      }) as typeof fetch,
      readTotals: () => {
        touched.push('readTotals');
        throw new Error('no journal may be read');
      },
      runBudget: {
        enforced: () => {
          touched.push('runBudget');
          throw new Error('no journal may be opened');
        },
        set: () => {
          touched.push('runBudget');
        },
        renew: () => {
          touched.push('runBudget');
          return true;
        },
        clear: () => {
          touched.push('runBudget');
          return true;
        },
      },
      openInvites: () => {
        touched.push('openInvites');
        throw new Error('no invites file may be opened');
      },
      run: () => {
        touched.push('run');
        return Promise.reject(new Error('nothing may be restarted'));
      },
    },
  };
}

test('smoke refuses without MAKA_CLOUD_LIVE=1 and touches nothing', async () => {
  for (const live of [undefined, '', '0', 'true', 'yes', '11', ' 1']) {
    const { io, touched, printed } = untouchable();
    const env = { ...LIVE_ENV };
    if (live === undefined) delete env.MAKA_CLOUD_LIVE;
    else env.MAKA_CLOUD_LIVE = live;
    assert.equal(await smokeCommand(env, io), 2, `MAKA_CLOUD_LIVE=${String(live)}`);
    assert.deepEqual(touched, [], `MAKA_CLOUD_LIVE=${String(live)}`);
    assert.match(printed.join('\n'), /MAKA_CLOUD_LIVE=1/u);
    assert.equal(printed.join('\n').includes(TOKEN), false);
  }
});

test('smoke refuses with a setting missing or wrong, names it, and touches nothing', async () => {
  const wrong: Array<[string, string | undefined]> = [
    ['MAKA_CLOUD_SMOKE_URL', undefined],
    ['MAKA_CLOUD_SMOKE_TOKEN', undefined],
    ['MAKA_CLOUD_SMOKE_INVITE_ID', 'not-an-invite'],
    ['MAKA_CLOUD_SMOKE_REPO', 'no-slash'],
    ['MAKA_CLOUD_SMOKE_MAX_USD', undefined],
    ['MAKA_CLOUD_SMOKE_MAX_USD', '-1'],
    ['MAKA_CLOUD_SMOKE_MAX_USD', '0'],
    ['MAKA_CLOUD_SMOKE_MAX_USD', '5000'],
    ['MAKA_CLOUD_DATA_DIR', undefined],
    ['MAKA_CLOUD_SMOKE_RESTART_CMD', 'systemctl restart maka-cloud'],
    ['MAKA_CLOUD_SMOKE_RESTART_CMD', '[]'],
    ['MAKA_CLOUD_SMOKE_URL', 'ftp://cloud.example.com'],
    ['MAKA_CLOUD_SMOKE_URL', 'https://user:pass@cloud.example.com'],
  ];
  for (const [name, value] of wrong) {
    const { io, touched, printed } = untouchable();
    const env = { ...LIVE_ENV };
    if (value === undefined) delete env[name];
    else env[name] = value;
    assert.equal(await smokeCommand(env, io), 2, `${name}=${String(value)}`);
    assert.deepEqual(touched, [], `${name}=${String(value)}`);
    const out = printed.join('\n');
    assert.ok(out.includes(name), `${name}=${String(value)} is named`);
    assert.equal(out.includes(TOKEN), false);
    assert.equal(out.includes('pass@'), false, 'a value is never printed');
  }
});

test('the gate accepts the full environment and keeps the restart command as an argument list', () => {
  const gate = smokeGate(LIVE_ENV);
  assert.ok(gate.ok);
  assert.deepEqual(gate.settings.restartCommand, ['systemctl', 'restart', 'maka-cloud']);
});

interface Stub {
  url: string;
  requests: Array<{
    method: string;
    path: string;
    authorization: string | undefined;
    body: string;
  }>;
  setHandler(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): void;
  close(): Promise<void>;
}

async function stub(): Promise<Stub> {
  const requests: Stub['requests'] = [];
  let handler: Parameters<Stub['setHandler']>[0] = (_req, res) => res.writeHead(404).end();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    setHandler: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const frame = (id: number, event: string, data: unknown): string =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function settingsFor(url: string, extra: Partial<SmokeSettings> = {}): SmokeSettings {
  return {
    url,
    token: TOKEN,
    inviteId: INVITE,
    repo: 'scratch-owner/scratch-repo',
    maxUsd: 5,
    dataDir: '/data',
    restartCommand: ['systemctl', 'restart', 'maka-cloud'],
    ...extra,
  };
}

test('the adapter speaks the public API as the smoke invite, with its token and nothing else', async () => {
  const server = await stub();
  try {
    server.setHandler((req, res) => {
      if (req.url === '/v1/conversations') return json(res, 201, { conversationId: 'c1' });
      if (req.url === '/v1/conversations/c1/messages') return json(res, 202, { messageId: 'm1' });
      if (req.url === '/v1/conversations/c1/answers') return json(res, 200, { accepted: true });
      if (req.url === '/v1/tasks/t1/cancel') return json(res, 200, {});
      json(res, 404, { error: 'not_found' });
    });
    const deps = createLiveSmokeDeps(settingsFor(server.url));
    assert.equal(await deps.startConversation(), 'c1');
    await deps.say('c1', 'hello');
    await deps.answer('c1', 'q1', 'approve');
    await deps.cancel('t1');
    assert.deepEqual(
      server.requests.map((r) => [r.method, r.path]),
      [
        ['POST', '/v1/conversations'],
        ['POST', '/v1/conversations/c1/messages'],
        ['POST', '/v1/conversations/c1/answers'],
        ['POST', '/v1/tasks/t1/cancel'],
      ],
    );
    for (const request of server.requests) assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(server.requests[1]?.body ?? ''), { text: 'hello' });
    assert.deepEqual(JSON.parse(server.requests[2]?.body ?? ''), {
      questionId: 'q1',
      optionId: 'approve',
    });
  } finally {
    await server.close();
  }
});

test('tasks are read across pages, and a malformed task is left out', async () => {
  const server = await stub();
  try {
    server.setHandler((req, res) => {
      const after = new URL(req.url ?? '', 'http://x').searchParams.get('after');
      if (after === '0') {
        return json(res, 200, {
          tasks: [
            { taskId: 't1', state: 'running', costUsd: 0.5, title: 'research', progress: [] },
            { state: 'running' },
          ],
          next: 7,
        });
      }
      json(res, 200, {
        tasks: [{ taskId: 't2', parentTaskId: 't1', state: 'failed', failureReason: 'broke' }],
      });
    });
    const deps = createLiveSmokeDeps(settingsFor(server.url));
    assert.deepEqual(await deps.tasks('c1'), [
      { taskId: 't1', state: 'running', costUsd: 0.5, title: 'research' },
      { taskId: 't2', parentTaskId: 't1', state: 'failed', failureReason: 'broke' },
    ]);
    assert.deepEqual(
      server.requests.map((r) => r.path),
      ['/v1/conversations/c1/tasks?after=0', '/v1/conversations/c1/tasks?after=7'],
    );
  } finally {
    await server.close();
  }
});

test('open questions are the unanswered ones, and the transcript is messages and notices in order', async () => {
  const server = await stub();
  try {
    server.setHandler((req, res) => {
      assert.ok(req.url?.startsWith('/v1/events?conversation=c1&after=0'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
      res.write(frame(1, 'message.posted', { conversationId: 'c1', role: 'user', text: 'go' }));
      res.write(
        frame(2, 'conductor.question', {
          questionId: 'q1',
          reason: 'taste',
          question: 'Which?',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          recommended: 'a',
        }),
      );
      res.write(
        frame(3, 'conductor.question', {
          questionId: 'q2',
          reason: 'irreversible',
          question: 'Open a pull request in scratch-owner/scratch-repo?',
          options: [{ id: 'approve', label: 'Open it' }],
          recommended: 'approve',
          action: { tool: 'open_pull_request', args: {} },
        }),
      );
      res.write(frame(4, 'conductor.question', { questionId: 'broken', reason: 'taste' }));
      res.write(frame(5, 'conductor.answered', { questionId: 'q1', optionId: 'a' }));
      res.write(frame(6, 'conductor.notice', { text: 'done: https://github.com/o/r/pull/3' }));
      res.write(frame(7, 'task.event', { seq: 1, event: { type: 'task_cost' } }));
      // The stream stays open, as the real one does; the adapter stops when it goes quiet.
    });
    const deps = createLiveSmokeDeps(settingsFor(server.url), { streamQuietMs: 150 });
    assert.deepEqual(await deps.openQuestions('c1'), [
      {
        questionId: 'q2',
        reason: 'irreversible',
        question: 'Open a pull request in scratch-owner/scratch-repo?',
        options: [{ id: 'approve', label: 'Open it' }],
        recommended: 'approve',
        action: { tool: 'open_pull_request' },
      },
    ]);
    assert.deepEqual(await deps.transcript('c1'), ['go', 'done: https://github.com/o/r/pull/3']);
  } finally {
    await server.close();
  }
});

test('errors name the route and the status and never a body or the token', async () => {
  const server = await stub();
  try {
    server.setHandler((_req, res) => {
      json(res, 500, { error: `internal ${TOKEN} sk-ant-secret`, detail: 'a stack trace' });
    });
    const deps = createLiveSmokeDeps(settingsFor(server.url));
    for (const call of [
      () => deps.startConversation(),
      () => deps.say('c1', 'hi'),
      () => deps.tasks('c1'),
      () => deps.openQuestions('c1'),
      () => deps.cancel('t1'),
    ]) {
      await assert.rejects(call, (error: Error) => {
        assert.match(error.message, /answered 500/u);
        assert.equal(error.message.includes(TOKEN), false);
        assert.equal(error.message.includes('sk-ant'), false);
        assert.equal(error.message.includes('stack trace'), false);
        return true;
      });
    }
  } finally {
    await server.close();
  }
  const down = createLiveSmokeDeps(settingsFor('http://127.0.0.1:1'));
  await assert.rejects(
    () => down.startConversation(),
    (error: Error) =>
      /could not reach the server/u.test(error.message) && !error.message.includes(TOKEN),
  );
});

test('healthy is true only for an ok answer', async () => {
  const server = await stub();
  try {
    const deps = createLiveSmokeDeps(settingsFor(server.url));
    server.setHandler((_req, res) => json(res, 200, { status: 'ok' }));
    assert.equal(await deps.healthy(), true);
    server.setHandler((_req, res) => json(res, 503, { status: 'unavailable' }));
    assert.equal(await deps.healthy(), false);
    server.setHandler((_req, res) => json(res, 200, { status: 'unavailable' }));
    assert.equal(await deps.healthy(), false);
    server.setHandler((_req, res) => res.writeHead(200).end('not json'));
    assert.equal(await deps.healthy(), false);
  } finally {
    await server.close();
  }
  assert.equal(await createLiveSmokeDeps(settingsFor('http://127.0.0.1:1')).healthy(), false);
});

test('totals read the journal in the data directory for the smoke invite and the whole server', async () => {
  const seen: Array<[string, number]> = [];
  const journal: JournalTotals = {
    taskUsd: new Map([['t1', 0.25]]),
    accountDayUsd: new Map([
      [INVITE, 1.5],
      ['inv_other000000', 3],
    ]),
    serverDayUsd: 4.5,
  };
  const deps = createLiveSmokeDeps(settingsFor('http://127.0.0.1:1', { dataDir: '/srv/maka' }), {
    now: () => 1_700_000_000_000,
    readTotals: (path, at) => {
      seen.push([path, at]);
      return journal;
    },
  });
  assert.deepEqual(await deps.totals(), {
    taskUsd: journal.taskUsd,
    inviteDayUsd: 1.5,
    serverDayUsd: 4.5,
  });
  assert.deepEqual(seen, [['/srv/maka/gateway-spend.db', 1_700_000_000_000]]);
});

function fakeInvites(
  initial: { dailyUsd: number | null; monthlyUsd: number | null } | undefined,
  /** The invite the smoke token resolves to; `null` is a token no active invite owns. */
  tokenOwner: string | null = INVITE,
) {
  let limits = initial;
  const calls: string[] = [];
  let opened = 0;
  let closed = 0;
  return {
    calls,
    get open() {
      return opened - closed;
    },
    open_: (path: string) => {
      opened += 1;
      calls.push(`open ${path}`);
      return {
        limits: () => limits,
        resolve: (token: string) => {
          calls.push(`resolve ${token === TOKEN ? 'the smoke token' : 'another token'}`);
          return tokenOwner === null || token !== TOKEN
            ? undefined
            : { inviteId: tokenOwner, label: 'smoke', createdAt: 0, revokedAt: null };
        },
        setLimits: (inviteId: string, set: { dailyUsd?: number; monthlyUsd?: number }) => {
          calls.push(`set ${inviteId} ${JSON.stringify(set)}`);
          if (limits && set.dailyUsd !== undefined) limits = { ...limits, dailyUsd: set.dailyUsd };
          return limits !== undefined;
        },
        close: () => {
          closed += 1;
        },
      };
    },
    current: () => limits,
  };
}

test('the daily cap is lowered for the scenario and put back exactly, and the file is closed each time', async () => {
  const invites = fakeInvites({ dailyUsd: 5, monthlyUsd: 50 });
  const lines: string[] = [];
  const deps = createLiveSmokeDeps(settingsFor('http://127.0.0.1:1', { dataDir: '/srv/maka' }), {
    openInvites: invites.open_ as never,
    log: (line) => lines.push(line),
  });
  await deps.setDailyCap(1.25);
  assert.equal(invites.current()?.dailyUsd, 1.25);
  assert.equal(invites.current()?.monthlyUsd, 50, 'the monthly cap is not touched');
  await deps.setDailyCap(undefined);
  assert.deepEqual(invites.current(), { dailyUsd: 5, monthlyUsd: 50 });
  assert.equal(invites.open, 0);
  assert.deepEqual(invites.calls, [
    'open /srv/maka/invites.db',
    `set ${INVITE} {"dailyUsd":1.25}`,
    'open /srv/maka/invites.db',
    `set ${INVITE} {"dailyUsd":5}`,
  ]);
  assert.match(lines.join('\n'), /was \$5/u, 'the original is logged in case the run is killed');
  // Putting back when nothing was lowered changes nothing.
  await deps.setDailyCap(undefined);
  assert.equal(invites.calls.filter((call) => call.startsWith('set')).length, 2);
});

test('lowering twice keeps the first value as the one to put back', async () => {
  const invites = fakeInvites({ dailyUsd: 5, monthlyUsd: 50 });
  const deps = createLiveSmokeDeps(settingsFor('http://127.0.0.1:1'), {
    openInvites: invites.open_ as never,
  });
  await deps.setDailyCap(2);
  await deps.setDailyCap(1);
  await deps.setDailyCap(undefined);
  assert.equal(invites.current()?.dailyUsd, 5);
});

test('an invite with no cap of its own, or an unknown one, is refused rather than changed', async () => {
  for (const initial of [{ dailyUsd: null, monthlyUsd: 50 }, undefined]) {
    const invites = fakeInvites(initial);
    const deps = createLiveSmokeDeps(settingsFor('http://127.0.0.1:1'), {
      openInvites: invites.open_ as never,
    });
    await assert.rejects(() => deps.setDailyCap(1));
    assert.deepEqual(
      invites.calls.filter((call) => call.startsWith('set')),
      [],
    );
    assert.equal(invites.open, 0, 'closed after the refusal');
  }
});

test('restart runs the configured command as an argument list, and a failure carries no output', async () => {
  const ran: string[][] = [];
  const deps = createLiveSmokeDeps(settingsFor('http://127.0.0.1:1'), {
    run: async (command) => {
      ran.push([...command]);
    },
  });
  await deps.restart();
  assert.deepEqual(ran, [['systemctl', 'restart', 'maka-cloud']]);

  // The default runner: a real child that fails and prints something secret-looking.
  const real = createLiveSmokeDeps(
    settingsFor('http://127.0.0.1:1', {
      restartCommand: [process.execPath, '-e', `console.error('${TOKEN}'); process.exit(3)`],
    }),
  );
  await assert.rejects(
    () => real.restart(),
    (error: Error) =>
      /restart command failed/u.test(error.message) && !error.message.includes(TOKEN),
  );
});

test('the budget is a hard cap only with a daily cap of the invite’s own at most the budget, so a run without one is refused before any request', async () => {
  const cases: Array<
    [string, { dailyUsd: number | null; monthlyUsd: number | null } | undefined, RegExp]
  > = [
    ['no daily cap', { dailyUsd: null, monthlyUsd: 50 }, /no daily cap of its own/u],
    [
      'a cap above the budget',
      { dailyUsd: 5.01, monthlyUsd: 50 },
      /\$5\.01\) is above MAKA_CLOUD_SMOKE_MAX_USD \(\$5\)/u,
    ],
    ['an unknown or revoked invite', undefined, /names no invite/u],
  ];
  for (const [name, limits, expected] of cases) {
    const { io, touched, printed } = untouchable();
    const invites = fakeInvites(limits);
    io.openInvites = invites.open_ as never;
    assert.equal(await smokeCommand(LIVE_ENV, io), 2, name);
    assert.deepEqual(touched, [], `${name}: no request, journal read or restart`);
    assert.match(printed.join('\n'), expected, name);
    assert.equal(printed.join('\n').includes(TOKEN), false);
    assert.equal(invites.open, 0, `${name}: the invites file is closed`);
    assert.deepEqual(
      invites.calls.filter((call) => call.startsWith('set')),
      [],
      `${name}: nothing is changed`,
    );
  }
});

test('the caps are those of the invite the token belongs to: a token of another invite, or of none, is refused before any request', async () => {
  // Another invite with a far higher cap would spend while the smoke invite's own cap is checked.
  const cases: Array<[string, string | null, RegExp]> = [
    ['a token of another invite', 'inv_ba9876543210', /belongs to another invite/u],
    ['a token no active invite owns', null, /not the token of an active invite/u],
  ];
  for (const [name, owner, expected] of cases) {
    const { io, touched, printed } = untouchable();
    const invites = fakeInvites({ dailyUsd: 5, monthlyUsd: 50 }, owner);
    io.openInvites = invites.open_ as never;
    assert.equal(await smokeCommand(LIVE_ENV, io), 2, name);
    assert.deepEqual(touched, [], `${name}: no request, journal read or restart`);
    assert.match(printed.join('\n'), expected, name);
    assert.equal(printed.join('\n').includes(TOKEN), false);
    assert.equal(invites.open, 0, `${name}: the invites file is closed`);
    assert.deepEqual(
      invites.calls.filter((call) => call.startsWith('set')),
      [],
      `${name}: nothing is changed`,
    );
  }
  const own = fakeInvites({ dailyUsd: 5, monthlyUsd: 50 });
  assert.equal(
    smokeCapProblem(settingsFor('http://127.0.0.1:1', { dataDir: '/srv/maka' }), {
      openInvites: own.open_ as never,
    }),
    undefined,
  );
  assert.ok(own.calls.includes('resolve the smoke token'), 'the token is what is resolved');
});

/** A server's ledger on a real journal file, as the smoke invite's requests would be booked. */
async function serverLedger(t: TestContext, clock: { now: number }) {
  const dir = await mkdtemp(join(tmpdir(), 'smoke-run-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new SqliteSpendJournal(join(dir, 'gateway-spend.db'));
  t.after(() => journal.close());
  const ledger = journal.accountLedger({
    limitsOf: () => ({ dailyUsd: 5, monthlyUsd: 50 }),
    serverDailyUsd: () => 1_000,
    now: () => clock.now,
  });
  return { dir, ledger };
}

/** Runs the whole smoke command against a server that is down, so it ends after its first request. */
function downServer(onFirstRequest: () => void): NonNullable<Parameters<typeof smokeCommand>[1]> {
  let requests = 0;
  let ticks = 0;
  const invites = fakeInvites({ dailyUsd: 5, monthlyUsd: 50 });
  return {
    print: () => {},
    openInvites: invites.open_ as never,
    fetch: (async () => {
      requests += 1;
      if (requests === 1) onFirstRequest();
      throw new Error('the server is down');
    }) as typeof fetch,
    readTotals: () => ({ taskUsd: new Map(), accountDayUsd: new Map(), serverDayUsd: 0 }),
    run: async () => {},
    now: () => (ticks += 1_000),
    sleep: async () => {},
  };
}

test('the run budget of the smoke command holds across UTC midnight, where the daily cap starts over', async (t) => {
  const clock = { now: Date.now() };
  const { dir, ledger } = await serverLedger(t, clock);
  const account = () => ({ inviteId: INVITE, generation: ledger.generationOf?.(INVITE) });
  const outcomes: ReserveResult[] = [];
  const io = downServer(() => {
    // Research spends $4 late on one UTC day and coding $4 early on the next: the budget is $5.
    clock.now = Date.now();
    outcomes.push(ledger.reserve(account(), 'research', 4));
    ledger.settle('research', 4);
    clock.now += 25 * 3_600_000;
    outcomes.push(ledger.reserve(account(), 'coding', 4));
  });
  const env = { ...LIVE_ENV, MAKA_CLOUD_DATA_DIR: dir, MAKA_CLOUD_SMOKE_MAX_USD: '5' };
  assert.equal(await smokeCommand(env, io), 1, 'the scenarios failed against a down server');
  assert.equal(outcomes[0]?.ok, true);
  assert.equal(outcomes[1]?.ok, false, 'the second $4 is past the $5 of the run');
  assert.equal(outcomes[1]?.ok ? undefined : outcomes[1]?.cap?.scope, 'invite_run');
  // The budget is gone when the run is: the invite is held to its daily and monthly caps again.
  assert.deepEqual(ledger.reserve(account(), 'later', 4), { ok: true });
});

test('the smoke command starts nothing when the journal does not enforce the run budget it set, and sets and clears the budget around a run', async (t) => {
  const { io, touched, printed } = untouchable();
  const invites = fakeInvites({ dailyUsd: 5, monthlyUsd: 50 });
  io.openInvites = invites.open_ as never;
  const calls: string[] = [];
  io.runBudget = {
    enforced: () => {
      calls.push('enforced');
      return false;
    },
    set: () => {
      calls.push('set');
    },
    renew: () => true,
    clear: () => {
      calls.push('clear');
      return true;
    },
  };
  assert.equal(await smokeCommand(LIVE_ENV, io), 2);
  assert.deepEqual(
    calls,
    ['set', 'enforced', 'clear'],
    'the budget is checked once set, and taken away again when it would not hold',
  );
  assert.deepEqual(touched, [], 'and nothing is sent');
  assert.match(printed.join('\n'), /does not enforce the run budget/u);

  // A run that ends, however it ends, takes its budget with it.
  const down = downServer(() => {});
  const seen: string[] = [];
  down.runBudget = {
    enforced: () => true,
    set: (_path, inviteId, budget, runId) => {
      seen.push(`set ${inviteId} ${budget.limitUsd} ${runId}`);
    },
    renew: () => true,
    clear: (_path, inviteId, runId) => {
      seen.push(`clear ${inviteId} ${runId}`);
      return true;
    },
  };
  down.runId = 'run_one';
  await smokeCommand(LIVE_ENV, down);
  assert.deepEqual(seen, [`set ${INVITE} 5 run_one`, `clear ${INVITE} run_one`]);
});

test('a second smoke run is refused while the first holds the invite’s run budget, and the first run’s cleanup leaves only its own', async (t) => {
  const clock = { now: Date.now() };
  const { dir, ledger } = await serverLedger(t, clock);
  const account = () => ({ inviteId: INVITE, generation: ledger.generationOf?.(INVITE) });
  const env = { ...LIVE_ENV, MAKA_CLOUD_DATA_DIR: dir, MAKA_CLOUD_SMOKE_MAX_USD: '5' };
  const printedB: string[] = [];
  let codeB: number | undefined;
  const first = downServer(() => {
    // While run A is going, run B is started against the same journal and invite.
    clock.now = Date.now();
    const second = downServer(() => {});
    second.print = (line) => printedB.push(line);
    second.runId = 'run_b';
    void smokeCommand(env, second).then((code) => {
      codeB = code;
    });
  });
  first.runId = 'run_a';
  // The two share the process, so B's whole (synchronous up to its first await) start is done by
  // the time A's request returns; wait one turn for its result.
  assert.equal(await smokeCommand(env, first), 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(codeB, 2, 'the second run is refused before any request');
  assert.match(printedB.join('\n'), /another smoke run holds the run budget/u);
  // B did not replace A's budget and did not clear it either: A's own cleanup ended it.
  assert.deepEqual(ledger.reserve(account(), 'later', 4), { ok: true });
});

test('a smoke run that takes over an abandoned budget fences the earlier run’s credentials and cancels the tasks it left running', async (t) => {
  const clock = { now: Date.now() };
  const { dir, ledger } = await serverLedger(t, clock);
  const journalPath = join(dir, 'gateway-spend.db');
  setRunBudget(
    journalPath,
    INVITE,
    { limitUsd: 5, sinceMs: clock.now - 3_600_000 },
    'run_old',
    clock.now - 3 * RUN_LEASE_MS,
  );
  const old = accountPort(new LimitPort([new Allowance(100)]), ledger, { inviteId: INVITE });
  assert.deepEqual(old.reserve('old1', 1), { ok: true });

  const cancelled: string[] = [];
  const printed: string[] = [];
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const io = downServer(() => {});
  io.print = (line) => printed.push(line);
  io.runId = 'run_new';
  io.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'POST' && url.pathname.endsWith('/cancel')) {
      cancelled.push(url.pathname.split('/')[3] ?? '');
      return answer({});
    }
    if (url.pathname === '/v1/conversations') {
      return answer({ conversations: [{ conversationId: 'cnv_old' }] });
    }
    if (url.pathname === '/v1/conversations/cnv_old/tasks') {
      return answer({
        tasks: [
          { taskId: 'tsk_running', state: 'running' },
          { taskId: 'tsk_done', state: 'succeeded' },
          { taskId: 'tsk_paused', state: 'paused' },
        ],
      });
    }
    throw new Error('the server is down');
  }) as typeof fetch;
  const env = { ...LIVE_ENV, MAKA_CLOUD_DATA_DIR: dir, MAKA_CLOUD_SMOKE_MAX_USD: '5' };
  await smokeCommand(env, io);

  assert.deepEqual(cancelled, ['tsk_running', 'tsk_paused']);
  assert.match(printed.join('\n'), /took over the run budget of an earlier run/u);
  const refusal = old.reserve('old2', 0.01);
  assert.equal(refusal.ok, false, 'the earlier run’s credential books nothing');
  // A first run, with nothing to take over, cancels nothing.
  cancelled.length = 0;
  const fresh = await mkdtemp(join(tmpdir(), 'smoke-first-run-'));
  t.after(() => rm(fresh, { recursive: true, force: true }));
  const journal = new SqliteSpendJournal(join(fresh, 'gateway-spend.db'));
  journal.close();
  await smokeCommand({ ...env, MAKA_CLOUD_DATA_DIR: fresh }, io);
  assert.deepEqual(cancelled, []);
});

test('a smoke run that cannot stop what the earlier run left running starts nothing', async (t) => {
  for (const failure of ['cancel', 'list'] as const) {
    const clock = { now: Date.now() };
    const { dir } = await serverLedger(t, clock);
    const journalPath = join(dir, 'gateway-spend.db');
    setRunBudget(
      journalPath,
      INVITE,
      { limitUsd: 5, sinceMs: clock.now - 3_600_000 },
      'run_old',
      clock.now - 3 * RUN_LEASE_MS,
    );
    const requests: string[] = [];
    const printed: string[] = [];
    const answer = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const io = downServer(() => {});
    io.print = (line) => printed.push(line);
    io.runId = 'run_new';
    io.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/v1/conversations' && (init?.method ?? 'GET') === 'GET') {
        if (failure === 'list') throw new Error('the server is down');
        return answer({ conversations: [{ conversationId: 'cnv_old' }] });
      }
      if (url.pathname === '/v1/conversations/cnv_old/tasks') {
        // The task is still running after the cancel failed.
        return answer({ tasks: [{ taskId: 'tsk_running', state: 'running' }] });
      }
      if (init?.method === 'POST' && url.pathname.endsWith('/cancel')) {
        return new Response('{}', { status: 500 });
      }
      throw new Error('the scenario started');
    }) as typeof fetch;
    const env = { ...LIVE_ENV, MAKA_CLOUD_DATA_DIR: dir, MAKA_CLOUD_SMOKE_MAX_USD: '5' };

    assert.equal(await smokeCommand(env, io), 2, failure);
    assert.match(printed.join('\n'), /could not stop what the earlier run left running/u, failure);
    assert.match(printed.join('\n'), /nothing was started/u, failure);
    assert.ok(
      !requests.some(
        (line) => line.startsWith('POST /v1/conversations') && !line.endsWith('/cancel'),
      ),
      `${failure}: no scenario was started (${requests.join(', ')})`,
    );
    // The run's budget is gone with it, so the next run starts clean.
    const check = new DatabaseSync(journalPath, { readOnly: true });
    try {
      assert.equal(
        (check.prepare('SELECT COUNT(*) AS n FROM run_budget').get() as { n: number }).n,
        0,
        failure,
      );
    } finally {
      check.close();
    }
  }
});

test('a task whose cancel failed but which has ended since does not stop the run from starting', async (t) => {
  const clock = { now: Date.now() };
  const { dir } = await serverLedger(t, clock);
  const journalPath = join(dir, 'gateway-spend.db');
  setRunBudget(
    journalPath,
    INVITE,
    { limitUsd: 5, sinceMs: clock.now - 3_600_000 },
    'run_old',
    clock.now - 3 * RUN_LEASE_MS,
  );
  const printed: string[] = [];
  let cancelRequested = false;
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const io = downServer(() => {});
  io.print = (line) => printed.push(line);
  io.runId = 'run_new';
  io.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/conversations' && (init?.method ?? 'GET') === 'GET') {
      return answer({ conversations: [{ conversationId: 'cnv_old' }] });
    }
    if (url.pathname === '/v1/conversations/cnv_old/tasks') {
      // The task ends on its own just as the cancel is refused.
      return answer({
        tasks: [{ taskId: 'tsk_x', state: cancelRequested ? 'succeeded' : 'running' }],
      });
    }
    if (init?.method === 'POST' && url.pathname.endsWith('/cancel')) {
      cancelRequested = true;
      return new Response('{}', { status: 409 });
    }
    throw new Error('the server is down');
  }) as typeof fetch;
  const env = { ...LIVE_ENV, MAKA_CLOUD_DATA_DIR: dir, MAKA_CLOUD_SMOKE_MAX_USD: '5' };
  const code = await smokeCommand(env, io);
  assert.equal(
    code,
    1,
    `the scenarios ran (and failed against a down server): ${printed.join(' | ')}`,
  );
  assert.doesNotMatch(printed.join('\n'), /nothing was started/u);
});

test('a daily cap at or below the budget passes the cap check, and an unreadable invites file refuses', () => {
  const settings = settingsFor('http://127.0.0.1:1', { dataDir: '/srv/maka', maxUsd: 5 });
  for (const dailyUsd of [5, 0.5, 0]) {
    const invites = fakeInvites({ dailyUsd, monthlyUsd: null });
    assert.equal(smokeCapProblem(settings, { openInvites: invites.open_ as never }), undefined);
    assert.equal(invites.open, 0);
  }
  const problem = smokeCapProblem(settings, {
    openInvites: () => {
      throw new Error('unable to open database file: /srv/maka/invites.db');
    },
  });
  assert.equal(problem, 'the invites file in MAKA_CLOUD_DATA_DIR could not be read');
});

test('the maka-cloud smoke command refuses without the flag, and its usage lists the smoke settings', () => {
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  // The settings are all there but the flag; the URL points nowhere, so a request would be an error.
  const { MAKA_CLOUD_LIVE: _live, ...withoutFlag } = LIVE_ENV;
  const refused = run(['smoke'], { PATH: process.env.PATH ?? '', ...withoutFlag });
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /MAKA_CLOUD_LIVE=1/u);
  assert.equal(`${refused.stdout}${refused.stderr}`.includes(TOKEN), false);
  assert.equal(run(['smoke', 'extra'], {}).status, 2, 'arguments are not accepted');
  const usage = run(['help'], {});
  assert.equal(usage.status, 2);
  for (const [name] of SMOKE_VARIABLES) assert.ok(usage.stderr.includes(name), name);
});
