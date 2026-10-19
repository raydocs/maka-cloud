import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { citeCheckSandboxTool } from '../../sandbox-tool.js';
import { parseCiteCheckLine } from '../summary-line.js';
import { PAGE_BRIDGE_HTML, PAGE_TUNNEL_TXT, sampleReport } from './fixtures.js';

const run = promisify(execFile);

test('the sandbox tool is one file that runs on its own and checks a report', async () => {
  const tool = await citeCheckSandboxTool();
  assert.equal(tool.name, 'cite-check');
  assert.match(tool.content.toString('utf8', 0, 30), /^#!\/usr\/bin\/env node\n/);

  // Away from the package and its node_modules: nothing but the file itself.
  const dir = await mkdtemp(join(tmpdir(), 'cite-tool-'));
  try {
    await mkdir(join(dir, 'sources'));
    await writeFile(join(dir, 'sources/bridge.html'), PAGE_BRIDGE_HTML);
    await writeFile(join(dir, 'sources/tunnel.txt'), PAGE_TUNNEL_TXT);
    await writeFile(join(dir, 'report.json'), JSON.stringify(sampleReport()));
    await writeFile(join(dir, 'cite-check.mjs'), tool.content);
    const { stdout } = await run(
      process.execPath,
      [
        join(dir, 'cite-check.mjs'),
        '--report',
        join(dir, 'report.json'),
        '--sources',
        join(dir, 'sources'),
        '--out',
        join(dir, 'out'),
      ],
      { cwd: dir },
    );
    const parsed = parseCiteCheckLine(stdout.trimEnd().split('\n').pop() ?? '');
    assert.equal(parsed.ok, true);
    assert.match(await readFile(join(dir, 'out/report.md'), 'utf8'), /^# Harbor crossings/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
