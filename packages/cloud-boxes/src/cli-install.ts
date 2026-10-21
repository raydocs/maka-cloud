import type { RunnerName } from '@maka-cloud/runners';

/**
 * One npm tarball and the sha512 integrity string npm prints for it (`npm view <spec> dist.integrity`).
 * `spec` is what `npm pack` is given; `installAs` is the package name the tarball is installed under.
 */
interface Tarball {
  spec: string;
  integrity: string;
  installAs: string;
}

interface Pin {
  version: string;
  binary: string;
  /** The wrapper package that has the `bin` entry. */
  main: Tarball;
  /** The package with the compiled program, per CPU. The wrapper looks it up by name when it starts. */
  native: { x64: Tarball; arm64: Tarball };
}

/**
 * The CLI versions a box may run and the checksum of every tarball that makes them up. A bump of a
 * version in the runners package without its checksums here fails a test: this table is the only
 * thing that decides what code the pool puts in a box next to the user's repository and tokens.
 *
 * Checksums are of the registry's tarballs; they were read with `npm view <spec> dist.integrity` and
 * compared with the sha512 of the `npm pack` file of the same spec.
 */
export const CLI_PINS: Readonly<Record<'claude-agent-sdk' | 'codex', Pin>> = {
  'claude-agent-sdk': {
    version: '2.1.303',
    binary: 'claude',
    main: {
      spec: '@anthropic-ai/claude-code@2.1.303',
      integrity:
        'sha512-vGwsxL/bjxl7crYg2/BLBs75ErQ22x9L3LKqZqwqZ9vwp6A41sVCDdBXsPftM19V5LAwK6/s/sAxIVjX6F4O6Q==',
      installAs: '@anthropic-ai/claude-code',
    },
    native: {
      x64: {
        spec: '@anthropic-ai/claude-code-linux-x64@2.1.303',
        integrity:
          'sha512-yUbFvO0As5DKZfeu102GLBtrGz0ghkFteHyW4rbkKVXZCwSWisXqtbm4Nolt9AlKSCAggQoyqCEG7EEF0wXciQ==',
        installAs: '@anthropic-ai/claude-code-linux-x64',
      },
      arm64: {
        spec: '@anthropic-ai/claude-code-linux-arm64@2.1.303',
        integrity:
          'sha512-LLwZGiNgKUQqyCS5Y7TqHz6VPQJuL1MgFrC9WdGyKDPeiRzyIhMH4U9Il7l6oNLExOd42PqEExUVODbGLL7T1A==',
        installAs: '@anthropic-ai/claude-code-linux-arm64',
      },
    },
  },
  codex: {
    version: '0.163.0',
    binary: 'codex',
    main: {
      spec: '@openai/codex@0.163.0',
      integrity:
        'sha512-HNd7vR9oTK6M2ikxFnvNDCdYUgAsyo9VVnd5KnEd2ON0GYI++7MiX9XNPUkhtdgGKFPsWS+CEppQ1UU63uVhUw==',
      installAs: '@openai/codex',
    },
    native: {
      x64: {
        spec: '@openai/codex@0.163.0-linux-x64',
        integrity:
          'sha512-uwRaOsrYogLQhcxAM/GoeWrw0QIWEMRo7c9gM8sKAviVkZQHlu9kRLJ5PkufbV+ABGjyZgIwiFdJ0LCJ0N6e8w==',
        installAs: '@openai/codex-linux-x64',
      },
      arm64: {
        spec: '@openai/codex@0.163.0-linux-arm64',
        integrity:
          'sha512-IH2/R+4OarjGvsAf1ll3fdyLwrPgYLl3uzp6u9CyD9sj2Lw+ViDSe3QBZVHdcHJs0eIiZFg6Wprcuy4CRZaUGw==',
        installAs: '@openai/codex-linux-arm64',
      },
    },
  },
};

/** The versions to give the fleet's `versions` option, so it expects what the install puts in the box. */
export function pinnedVersions(
  pins: typeof CLI_PINS = CLI_PINS,
): Record<keyof typeof CLI_PINS, string> {
  return {
    'claude-agent-sdk': pins['claude-agent-sdk'].version,
    codex: pins.codex.version,
  };
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The fleet's `installCommands`: a script that downloads each tarball (`npm pack`), compares its
 * sha512 with the pinned one, and only then installs the checked files from disk, with `--offline`
 * so npm cannot fetch anything else. A mismatch, an unknown CPU, a missing tool or a binary that
 * does not report the pinned version stops the script before or after the install with a message,
 * and the fleet treats the install as failed. Nothing is installed from an unchecked tarball, and a
 * failed check leaves a CLI that was installed before as it was.
 */
export function cliInstallCommands(
  pins: typeof CLI_PINS = CLI_PINS,
): Partial<Record<RunnerName, string>> {
  return {
    'claude-agent-sdk': installScript(pins['claude-agent-sdk']),
    codex: installScript(pins.codex),
  };
}

function installScript(pin: Pin): string {
  const native = (cpu: 'x64' | 'arm64'): string => {
    const t = pin.native[cpu];
    return `  ${cpu}) NATIVE_SPEC=${quote(t.spec)}; NATIVE_SUM=${quote(t.integrity)}; NATIVE_NAME=${quote(t.installAs)} ;;`;
  };
  return `set -e
command -v npm >/dev/null 2>&1 || { echo "npm is not installed in the sandbox image"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is not installed in the sandbox image"; exit 1; }
case "$(uname -s)" in Linux) ;; *) echo "unsupported system $(uname -s)"; exit 1 ;; esac
case "$(uname -m)" in
  x86_64|amd64) CPU=x64 ;;
  aarch64|arm64) CPU=arm64 ;;
  *) echo "unsupported CPU $(uname -m)"; exit 1 ;;
esac
case "$CPU" in
${native('x64')}
${native('arm64')}
esac
checksum() {
  node -e 'const c=require("crypto"),f=require("fs");process.stdout.write("sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64"))' "$1"
}
fetch_checked() {
  spec="$1"; want="$2"
  file="$(npm pack --silent --no-audit --no-fund --pack-destination "$WORK" "$spec" | tail -n 1)"
  [ -n "$file" ] && [ -f "$WORK/$file" ] || { echo "could not download $spec" >&2; exit 1; }
  got="$(checksum "$WORK/$file")"
  [ "$got" = "$want" ] || { echo "checksum of $spec does not match the pinned one" >&2; exit 1; }
  printf '%s' "$WORK/$file"
}
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
MAIN_FILE="$(fetch_checked ${quote(pin.main.spec)} ${quote(pin.main.integrity)})"
NATIVE_FILE="$(fetch_checked "$NATIVE_SPEC" "$NATIVE_SUM")"
npm install -g --prefix "$HOME/.maka-cli" --no-audit --no-fund --offline "$MAIN_FILE" "$NATIVE_NAME@file:$NATIVE_FILE"
"$HOME/.maka-cli/bin/${pin.binary}" --version 2>&1 | grep -F ${quote(pin.version)} >/dev/null || { echo "${pin.binary} does not report version ${pin.version}"; exit 1; }`;
}
