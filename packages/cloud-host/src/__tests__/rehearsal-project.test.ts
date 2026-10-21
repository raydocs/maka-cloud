import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The go-live rehearsal runs on whatever host someone points it at, which may be the host a real
// deployment runs on (project maka-cloud, volumes maka-cloud_maka-data and maka-cloud_maka-backups).
// Its teardown deletes volumes, so it must never resolve to that project, those volumes or those
// images.

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const rehearsal = join(root, 'deploy/rehearsal');
const workflow = join(root, '.github/workflows/fork-deploy-rehearsal.yml');

const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
const hasCompose = dockerCompose.status === 0;

type Config = {
  name: string;
  volumes: Record<string, { name: string }>;
  services: Record<string, { image: string }>;
};

const configOf = (project: string, image: string, proxy: string): Config => ({
  name: project,
  volumes: Object.fromEntries(
    ['maka-data', 'maka-backups', 'caddy-data', 'caddy-config'].map((v) => [
      v,
      { name: `${project}_${v}` },
    ]),
  ),
  services: {
    'maka-cloud': { image },
    stubs: { image },
    proxy: { image: proxy },
  },
});

const rehearsalConfig = configOf(
  'maka-rehearsal',
  'maka-rehearsal:local',
  'maka-rehearsal-proxy:local',
);
const productionConfig = configOf('maka-cloud', 'maka-cloud:local', 'maka-cloud-proxy:local');

/** A `docker` that answers `compose config` from a file and records every other call. */
const withFakeDocker = (config: Config) => {
  const dir = mkdtempSync(join(tmpdir(), 'rehearsal-project-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  writeFileSync(
    join(dir, 'docker'),
    `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = config ]; then cat "${join(dir, 'config.json')}"; exit 0; fi
done
echo "$*" >> "${join(dir, 'calls.log')}"
`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync('bash', [join(rehearsal, script), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MAKA_REHEARSAL_DIR: dir, ...env },
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    } catch {}
    return { status: result.status, stderr: result.stderr, calls };
  };
  return { dir, run };
};

test('the rehearsal resolves to its own project, volumes and images, with or without -p', {
  skip: !hasCompose,
}, () => {
  for (const project of [[], ['-p', 'maka-rehearsal']]) {
    const out = spawnSync(
      'docker',
      [
        'compose',
        ...project,
        '-f',
        join(root, 'deploy/compose.yaml'),
        '-f',
        join(rehearsal, 'compose.yaml'),
        '--env-file',
        join(rehearsal, 'compose.env'),
        'config',
        '--format',
        'json',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, MAKA_CLOUD_ENV_FILE: join(rehearsal, 'server.env') },
      },
    );
    assert.equal(out.status, 0, out.stderr);
    const config = JSON.parse(out.stdout) as Config;
    assert.equal(config.name, 'maka-rehearsal');
    const volumes = Object.values(config.volumes).map((v) => v.name);
    assert.ok(volumes.length >= 4);
    for (const name of volumes) assert.match(name, /^maka-rehearsal_/u, name);
    for (const [service, { image }] of Object.entries(config.services)) {
      assert.match(image, /^maka-rehearsal(-proxy)?:local$/u, `${service} builds ${image}`);
    }
  }
});

test('down.sh takes down the rehearsal project only, and refuses a stack that resolves to anything else', () => {
  const ok = withFakeDocker(rehearsalConfig);
  const done = ok.run('down.sh', []);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.calls.length, 1);
  assert.match(
    done.calls[0] ?? '',
    /^compose -p maka-rehearsal .* down --volumes --remove-orphans$/u,
  );

  const live = withFakeDocker(productionConfig);
  const refused = live.run('down.sh', []);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to touch the stack/u);
  assert.deepEqual(refused.calls, [], 'nothing was taken down');

  // The project is the rehearsal's but one volume is a deployment's: still refused.
  const shared = structuredClone(rehearsalConfig);
  shared.volumes['maka-data'] = { name: 'maka-cloud_maka-data' };
  const mixed = withFakeDocker(shared).run('down.sh', []);
  assert.notEqual(mixed.status, 0);
  assert.deepEqual(mixed.calls, []);

  // And one image is a deployment's.
  const retagged = structuredClone(rehearsalConfig);
  retagged.services['maka-cloud'] = { image: 'maka-cloud:local' };
  const retag = withFakeDocker(retagged).run('down.sh', []);
  assert.notEqual(retag.status, 0);
  assert.deepEqual(retag.calls, []);
});

test('ops.sh stops, restores and backs up the rehearsal project only', () => {
  const ok = withFakeDocker(rehearsalConfig);
  for (const args of [
    ['stop'],
    ['start'],
    ['restart'],
    ['backup'],
    ['restore', 'b1'],
    ['ps'],
    ['logs'],
  ]) {
    const done = ok.run('ops.sh', args);
    assert.equal(done.status, 0, `${args.join(' ')}: ${done.stderr}`);
    assert.match(done.calls.at(-1) ?? '', /^compose -p maka-rehearsal /u, args.join(' '));
  }

  const live = withFakeDocker(productionConfig);
  for (const args of [
    ['stop'],
    ['start'],
    ['restart'],
    ['backup'],
    ['restore', 'b1'],
    ['ps'],
    ['logs'],
  ]) {
    const refused = live.run('ops.sh', args);
    assert.notEqual(refused.status, 0, args.join(' '));
    assert.deepEqual(refused.calls, [], `${args.join(' ')} reached Compose`);
  }
});

test('a project name outside the rehearsal prefix is refused before Compose is reached', () => {
  const fake = withFakeDocker(productionConfig);
  for (const project of ['maka-cloud', 'maka-cloudrehearsal', 'rehearsal']) {
    for (const script of ['down.sh', 'ops.sh']) {
      const refused = fake.run(script, ['stop'], { MAKA_REHEARSAL_PROJECT: project });
      assert.notEqual(refused.status, 0, `${script} with ${project}`);
      assert.deepEqual(refused.calls, []);
    }
  }
});

test('the rehearsal reaches Compose only through lib.sh, which names the project', () => {
  const files = readdirSync(rehearsal)
    .filter((f) => f.endsWith('.sh') && f !== 'lib.sh')
    .map((f) => join(rehearsal, f));
  files.push(workflow);
  for (const file of files) {
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /docker[- ]compose/u,
      `${file} runs Compose itself`,
    );
  }
  const lib = readFileSync(join(rehearsal, 'lib.sh'), 'utf8');
  assert.match(lib, /docker compose -p "\$REHEARSAL_PROJECT"/u);
});
