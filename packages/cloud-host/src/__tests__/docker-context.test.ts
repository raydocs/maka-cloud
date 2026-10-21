import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The images are built from the whole checkout directory. Whatever the build context lets through
// ends up in a layer: a `.env` a developer left next to the code, an `.npmrc` with a registry token
// or a private key in the build directory would be in the image, and in every copy of it. The
// context is therefore an allowlist (.dockerignore), and the Dockerfile copies named paths only.

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const IGNORE = readFileSync(`${root}.dockerignore`, 'utf8');
const DOCKERFILE = readFileSync(`${root}deploy/Dockerfile`, 'utf8');

type Pattern = { exclusion: boolean; regex: RegExp };

/** The patterns of a .dockerignore, as Docker (moby/patternmatcher) reads them. */
function parse(text: string): Pattern[] {
  const patterns: Pattern[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    let exclusion = false;
    if (line.startsWith('!')) {
      exclusion = true;
      line = line.slice(1).trim();
    }
    line = line.replace(/\/+/gu, '/').replace(/\/$/u, '').replace(/^\//u, '');
    if (line === '' || line === '.') continue;
    let source = '^';
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i] as string;
      if (ch === '*') {
        if (line[i + 1] === '*') {
          while (line[i + 1] === '*') i += 1;
          if (i + 1 >= line.length) source += '.*';
          else if (line[i + 1] === '/') {
            i += 1;
            source += '(.*/)?';
          } else source += '.*';
        } else source += '[^/]*';
      } else if (ch === '?') source += '[^/]';
      else if (ch === '\\' && i + 1 < line.length) {
        i += 1;
        source += (line[i] as string).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      } else source += ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    }
    patterns.push({ exclusion, regex: new RegExp(`${source}$`, 'u') });
  }
  return patterns;
}

const PATTERNS = parse(IGNORE);

/** Whether the context leaves `file` out: the last pattern that matches it, or a directory above it, decides. */
function excluded(file: string): boolean {
  let out = false;
  for (const pattern of PATTERNS) {
    const parts = file.split('/');
    const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    if (candidates.some((candidate) => pattern.regex.test(candidate))) out = !pattern.exclusion;
  }
  return out;
}

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
const hasGit = tracked.status === 0;
const files = hasGit ? tracked.stdout.split('\0').filter(Boolean) : [];

/** What a developer or a CI job might leave in a checkout, at the root and inside what is allowed. */
const SECRETS = [
  '.env',
  '.env.local',
  '.env.production',
  'server.env',
  'deploy/rehearsal/server.env',
  'packages/cloud-host/.env',
  'packages/cloud-host/.env.local',
  'packages/cloud-host/prod.env',
  'packages/cloud-web/.env.production',
  '.npmrc',
  'packages/cloud-web/.npmrc',
  'packages/cloud-host/.yarnrc.yml',
  '.netrc',
  '.git-credentials',
  '.aws/credentials',
  '.ssh/id_ed25519',
  'id_rsa',
  'packages/cloud-host/id_ed25519.pub',
  'deploy/key.pem',
  'packages/cloud-host/tls/server.key',
  'packages/cloud-host/github-app.pem',
  'packages/cloud-host/store.p12',
  'packages/cloud-host/service-account-prod.json',
  'packages/cloud-host/credentials.json',
  '.git/config',
  '.claude/settings.local.json',
];

test('the build context lets through the build inputs and nothing a checkout might hold besides', {
  skip: !hasGit,
}, () => {
  const required = [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'tsconfig.lib.json',
    'packages/cloud-host/package.json',
    'packages/cloud-host/src/index.ts',
    'packages/cloud-web/package.json',
    'packages/runtime/scripts/build-filesystem-worker.mjs',
    'scripts/sync-model-metadata.mjs',
    'scripts/model-metadata/models-dev-api.snapshot.json',
    'deploy/Caddyfile',
  ];
  for (const file of required) {
    assert.ok(files.includes(file), `${file} is tracked`);
    assert.equal(excluded(file), false, `${file} is a build input`);
  }

  const allowed = (file: string): boolean =>
    [
      'package.json',
      'package-lock.json',
      'tsconfig.base.json',
      'tsconfig.lib.json',
      'scripts/sync-model-metadata.mjs',
      'deploy/Caddyfile',
    ].includes(file) ||
    file.startsWith('packages/') ||
    file.startsWith('scripts/model-metadata/');
  const strays = files.filter((file) => !excluded(file) && !allowed(file));
  assert.deepEqual(strays, [], 'tracked files outside the allowlist are in the context');

  for (const secret of SECRETS) {
    assert.equal(excluded(secret), true, `${secret} must stay out of the context`);
  }
  // Build output stays out too, wherever it is.
  for (const built of [
    'node_modules/x/index.js',
    'packages/cloud-host/dist/cli.js',
    'packages/cloud-host/node_modules/y/z.js',
    'packages/cloud-web/test-results/a.png',
  ]) {
    assert.equal(excluded(built), true, built);
  }
});

test('the Dockerfile copies named paths into the build, never the whole context, and the context lets each of them through', {
  skip: !hasGit,
}, () => {
  const copies = DOCKERFILE.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^COPY\s/u.test(line) && !line.includes('--from='))
    .map((line) => line.replace(/^COPY\s+/u, '').split(/\s+/u));
  assert.ok(copies.length >= 3, 'the Dockerfile copies from the context');
  for (const parts of copies) {
    const sources = parts.slice(0, -1);
    for (const source of sources) {
      assert.ok(
        !['.', './', '*', './*', '/'].includes(source),
        `COPY ${parts.join(' ')} copies the whole context`,
      );
      const under = files.filter((file) => file === source || file.startsWith(`${source}/`));
      assert.ok(under.length > 0, `${source} is tracked`);
      assert.ok(
        under.some((file) => !excluded(file)),
        `the context leaves out all of ${source}`,
      );
    }
  }
});
