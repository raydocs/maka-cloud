import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The kept conversation is the model's history, stored exactly as the CLI wrote it (unscrubbed).
// It must never reach a reader, so the server that answers HTTP has no handle on the store at all:
// it does not depend on the runners package, and nothing in its source names the store or its file.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('the HTTP server has no way to read the kept conversation', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.ok(
    !Object.keys(pkg.dependencies ?? {}).includes('@maka-cloud/runners'),
    'cloud-server depends on the runners package, which holds the transcript store',
  );
  const files = sources(join(root, 'src'));
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(
      !/TranscriptStore|transcripts\.db|transcript_lines|restoreTranscript/u.test(text),
      `${file} names the transcript store`,
    );
  }
});
