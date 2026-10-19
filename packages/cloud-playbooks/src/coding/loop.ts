export interface LoopLimits {
  /** A file coming back to an earlier version this many times is a loop. Default 3. */
  maxRevisits: number;
  /** A file changing in more than this many samples of one vendor's attempt is a loop. Default 30. */
  maxChanges: number;
}

export const DEFAULT_LOOP_LIMITS: LoopLimits = { maxRevisits: 3, maxChanges: 30 };

/** The version a file is at in one sample: its content hash, or `base` when it is unchanged. */
export type FileVersions = ReadonlyMap<string, string>;

interface FileHistory {
  current: string;
  seen: Set<string>;
  changes: number;
  revisits: number;
}

/**
 * Watches the files of one vendor's attempt across samples of the workspace. A loop is an
 * agent editing the same file over and over without getting anywhere: the file keeps coming
 * back to versions it had before, or it keeps changing far longer than any other edit takes.
 */
export class LoopDetector {
  private readonly files = new Map<string, FileHistory>();

  constructor(private readonly limits: LoopLimits = DEFAULT_LOOP_LIMITS) {}

  /** Feeds one sample. Returns why it is a loop, or undefined. */
  observe(sample: FileVersions): string | undefined {
    for (const [path, history] of this.files) {
      if (!sample.has(path)) this.step(path, history, 'base');
    }
    for (const [path, version] of sample) {
      const history = this.files.get(path);
      if (!history) {
        this.files.set(path, {
          current: version,
          seen: new Set(['base', version]),
          changes: 1,
          revisits: 0,
        });
        continue;
      }
      this.step(path, history, version);
    }
    for (const [path, history] of this.files) {
      if (history.revisits >= this.limits.maxRevisits) {
        return `${path} went back to an earlier version ${history.revisits} times`;
      }
      if (history.changes > this.limits.maxChanges) {
        return `${path} changed in ${history.changes} samples without the attempt finishing`;
      }
    }
    return undefined;
  }

  private step(_path: string, history: FileHistory, version: string): void {
    if (version === history.current) return;
    history.changes++;
    if (history.seen.has(version)) history.revisits++;
    history.seen.add(version);
    history.current = version;
  }
}

/** Parses the output of `SAMPLE_SCRIPT`. */
export function parseSample(stdout: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (line.startsWith('H ')) {
      const rest = line.slice(2);
      const space = rest.indexOf(' ');
      if (space > 0) versions.set(rest.slice(space + 1), rest.slice(0, space));
    } else if (line.startsWith('L ')) {
      versions.set(line.slice(2), 'symlink');
    } else if (line.startsWith('D ')) {
      versions.set(line.slice(2), 'deleted');
    }
  }
  return versions;
}
