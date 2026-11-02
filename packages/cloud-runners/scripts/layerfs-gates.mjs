#!/usr/bin/env node
/**
 * Super-agent LayerFS spike gates (architecture §10.1).
 *
 * Default (`--local`): run the in-repo adapter checks (gate 3) and print
 * gates 0–2 as Instabox-only work. This CI lane never starts FUSE, Docker
 * or an Instabox. Pass `--live` only on a disposable Instabox the owner
 * provides; this script still refuses to mount LayerFS itself.
 *
 * Exit 0: local gates passed (or live gates 0–3 all passed).
 * Exit 2: a live gate failed.
 * Exit 3: --live was asked for but this host is not an Instabox-shaped box.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const live = process.argv.includes('--live');

function say(gate, status, detail) {
  console.log(`gate ${gate}: ${status}${detail ? ` — ${detail}` : ''}`);
}

function isolationDoc() {
  return readFileSync(join(repoRoot, 'docs/fork/isolation-model.md'), 'utf8');
}

function deviceProbe() {
  const fuse = existsSync('/dev/fuse');
  let docker = false;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000 });
    docker = true;
  } catch {
    docker = false;
  }
  let fsType = 'unknown';
  try {
    const out = execFileSync('df', ['-T', repoRoot], { encoding: 'utf8' });
    const line = out.trim().split('\n').at(-1) ?? '';
    fsType = line.split(/\s+/u)[1] ?? 'unknown';
  } catch {
    fsType = 'unknown';
  }
  const okFs = /^(ext4|xfs|btrfs)$/u.test(fsType);
  return { fuse, docker, fsType, okFs };
}

function gate0() {
  const probe = deviceProbe();
  const pass = probe.fuse && probe.docker && probe.okFs;
  say(
    0,
    live ? (pass ? 'PASS' : 'FAIL') : 'SKIP (needs Instabox)',
    `/dev/fuse=${probe.fuse} docker=${probe.docker} fs=${probe.fsType}`,
  );
  return live ? pass : true;
}

function gate1() {
  const doc = isolationDoc();
  const required = ['**I1.', '**I5.', '**I7.', '**I8.', '**I16.', '169.254.169.254', 'capability'];
  const missing = required.filter((token) => !doc.includes(token));
  if (missing.length > 0) {
    say(1, 'FAIL', `isolation-model.md is missing ${missing.join(', ')}`);
    return false;
  }
  say(
    1,
    live ? 'FAIL' : 'SKIP (needs Instabox)',
    live
      ? 'this script does not raise CAP_SYS_ADMIN or open FUSE; run the isolation tests on Instabox'
      : 'checklist I1–I16 still named; live run must refuse CAP_SYS_ADMIN, 169.254.169.254 and RFC1918',
  );
  return !live;
}

function gate2() {
  say(
    2,
    live ? 'FAIL' : 'SKIP (needs Instabox)',
    'compare clone+install vs mount: wall time to first test and disk per task; pass only if ≥3× first-test',
  );
  return !live;
}

async function gate3() {
  const { LayerFsStore } = await import(pathToFileURL(join(here, '../dist/workspace.js')).href);
  const store = new LayerFsStore(true);
  const base = await store.prepare({
    tenantId: 'gate',
    workerId: 'base',
    repoUrl: 'local',
    seedFiles: { 'src/a.ts': 'one\n' },
  });
  const left = await store.prepare({
    tenantId: 'gate',
    workerId: 'w1',
    repoUrl: 'local',
    forkOf: base.id,
  });
  const right = await store.prepare({
    tenantId: 'gate',
    workerId: 'w2',
    repoUrl: 'local',
    forkOf: base.id,
  });
  store.write(left, 'src/a.ts', 'left\n');
  store.write(right, 'src/a.ts', 'right\n');
  const clashes = store.conflicts(left, right);
  if (clashes.join() !== 'src/a.ts') {
    say(3, 'FAIL', `expected conflict on src/a.ts, got ${JSON.stringify(clashes)}`);
    return false;
  }
  const before = await store.exportPatch(right);
  await store.release(left);
  const after = await store.exportPatch(right);
  if (before !== after || !after.includes('+right')) {
    say(3, 'FAIL', 'exportPatch was lost when the other worker was released');
    return false;
  }
  say(3, 'PASS', 'forks conflict on the same file; exportPatch survives the sibling release');
  return true;
}

const results = [gate0(), gate1(), gate2(), await gate3()];
if (live && !deviceProbe().fuse) process.exit(3);
process.exit(results.every(Boolean) ? 0 : 2);
