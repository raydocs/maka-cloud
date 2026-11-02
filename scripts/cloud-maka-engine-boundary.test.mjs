import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ENGINE_CONSUMER_BUILD_FILES,
  ENGINE_PACKAGE_DIR,
  FORBIDDEN_MAKA_PACKAGES,
  findForbiddenCloudMakaImports,
  findMissingMakaEngineBuildSteps,
} from './cloud-maka-engine-boundary.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('cloud packages outside the engine do not import in-process @maka/* packages', () => {
  const hits = findForbiddenCloudMakaImports(repoRoot);
  assert.deepEqual(hits, [], hits.map((hit) => `${hit.file}: ${hit.specifier}`).join('\n'));
});

test('the scanner reports a source import and a package.json dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-engine-boundary-'));
  const pkg = join(root, 'packages', 'cloud-probe');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@maka-cloud/probe', dependencies: { '@maka/core': '0.1.0' } }),
  );
  writeFileSync(
    join(pkg, 'src', 'use.ts'),
    "import type { SessionEvent } from '@maka/core/events';\nexport type { SessionEvent };\n",
  );
  mkdirSync(join(root, 'packages', 'cloud-maka-engine', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'cloud-maka-engine', 'src', 'ok.ts'),
    "import { SessionManager } from '@maka/runtime/session-manager';\nexport { SessionManager };\n",
  );

  const hits = findForbiddenCloudMakaImports(root);
  assert.equal(hits.length, 2, JSON.stringify(hits, null, 2));
  assert.ok(hits.some((hit) => hit.kind === 'import' && hit.file.includes('cloud-probe')));
  assert.ok(hits.some((hit) => hit.kind === 'dependency' && hit.specifier === '@maka/core'));
  assert.ok(!hits.some((hit) => hit.file.includes(ENGINE_PACKAGE_DIR)));
  assert.deepEqual(FORBIDDEN_MAKA_PACKAGES, ['core', 'runtime', 'storage', 'runtime-host', 'eval']);
});

test('deploy, cloud-web and cloud-mobile build maka-engine before instabox', () => {
  const hits = findMissingMakaEngineBuildSteps(repoRoot);
  assert.deepEqual(hits, [], hits.map((hit) => `${hit.file}: ${hit.reason}`).join('\n'));
  assert.deepEqual(ENGINE_CONSUMER_BUILD_FILES, [
    'deploy/Dockerfile',
    '.github/workflows/fork-cloud-web.yml',
    '.github/workflows/fork-cloud-mobile.yml',
  ]);
});

test('the build-step scanner reports an instabox compile with no engine before it', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-engine-build-step-'));
  mkdirSync(join(root, 'deploy'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(root, 'deploy', 'Dockerfile'),
    'RUN npm --workspace @maka-cloud/instabox run build\n',
  );
  writeFileSync(
    join(root, '.github', 'workflows', 'fork-cloud-web.yml'),
    'npm --workspace @maka-cloud/maka-engine run build\nnpm --workspace @maka-cloud/instabox run build\n',
  );
  writeFileSync(
    join(root, '.github', 'workflows', 'fork-cloud-mobile.yml'),
    'npm --workspace @maka-cloud/maka-engine run build\nnpm --workspace @maka-cloud/instabox run build\n',
  );
  const hits = findMissingMakaEngineBuildSteps(root);
  assert.equal(hits.length, 1, JSON.stringify(hits, null, 2));
  assert.equal(hits[0]?.file, 'deploy/Dockerfile');
});
