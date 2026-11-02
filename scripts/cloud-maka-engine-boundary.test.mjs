import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ENGINE_PACKAGE_DIR,
  FORBIDDEN_MAKA_PACKAGES,
  findForbiddenCloudMakaImports,
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
