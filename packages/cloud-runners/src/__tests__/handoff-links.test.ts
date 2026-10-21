import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './harness.js';

/** The brief is written by the sandbox user into a directory the agent can write: links it left there stay links. */
test('writing the brief never follows a link planted in handoff/', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_links', undefined);
  const dir = join(h.root, 'tsk_links');
  const victim = join(h.tmp, 'victim.txt');
  writeFileSync(victim, "the sandbox user's own file");
  chmodSync(victim, 0o600);
  const before = statSync(victim);
  // The agent's plants: the temporary name and the final name, both aimed at the victim.
  symlinkSync(victim, join(dir, 'handoff', 'brief.md.tmp'));
  symlinkSync(victim, join(dir, 'handoff', 'brief.md'));

  await machine.prepare(
    'tsk_links',
    'the brief',
    undefined,
    execFileSync('id', ['-gn']).toString().trim(),
  );
  await machine.prepareAgent('tsk_links', execFileSync('id', ['-gn']).toString().trim());

  assert.equal(readFileSync(victim, 'utf8'), "the sandbox user's own file");
  assert.equal(statSync(victim).mode, before.mode, "the victim's mode is untouched");
  assert.equal(readFileSync(join(dir, 'handoff', 'brief.md'), 'utf8'), 'the brief');
  assert.equal(statSync(join(dir, 'handoff', 'brief.md')).mode & 0o777, 0o640);
  assert.equal(existsSync(join(dir, '.brief.tmp')), false);
});
