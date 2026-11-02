import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

test('cloud packages outside this engine do not import @maka/core, runtime, storage, runtime-host or eval', async () => {
  const { findForbiddenCloudMakaImports } = await import(
    new URL('../../../../scripts/cloud-maka-engine-boundary.mjs', import.meta.url).href
  );
  const hits = findForbiddenCloudMakaImports(repoRoot);
  assert.deepEqual(
    hits,
    [],
    hits
      .map((hit: { file: string; specifier: string }) => `${hit.file}: ${hit.specifier}`)
      .join('\n'),
  );
});
