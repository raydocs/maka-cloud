import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CloudRunnersOptions } from '../fleet.js';
import { FixedMachineProvider } from '../providers.js';
import {
  MemoryTranscriptStore,
  type TranscriptKey,
  type TranscriptLine,
  type TranscriptStore,
} from '../transcripts.js';
import type { SandboxLease } from '../types.js';
import { loadAgentSdk } from '../sdk-turn.js';
import { SDK_CLI } from './fake-sdk-cli.js';
import { sdkCloudOptions, sdkSetup } from './sdk-harness.js';
import { API_KEY, collect, type Harness, MCP_TOKEN, notes, setup, terminal } from './harness.js';

/** What the stand-in CLI calls its session when it keeps a transcript. */
const SESSION = '11111111-2222-4333-8444-555555555555';

interface Rig {
  h: Harness;
  store: MemoryTranscriptStore;
  /** The transcript file of a task on the sandbox. */
  boxFile(taskId: string): string;
  /** The lines the store holds for the task's session. */
  stored(taskId: string): Promise<string[]>;
}

async function rig(
  t: { after(fn: () => Promise<void>): void },
  extra: {
    store?: TranscriptStore;
    sandboxes?: FixedMachineProvider;
    cloud?: Partial<CloudRunnersOptions>;
  } = {},
): Promise<Rig> {
  const store = new MemoryTranscriptStore();
  const h = await sdkSetup(t, {
    transcripts: extra.store ?? store,
    ...(extra.sandboxes ? { sandboxes: extra.sandboxes } : {}),
    ...extra.cloud,
  });
  return {
    h,
    store,
    boxFile: (taskId) =>
      join(
        h.root,
        taskId,
        'claude-config',
        'projects',
        join(h.root, taskId, 'workspace').replace(/[^a-zA-Z0-9]/gu, '-'),
        `${SESSION}.jsonl`,
      ),
    stored: async (taskId) => (await store.read(taskId, SESSION)).lines,
  };
}

const prompts = async (h: Harness): Promise<string[]> =>
  (await fs.readFile(join(h.home, 'fake-cli', 'prompts.log'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((text) => JSON.parse(text) as string);

test('every line the CLI writes is kept in the store, scrubbed of the run’s secrets, and the CLI writes where the SDK looks', async (t) => {
  const r = await rig(t);
  await r.h.setMode('leak');
  const spec = await r.h.spec('tsk_tr_mirror', {
    mcp: { url: 'http://127.0.0.1:4100/mcp', token: MCP_TOKEN },
  });
  const events = await collect(await r.h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(terminal(events)));

  const { argv, env } = await r.h.cliCall('claude', 1);
  assert.ok(argv.includes('--session-mirror'));
  const configDir = join(r.h.root, 'tsk_tr_mirror', 'claude-config');
  assert.ok(env.split('\n').includes(`CLAUDE_CONFIG_DIR=${configDir}`));

  const kept = await r.stored('tsk_tr_mirror');
  assert.equal(kept.length, 4, 'the prompt, the key line, the progress line, the answer');
  const text = kept.join('\n');
  assert.ok(!text.includes(API_KEY), 'the API key reached the store');
  assert.ok(!text.includes(MCP_TOKEN), 'the MCP token reached the store');
  assert.match(text, /key \[redacted\] token \[redacted\]/);
  // What is kept is what the CLI wrote, line for line, but for the scrubbing.
  const onBox = (await fs.readFile(r.boxFile('tsk_tr_mirror'), 'utf8')).split('\n').filter(Boolean);
  assert.deepEqual(
    kept.map((line) => JSON.parse(line).uuid),
    onBox.map((line) => JSON.parse(line).uuid),
  );
  assert.equal((await r.h.sessions.get('tsk_tr_mirror'))?.sessionId, SESSION);
});

test('without a transcript store the CLI is not asked to mirror anything and keeps its own configuration directory', async (t) => {
  const h = await sdkSetup(t);
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_tr_off')));
  assert.equal(terminal(events)?.type, 'finished');
  const { argv, env } = await h.cliCall('claude', 1);
  assert.ok(!argv.includes('--session-mirror'));
  assert.ok(!env.includes('CLAUDE_CONFIG_DIR'));
});

test('a resumed turn on the same sandbox reads the conversation it left there, and the store keeps growing', async (t) => {
  const r = await rig(t);
  const spec = await r.h.spec('tsk_tr_same');
  assert.equal(terminal(await collect(await r.h.runners.claude.start(spec)))?.type, 'finished');
  const before = await fs.readFile(r.boxFile('tsk_tr_same'), 'utf8');
  assert.equal((await r.stored('tsk_tr_same')).length, 3);

  const events = await collect(
    await r.h.runners.claude.resume('tsk_tr_same', { prompt: 'And one more thing.', spec }),
  );
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(notes(events)));
  const { argv } = await r.h.cliCall('claude', 2);
  assert.ok(argv.includes(`--resume=${SESSION}`));
  assert.equal(await fs.readFile(join(r.h.home, 'fake-cli', 'resumed-2.jsonl'), 'utf8'), before);
  assert.equal((await r.stored('tsk_tr_same')).length, 6);
  assert.ok(
    !notes(events).some((note) => /put back on the sandbox/.test(note)),
    'nothing to put back',
  );
});

test('a sandbox that lost the conversation gets it back from the store before the CLI resumes', async (t) => {
  const r = await rig(t);
  const spec = await r.h.spec('tsk_tr_behind');
  assert.equal(terminal(await collect(await r.h.runners.claude.start(spec)))?.type, 'finished');
  const stored = (await r.stored('tsk_tr_behind')).join('\n');
  // The sandbox comes back from an older snapshot: the conversation there is cut short.
  await fs.writeFile(r.boxFile('tsk_tr_behind'), `${stored.split('\n')[0]}\n`);

  const events = await collect(
    await r.h.runners.claude.resume('tsk_tr_behind', { prompt: 'Go on.', spec }),
  );
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(notes(events)));
  assert.ok(notes(events).some((note) => /\(3 lines\) was put back on the sandbox/.test(note)));
  assert.equal(
    await fs.readFile(join(r.h.home, 'fake-cli', 'resumed-2.jsonl'), 'utf8'),
    `${stored}\n`,
  );
});

/** A provider whose new sandboxes are empty: the task directory of the one machine is wiped. */
class NewSandboxes extends FixedMachineProvider {
  acquired = 0;
  constructor(
    machineId: string,
    private readonly wipe: () => Promise<void>,
  ) {
    super(machineId);
  }
  override async acquire(input: { tenantId: string; taskId: string }): Promise<SandboxLease> {
    if (this.acquired++ > 0) await this.wipe();
    return await super.acquire(input);
  }
}

test('with the sandbox gone and no snapshot, the task goes on in a new sandbox from its stored conversation', async (t) => {
  let h: Harness | undefined;
  const sandboxes = new NewSandboxes('m_aaaaaaaaaaaaaaaaaaaaaaaaaa', async () => {
    const root = (h as Harness).root;
    await fs.rm(join(root, 'tsk_tr_fresh'), { recursive: true, force: true });
    (h as Harness).fake.machineState = 'running';
  });
  const r = await rig(t, { sandboxes });
  h = r.h;
  const spec = await r.h.spec('tsk_tr_fresh');
  assert.equal(terminal(await collect(await r.h.runners.claude.start(spec)))?.type, 'finished');
  const stored = (await r.stored('tsk_tr_fresh')).join('\n');
  const first = await r.h.sessions.get('tsk_tr_fresh');
  assert.ok(first && first.snapshotIds.length > 0);

  // The machine is deleted and the snapshots are gone with it.
  r.h.fake.machineState = 'deleted';
  await r.h.sessions.put({ ...first, snapshotIds: [] });

  const events = await collect(
    await r.h.runners.claude.resume('tsk_tr_fresh', { prompt: 'Carry on.', spec }),
  );
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(notes(events)));
  assert.ok(
    notes(events).some((note) => /goes on in a new one from its stored conversation/.test(note)),
  );

  // The CLI resumed the stored conversation, and the new sandbox has the brief but nothing else.
  assert.equal(
    await fs.readFile(join(r.h.home, 'fake-cli', 'resumed-2.jsonl'), 'utf8'),
    `${stored}\n`,
  );
  assert.match(
    await fs.readFile(join(r.h.root, 'tsk_tr_fresh', 'brief.md'), 'utf8'),
    /Brief for tsk_tr_fresh/,
  );
  const sent = (await prompts(r.h)).at(-1) ?? '';
  assert.ok(sent.startsWith('Carry on.'));
  assert.match(sent, /sandbox you were working in is gone and this is a new one/);
  assert.match(sent, /check what already reached the outside world/);
  assert.equal((await r.stored('tsk_tr_fresh')).length, 6);
  const record = await r.h.sessions.get('tsk_tr_fresh');
  assert.equal(record?.turns, 2);
  assert.equal(record?.sessionId, SESSION);
});

test('the same loss without a stored conversation still fails without a guess', async (t) => {
  const sandboxes = new NewSandboxes('m_aaaaaaaaaaaaaaaaaaaaaaaaaa', async () => undefined);
  const r = await rig(t, { sandboxes });
  const spec = await r.h.spec('tsk_tr_nokept');
  assert.equal(terminal(await collect(await r.h.runners.claude.start(spec)))?.type, 'finished');
  const first = await r.h.sessions.get('tsk_tr_nokept');
  r.h.fake.machineState = 'deleted';
  await r.h.sessions.put({ ...(first as NonNullable<typeof first>), snapshotIds: [] });
  await r.store.deleteTask('tsk_tr_nokept');

  const events = await collect(
    await r.h.runners.claude.resume('tsk_tr_nokept', { prompt: 'x', spec }),
  );
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  assert.match(last?.type === 'failed' ? last.reason : '', /cannot resume: the sandbox is gone/);
  assert.equal(sandboxes.acquired, 1, 'no sandbox was acquired for it');
  assert.equal(r.h.runners.fleet.openRuns, 0);
});

test('a conversation that began before transcripts were kept goes on as it is, unsaved', async (t) => {
  // The first turn runs without a store (a deployment that turned it on later).
  const h = await sdkSetup(t);
  const spec = await h.spec('tsk_tr_legacy');
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');

  const store = new MemoryTranscriptStore();
  const later = h.makeRunners({ ...(await sdkCloudOptions()), transcripts: store });
  later.fleet.ensureAgentIsolation = async () => undefined;
  const events = await collect(
    await later.claude.resume('tsk_tr_legacy', { prompt: 'Go on.', spec }),
  );
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(notes(events)));
  assert.ok(
    notes(events).some((note) => /began before that was on\); this turn is not saved/.test(note)),
    JSON.stringify(notes(events)),
  );
  const { argv } = await h.cliCall('claude', 2);
  assert.ok(!argv.includes('--session-mirror'));
  assert.equal(await store.locate('tsk_tr_legacy', 'sess-1'), undefined);
});

test('a store that refuses lines is reported, and the task still finishes', async (t) => {
  const down = new MemoryTranscriptStore();
  down.append = async () => {
    throw new Error('the transcript database is full');
  };
  const r = await rig(t, { store: down });
  const events = await collect(await r.h.runners.claude.start(await r.h.spec('tsk_tr_down')));
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(notes(events)));
  assert.ok(
    notes(events).some((note) =>
      /a transcript batch was not kept: the transcript database is full/.test(note),
    ),
    JSON.stringify(notes(events)),
  );
});

test('a conversation that cannot be put on the sandbox fails the turn before the CLI starts', async (t) => {
  const r = await rig(t);
  const spec = await r.h.spec('tsk_tr_readfail');
  assert.equal(terminal(await collect(await r.h.runners.claude.start(spec)))?.type, 'finished');
  await fs.rm(r.boxFile('tsk_tr_readfail'));
  r.store.read = async () => {
    throw new Error('the transcript database is down');
  };
  const events = await collect(
    await r.h.runners.claude.resume('tsk_tr_readfail', { prompt: 'x', spec }),
  );
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  assert.match(
    last?.type === 'failed' ? last.reason : '',
    /the conversation could not be put on the sandbox: the transcript database is down/,
  );
  assert.equal(await r.h.cliCalls('claude'), 1, 'the CLI was not started');
  assert.equal(r.h.runners.fleet.openRuns, 0);
  assert.equal(r.h.runners.fleet.poller.watchCount(), 0);
});

test('the sandbox gets the CLI version the SDK was built for', async (t) => {
  const sdk = await loadAgentSdk();
  assert.match(sdk.cliVersion ?? '', /^\d+\.\d+\.\d+$/);
  const h = await setup({
    cloud: {
      agentSdk: { ...sdk, cliVersion: '8.8.8' },
      versions: { codex: '9.9.9' },
      installCommands: { 'claude-agent-sdk': 'true' },
    },
  });
  t.after(() => h.cleanup());
  await fs.writeFile(join(h.home, '.maka-cli', 'bin', 'claude'), SDK_CLI, { mode: 0o755 });
  await collect(await h.runners.claude.start(await h.spec('tsk_tr_version')));
  await fs.stat(join(h.root, '.setup', 'claude-8.8.8.ok'));
});

test('only the lines of the task’s own session go to its store', async (t) => {
  const calls: Array<{ taskId: string; key: TranscriptKey; lines: readonly TranscriptLine[] }> = [];
  const store = new MemoryTranscriptStore();
  const real = store.append.bind(store);
  store.append = async (taskId, key, lines) => {
    calls.push({ taskId, key, lines });
    return await real(taskId, key, lines);
  };
  const r = await rig(t, { store });
  await collect(await r.h.runners.claude.start(await r.h.spec('tsk_tr_scope')));
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.taskId === 'tsk_tr_scope'));
  assert.ok(calls.every((call) => call.key.sessionId === SESSION));
  assert.ok(calls.every((call) => call.key.projectKey.endsWith('tsk-tr-scope-workspace')));
});
