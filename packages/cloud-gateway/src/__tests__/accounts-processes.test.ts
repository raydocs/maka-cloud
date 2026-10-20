import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { SqliteSpendJournal } from '../index.js';

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));

/** Runs a script in a process of its own, so the journal file is shared by real processes. */
function child(path: string, script: string, args: string[] = []): ChildProcess {
  return spawn(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', script, INDEX, path, ...args],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
}

function output(proc: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    proc.once('error', reject);
    proc.once('close', (code) =>
      code === 0 ? resolve(text) : reject(new Error(`exit ${code}: ${text}`)),
    );
  });
}

async function journalPath(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-processes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'spend.db');
}

const OPEN = `
const [index, path, ...rest] = process.argv.slice(1);
const { SqliteSpendJournal } = await import(index);
`;

const LEDGER = `${OPEN}
const journal = new SqliteSpendJournal(path);
const ledger = journal.accountLedger({
  limitsOf: () => ({ dailyUsd: 3, monthlyUsd: 1000 }),
  serverDailyUsd: () => 1000,
});
`;

/** Resolves once every process has printed `ready`, then lets them all go at the same moment. */
async function release(procs: ChildProcess[]): Promise<void> {
  await Promise.all(
    procs.map(
      (proc) =>
        new Promise<void>((resolve, reject) => {
          proc.stdout?.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('ready')) resolve();
          });
          proc.once('error', reject);
          proc.once('close', () => reject(new Error('a process ended before it was ready')));
        }),
    ),
  );
  for (const proc of procs) proc.stdin?.end('go\n');
}

test('several processes opening one new file together and reserving against one invite cannot pass its cap', async (t) => {
  const path = await journalPath(t);
  // Each process asks for $0.25 again and again until the ledger refuses; the cap is $3.
  const script = `${OPEN}
console.log('ready');
await new Promise((resolve) => process.stdin.once('data', resolve));
const journal = new SqliteSpendJournal(path);
const ledger = journal.accountLedger({
  limitsOf: () => ({ dailyUsd: 3, monthlyUsd: 1000 }),
  serverDailyUsd: () => 1000,
});
let granted = 0;
for (let i = 0; i < 200; i += 1) {
  const result = ledger.reserve({ inviteId: 'inv_a' }, rest[0] + ':' + i, 0.25);
  if (!result.ok) break;
  granted += 1;
}
console.log(granted);
journal.close();
`;
  const procs = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((name) => child(path, script, [name]));
  const finished = procs.map(output);
  // They open a file that does not exist yet at the same moment, the hardest start for a database.
  await release(procs);
  const granted = (await Promise.all(finished)).map((text) =>
    Number(text.trim().split('\n').at(-1)),
  );
  assert.equal(
    granted.reduce((sum, n) => sum + n, 0),
    12,
    `every process was refused only when the day was full, and none passed it (${granted})`,
  );
  const reader = new SqliteSpendJournal(path);
  t.after(() => reader.close());
  const ledger = reader.accountLedger({
    limitsOf: () => ({ dailyUsd: 3, monthlyUsd: 1000 }),
    serverDailyUsd: () => 1000,
  });
  assert.equal(ledger.reserve({ inviteId: 'inv_a' }, 'one-more', 0.01).ok, false);
  assert.equal(ledger.reserve({ inviteId: 'inv_b' }, 'other-invite', 2.5).ok, true);
});

test("a process killed with a reservation open leaves it counted in full, and another invite's spend is not affected", async (t) => {
  const path = await journalPath(t);
  const script = `${LEDGER}
const result = ledger.reserve({ inviteId: 'inv_a' }, 'in-flight', 2);
console.log(result.ok ? 'held' : 'refused');
setInterval(() => {}, 1000);
`;
  const proc = child(path, script);
  await new Promise<void>((resolve, reject) => {
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve();
    });
    proc.once('error', reject);
    proc.once('close', () => reject(new Error('the process ended before it held')));
  });
  const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
  proc.kill('SIGKILL');
  await closed;

  const after = new SqliteSpendJournal(path);
  t.after(() => after.close());
  const ledger = after.accountLedger({
    limitsOf: () => ({ dailyUsd: 3, monthlyUsd: 1000 }),
    serverDailyUsd: () => 1000,
  });
  // $2 was held and never settled: it still counts, so only $1 is left.
  assert.equal(ledger.reserve({ inviteId: 'inv_a' }, 'too-much', 1.5).ok, false);
  assert.equal(ledger.reserve({ inviteId: 'inv_a' }, 'fits', 1).ok, true);
  assert.equal(ledger.reserve({ inviteId: 'inv_b' }, 'unaffected', 3).ok, true);
});

test('processes opening a new journal file at the same moment all get it, round after round', async (t) => {
  // A new file is switched to WAL by whoever gets there first; the others used to be refused
  // ("database is locked", "disk I/O error") about one open in five, so one round is not enough.
  const script = `${OPEN}
console.log('ready');
await new Promise((resolve) => process.stdin.once('data', resolve));
const journal = new SqliteSpendJournal(path);
journal.hold('task', 'key-' + process.pid, 0.01);
journal.close();
console.log('opened');
`;
  for (let round = 0; round < 8; round += 1) {
    const path = await journalPath(t);
    const procs = Array.from({ length: 6 }, () => child(path, script));
    const finished = procs.map(output);
    await release(procs);
    const results = await Promise.allSettled(finished);
    const failed = results.flatMap((result) =>
      result.status === 'rejected' ? [String(result.reason)] : [],
    );
    assert.deepEqual(failed, [], `round ${round}: every process opened the file`);
  }
});
