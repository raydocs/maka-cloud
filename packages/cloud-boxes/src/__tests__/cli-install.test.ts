import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { claudeAdapter, codexAdapter } from '@maka-cloud/runners';
import { CLI_PINS, cliInstallCommands, pinnedVersions } from '../cli-install.js';

const sum = (content: string) => `sha512-${createHash('sha512').update(content).digest('base64')}`;

/** Pins for a made-up package whose "tarballs" are small files we control. */
function fakePins(contents: Record<string, string>) {
  const tarball = (spec: string, installAs: string) => ({
    spec,
    installAs,
    integrity: sum(contents[spec] ?? ''),
  });
  const pin = (version: string, binary: string, name: string) => ({
    version,
    binary,
    main: tarball(`${name}@${version}`, name),
    native: {
      x64: tarball(`${name}-linux-x64@${version}`, `${name}-linux-x64`),
      arm64: tarball(`${name}-linux-arm64@${version}`, `${name}-linux-arm64`),
    },
  });
  return {
    'claude-agent-sdk': pin('9.9.9', 'claude', '@x/claude'),
    codex: pin('8.8.8', 'codex', '@x/codex'),
  } as typeof CLI_PINS;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs an install script in `sh` with an `npm` that serves the given tarball contents, a `uname`
 * that reports the given CPU, and the real `node`. The fake npm records how it was called.
 */
function run(
  script: string,
  options: {
    served: Record<string, string>;
    cpu?: string;
    system?: string;
    binaryVersion?: string;
    binary?: string;
  },
) {
  const root = mkdtempSync(join(tmpdir(), 'cli-install-'));
  dirs.push(root);
  const bin = join(root, 'shims');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(root, 'served.json'), JSON.stringify(options.served));
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh
echo "$@" >> "${root}/npm.log"
case "$1" in
  pack)
    shift
    dest=""; spec=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --pack-destination) dest="$2"; shift 2 ;;
        --*) shift ;;
        *) spec="$1"; shift ;;
      esac
    done
    name="$(printf '%s' "$spec" | tr '/@' '__').tgz"
    ${process.execPath} -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];if(s===undefined)process.exit(1);process.stdout.write(s)' "${root}/served.json" "$spec" > "$dest/$name" || exit 1
    echo "$name"
    ;;
  install)
    mkdir -p "$HOME/.maka-cli/bin"
    printf '#!/bin/sh\\necho "%s"\\n' '${options.binaryVersion ?? ''}' > "$HOME/.maka-cli/bin/${options.binary ?? 'claude'}"
    chmod +x "$HOME/.maka-cli/bin/${options.binary ?? 'claude'}"
    ;;
esac
`,
  );
  writeFileSync(
    join(bin, 'uname'),
    `#!/bin/sh\ncase "$1" in -s) echo ${options.system ?? 'Linux'} ;; -m) echo ${options.cpu ?? 'x86_64'} ;; esac\n`,
  );
  for (const file of ['npm', 'uname']) chmodSync(join(bin, file), 0o755);
  const nodeDir = join(root, 'nodebin');
  mkdirSync(nodeDir);
  writeFileSync(join(nodeDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  chmodSync(join(nodeDir, 'node'), 0o755);
  const result = spawnSync('sh', ['-c', script], {
    env: { PATH: `${bin}:${nodeDir}:/usr/bin:/bin`, HOME: home, TMPDIR: root },
    encoding: 'utf8',
  });
  const log = existsSync(join(root, 'npm.log')) ? readFileSync(join(root, 'npm.log'), 'utf8') : '';
  return { ...result, npmLog: log.trim().split('\n').filter(Boolean), home };
}

const served = {
  '@x/claude@9.9.9': 'main tarball',
  '@x/claude-linux-x64@9.9.9': 'native x64',
  '@x/claude-linux-arm64@9.9.9': 'native arm64',
};

describe('pinned CLI install script', () => {
  it('the pins cover exactly the versions the runners install by default', () => {
    assert.equal(CLI_PINS['claude-agent-sdk'].version, claudeAdapter.defaultVersion);
    assert.equal(CLI_PINS.codex.version, codexAdapter.defaultVersion);
    assert.deepEqual(pinnedVersions(), {
      'claude-agent-sdk': claudeAdapter.defaultVersion,
      codex: codexAdapter.defaultVersion,
    });
    for (const pin of Object.values(CLI_PINS)) {
      for (const tarball of [pin.main, pin.native.x64, pin.native.arm64]) {
        assert.ok(tarball.spec.endsWith(pin.version) || tarball.spec.includes(`${pin.version}-`));
        assert.match(tarball.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
      }
    }
  });

  it('downloads each tarball, checks it, and installs the checked files from disk, offline', () => {
    const pins = fakePins(served);
    const script = cliInstallCommands(pins)['claude-agent-sdk'] as string;
    const result = run(script, { served, binaryVersion: 'v 9.9.9 (x)' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.npmLog.filter((line) => line.startsWith('pack')).length, 2);
    const install = result.npmLog.find((line) => line.startsWith('install')) as string;
    assert.match(install, /-g --prefix \S+\/\.maka-cli --no-audit --no-fund --offline /);
    assert.match(install, /\/_x_claude_9\.9\.9\.tgz /);
    assert.match(install, /@x\/claude-linux-x64@file:\S+\.tgz$/);
  });

  it('picks the native package of the box CPU', () => {
    const pins = fakePins(served);
    const script = cliInstallCommands(pins)['claude-agent-sdk'] as string;
    const result = run(script, { served, cpu: 'aarch64' });
    const install = result.npmLog.find((line) => line.startsWith('install')) as string;
    assert.match(install, /@x\/claude-linux-arm64@file:/);
  });

  it('installs nothing when a tarball does not match its pinned checksum', () => {
    const pins = fakePins(served);
    const script = cliInstallCommands(pins)['claude-agent-sdk'] as string;
    for (const tampered of ['@x/claude@9.9.9', '@x/claude-linux-x64@9.9.9']) {
      const result = run(script, { served: { ...served, [tampered]: 'something else' } });
      assert.notEqual(result.status, 0, tampered);
      assert.match(result.stderr, /does not match the pinned one/);
      assert.equal(
        result.npmLog.some((line) => line.startsWith('install')),
        false,
        `${tampered} must not be installed`,
      );
    }
  });

  it('installs nothing when a tarball cannot be downloaded', () => {
    const pins = fakePins(served);
    const script = cliInstallCommands(pins)['claude-agent-sdk'] as string;
    const result = run(script, { served: {} });
    assert.notEqual(result.status, 0);
    assert.equal(
      result.npmLog.some((line) => line.startsWith('install')),
      false,
    );
  });

  it('refuses another system or CPU before downloading anything', () => {
    const pins = fakePins(served);
    const script = cliInstallCommands(pins)['claude-agent-sdk'] as string;
    for (const options of [{ cpu: 'riscv64' }, { system: 'Darwin' }]) {
      const result = run(script, { served, ...options });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /unsupported/);
      assert.deepEqual(result.npmLog, []);
    }
  });

  it('fails when the installed program does not report the pinned version', () => {
    const codex = { '@x/codex@8.8.8': 'a', '@x/codex-linux-x64@8.8.8': 'b' };
    const pins = fakePins(codex);
    const script = cliInstallCommands(pins).codex as string;
    const ok = run(script, { served: codex, binary: 'codex', binaryVersion: 'codex-cli 8.8.8' });
    assert.equal(ok.status, 0, ok.stderr);
    const wrong = run(script, {
      served: codex,
      binary: 'codex',
      binaryVersion: 'codex-cli 1.0.0',
    });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stdout, /does not report version 8\.8\.8/);
  });
});
