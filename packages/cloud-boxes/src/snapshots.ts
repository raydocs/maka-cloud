import { createHash } from 'node:crypto';
import type { InstaboxClient, InstaboxExecResult } from '@maka-cloud/instabox';
import type { AgentChannel } from '@maka-cloud/runners';
import { AGENT_CHECK_SCRIPT, agentProblems, asRepoUser } from './agent.js';
import { SCRUB_SCRIPT } from './scrub.js';

/** Bump when the way a snapshot is built changes, so old snapshots are no longer reused. */
const RECIPE_VERSION = 1;

/** Where the checkout of a repository lives in a box that was made from its setup snapshot. */
export const REPOS_ROOT = '/data/maka/repos';

const DEFAULT_SETUP_TIMEOUT_SECONDS = 1_200;
const STEP_TIMEOUT_SECONDS = 300;
const OUTPUT_TAIL = 2_000;

type SnapshotRecord = Awaited<ReturnType<InstaboxClient['listSnapshots']>>[number];

/** The part of the instabox client the builder uses. */
export type SnapshotApi = Pick<
  InstaboxClient,
  'createSnapshot' | 'deleteSnapshot' | 'exec' | 'listSnapshots' | 'waitForSnapshot'
>;

/** A box to build in, from the pool. The builder gives it back whatever happens. */
export interface BuilderBoxes {
  lease(input: {
    tenantId: string;
    /** Names the job (the setup hash), so a build that dies leaves a label that says what it was. */
    job: string;
  }): Promise<{ machineId: string; release(): Promise<void> | void }>;
}

export interface SetupRecipe {
  /** Whose snapshot this is. A snapshot is never shared across invites: its files come from the invite's own repository. */
  tenantId: string;
  /** `https://` clone URL, no credentials. */
  repoUrl: string;
  /** The commit to check out, a full sha. It is not part of the hash: a later commit with the same setup reuses the snapshot. */
  ref: string;
  /** The content of `.agents/setup` at `ref`, or undefined when the repository has none. */
  setupScript: string | undefined;
  /** Commands run before the setup (the pinned CLI installs). Part of the hash. */
  prepare: readonly string[];
  /** What the box the snapshot is built in starts from (its template). Part of the hash. */
  base: string;
}

export interface SetupSnapshot {
  snapshotId: string;
  /** Whose snapshot this is; the pool checks it against the task's invite. */
  tenantId: string;
  /** The hash of the setup this snapshot holds; boxes made from it carry it as `maka.setup`. */
  setupHash: string;
  /** `repoKey` of the repository, for the `maka.repo` label and the checkout directory. */
  repo: string;
  name: string;
  /** False when a snapshot of this setup already existed. */
  built: boolean;
}

export interface SetupSnapshotsOptions {
  api: SnapshotApi;
  boxes: BuilderBoxes;
  /**
   * Runs on the builder box before anything else in it (the egress guard). When it throws nothing
   * is run and no snapshot is made.
   */
  guard: (machineId: string) => Promise<void>;
  /**
   * The unprivileged account the repository's `.agents/setup` runs as. Without it no repository
   * script is run and a repository with a setup script gets no snapshot: the builder's sandbox user
   * has passwordless sudo, so a script as that user could undo the egress guard.
   */
  agent?: AgentChannel;
  /** How long the repository's setup may run, in seconds. Default 1200. */
  setupTimeoutSeconds?: number;
  /** How many snapshots of one repository an invite keeps. Default 2. */
  keep?: number;
  onWarning?: (message: string, detail?: unknown) => void;
}

/** The setup, or a step before it, failed in the builder box. */
export class SetupFailedError extends Error {
  constructor(
    readonly step: string,
    detail: string,
  ) {
    super(`the setup failed at ${step}: ${detail}`);
    this.name = 'SetupFailedError';
  }
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

export function setupHash(
  recipe: Pick<SetupRecipe, 'repoUrl' | 'setupScript' | 'prepare' | 'base'>,
): string {
  return sha(
    JSON.stringify({
      v: RECIPE_VERSION,
      repoUrl: recipe.repoUrl,
      setup: recipe.setupScript ?? null,
      prepare: recipe.prepare,
      base: recipe.base,
    }),
  );
}

/**
 * The snapshot's name: instabox names are unique per account, so this is also what makes two builders
 * racing end with one snapshot. It carries the invite, the repository and the setup hash.
 */
export function snapshotName(tenantId: string, repoUrl: string, hash: string): string {
  return `${repoPrefix(tenantId, repoUrl)}${hash.slice(0, 16)}`;
}

// 96 bits of the invite and 48 of the repository: a short prefix is not a proof of ownership (two
// invites were found to share 8 hex digits), so the name is long and the description is checked too.
const repoPrefix = (tenantId: string, repoUrl: string): string =>
  `mk-${sha(tenantId).slice(0, 24)}-${sha(repoUrl).slice(0, 12)}-`;

/**
 * What the snapshot's description says it is, with the full digests. A snapshot found by name is used,
 * or deleted, only when this matches. A snapshot with no description, or another one, is not ours: a name
 * is not proof, so there is no fallback to it.
 */
export function ownerRecord(tenantId: string, repoUrl: string, hash: string): string {
  return `maka-setup v1 invite=${sha(tenantId)} repo=${sha(repoUrl)} setup=${hash}`;
}

const ownsPrefix = (description: string | undefined, tenantId: string, repoUrl: string): boolean =>
  description !== undefined &&
  description.startsWith(`maka-setup v1 invite=${sha(tenantId)} repo=${sha(repoUrl)} setup=`);

export class SnapshotOwnerError extends Error {}

/** The directory of a repository's checkout in a box. */
export function repoDir(repoUrl: string): string {
  return `${REPOS_ROOT}/${repoKey(repoUrl)}`;
}

/** Names a repository's checkout directory and the `maka.repo` label. */
export function repoKey(repoUrl: string): string {
  return sha(repoUrl).slice(0, 8);
}

export function assertCloneUrl(repoUrl: string): void {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error('the repository URL is not a URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    /\s/.test(repoUrl)
  ) {
    throw new Error('the repository URL must be https:// with no credentials');
  }
}

/**
 * Builds and keeps the per-repository setup snapshots (Amp's project snapshot): the repository's
 * `.agents/setup` runs once in a clean box and the box is saved as a snapshot named by the hash of
 * that setup; new boxes start from it. A changed setup is a new hash and a new snapshot; two builders
 * racing for the same name end with one snapshot and both use it; old ones are deleted.
 *
 * The builder box holds no credential: it clones a public repository over https and runs the
 * repository's own script, and HOME is part of the snapshot.
 */
export class SetupSnapshots {
  private readonly building = new Map<string, Promise<SetupSnapshot>>();

  constructor(private readonly options: SetupSnapshotsOptions) {}

  async ensure(recipe: SetupRecipe): Promise<SetupSnapshot> {
    assertCloneUrl(recipe.repoUrl);
    if (!/^[0-9a-f]{40}$/.test(recipe.ref)) throw new Error('the ref must be a full commit sha');
    const hash = setupHash(recipe);
    const name = snapshotName(recipe.tenantId, recipe.repoUrl, hash);
    // Callers in this process share one build; another process is met at the snapshot's name.
    let pending = this.building.get(name);
    if (!pending) {
      pending = this.obtain(recipe, hash, name).finally(() => this.building.delete(name));
      this.building.set(name, pending);
    }
    return await pending;
  }

  private async obtain(recipe: SetupRecipe, hash: string, name: string): Promise<SetupSnapshot> {
    const { api } = this.options;
    const existing = (await api.listSnapshots()).find((snapshot) => snapshot.name === name);
    if (existing) {
      this.assertOwned(existing, recipe, hash);
      if (existing.status === 'ready')
        return {
          snapshotId: existing.id,
          tenantId: recipe.tenantId,
          setupHash: hash,
          repo: repoKey(recipe.repoUrl),
          name,
          built: false,
        };
      if (existing.status === 'pending') {
        // Another builder is uploading it.
        const done = await api.waitForSnapshot(existing.id);
        return {
          snapshotId: done.id,
          tenantId: recipe.tenantId,
          setupHash: hash,
          repo: repoKey(recipe.repoUrl),
          name,
          built: false,
        };
      }
      await api.deleteSnapshot(existing.id);
    }
    const built = await this.build(recipe, hash, name);
    await this.expire(recipe).catch((error) =>
      this.options.onWarning?.('could not delete old setup snapshots', error),
    );
    return built;
  }

  private async build(recipe: SetupRecipe, hash: string, name: string): Promise<SetupSnapshot> {
    const { api, agent } = this.options;
    if (recipe.setupScript !== undefined && agent === undefined) {
      throw new SetupFailedError(
        '.agents/setup',
        'no unprivileged agent account is configured, so no repository script is run',
      );
    }
    const box = await this.options.boxes.lease({
      tenantId: recipe.tenantId,
      job: `setup-${hash.slice(0, 12)}`,
    });
    try {
      await this.options.guard(box.machineId);
      await this.run(box.machineId, 'checkout', checkoutScript(), {
        MAKA_REPO_URL: recipe.repoUrl,
        MAKA_REF: recipe.ref,
        MAKA_REPO_DIR: repoDir(recipe.repoUrl),
        ...(agent === undefined ? {} : { MAKA_AGENT_GROUP: agent.group }),
        ...(recipe.setupScript === undefined
          ? {}
          : { MAKA_SETUP_SHA256: sha(recipe.setupScript), MAKA_HAS_SETUP: '1' }),
      });
      for (const [index, command] of recipe.prepare.entries()) {
        await this.run(box.machineId, `prepare step ${index + 1}`, command, {});
      }
      if (recipe.setupScript !== undefined && agent !== undefined) {
        await this.checkAgent(box.machineId, agent);
        await this.run(
          box.machineId,
          '.agents/setup',
          asRepoUser('cd "$MAKA_REPO_DIR" && exec ./.agents/setup', agent),
          { MAKA_REPO_DIR: repoDir(recipe.repoUrl), MAKA_SETUP_HASH: hash },
          this.options.setupTimeoutSeconds ?? DEFAULT_SETUP_TIMEOUT_SECONDS,
        );
      }
      // The snapshot is the whole disk and every box of the invite boots from it: take credentials,
      // history, transcripts and other tasks' folders off it, then look again and refuse if any is left.
      const scrubEnv = {
        MAKA_REPO_DIR: repoDir(recipe.repoUrl),
        ...(agent === undefined ? {} : { MAKA_AGENT_USER: agent.user }),
      };
      await this.run(box.machineId, 'scrub', SCRUB_SCRIPT, {
        ...scrubEnv,
        MAKA_SCRUB_MODE: 'clean',
      });
      await this.run(box.machineId, 'scrub check', SCRUB_SCRIPT, {
        ...scrubEnv,
        MAKA_SCRUB_MODE: 'check',
      });
      await this.run(box.machineId, 'sync', 'sync', {});
      let snapshotId: string;
      try {
        const snapshot = await api.createSnapshot(box.machineId, {
          name,
          description: ownerRecord(recipe.tenantId, recipe.repoUrl, hash),
        });
        snapshotId = snapshot.id;
      } catch (error) {
        // Someone else saved a snapshot of this setup first: use theirs, ours is not needed.
        if ((error as { status?: number }).status !== 409) throw error;
        const winner = (await api.listSnapshots()).find((snapshot) => snapshot.name === name);
        if (!winner) throw error;
        this.assertOwned(winner, recipe, hash);
        const done = await api.waitForSnapshot(winner.id);
        return {
          snapshotId: done.id,
          tenantId: recipe.tenantId,
          setupHash: hash,
          repo: repoKey(recipe.repoUrl),
          name,
          built: false,
        };
      }
      const ready = await api.waitForSnapshot(snapshotId);
      return {
        snapshotId: ready.id,
        tenantId: recipe.tenantId,
        setupHash: hash,
        repo: repoKey(recipe.repoUrl),
        name,
        built: true,
      };
    } finally {
      await Promise.resolve(box.release()).catch((error) =>
        this.options.onWarning?.(`could not give back builder box ${box.machineId}`, error),
      );
    }
  }

  private async checkAgent(machineId: string, agent: AgentChannel): Promise<void> {
    let result: InstaboxExecResult;
    try {
      result = await this.options.api.exec(machineId, {
        cmd: AGENT_CHECK_SCRIPT,
        envs: { MAKA_AGENT_USER: agent.user },
        timeoutSeconds: STEP_TIMEOUT_SECONDS,
      });
    } catch (error) {
      throw new SetupFailedError(
        'agent check',
        error instanceof Error ? error.message : String(error),
      );
    }
    const problems = agentProblems(result.stdout);
    if (problems.length > 0) {
      throw new SetupFailedError('agent check', problems.join('; '));
    }
  }

  private assertOwned(snapshot: SnapshotRecord, recipe: SetupRecipe, hash: string): void {
    if (snapshot.description !== ownerRecord(recipe.tenantId, recipe.repoUrl, hash)) {
      throw new SnapshotOwnerError(
        `snapshot ${snapshot.name} belongs to another invite, repository or setup`,
      );
    }
  }

  private async run(
    machineId: string,
    step: string,
    cmd: string,
    envs: Record<string, string>,
    timeoutSeconds = STEP_TIMEOUT_SECONDS,
  ): Promise<void> {
    let result: InstaboxExecResult;
    try {
      result = await this.options.api.exec(machineId, { cmd, envs, timeoutSeconds });
    } catch (error) {
      throw new SetupFailedError(step, error instanceof Error ? error.message : String(error));
    }
    if (result.timedOut)
      throw new SetupFailedError(step, `it took longer than ${timeoutSeconds} s`);
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim();
      throw new SetupFailedError(step, `exit ${result.exitCode}: ${output.slice(-OUTPUT_TAIL)}`);
    }
  }

  /** Deletes this invite's older setup snapshots of the repository, keeping the newest few. */
  private async expire(recipe: SetupRecipe): Promise<void> {
    const prefix = repoPrefix(recipe.tenantId, recipe.repoUrl);
    const mine = (await this.options.api.listSnapshots())
      .filter(
        (snapshot) =>
          snapshot.name.startsWith(prefix) &&
          ownsPrefix(snapshot.description, recipe.tenantId, recipe.repoUrl),
      )
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    const keep = Math.max(1, this.options.keep ?? 2);
    for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
      await this.options.api.deleteSnapshot(old.id);
    }
  }
}

/**
 * Clones the repository at the ref, checked out detached, and checks that the setup script in it is
 * the one that was hashed. Parameters travel in the environment.
 */
function checkoutScript(): string {
  return `set -eu
command -v git >/dev/null 2>&1 || { echo "git is not installed in the box" >&2; exit 127; }
export GIT_TERMINAL_PROMPT=0
rm -rf -- "$MAKA_REPO_DIR"
mkdir -p -- "$(dirname -- "$MAKA_REPO_DIR")"
git clone --quiet --no-tags -- "$MAKA_REPO_URL" "$MAKA_REPO_DIR"
cd "$MAKA_REPO_DIR"
git checkout --quiet --detach "$MAKA_REF"
if [ "\${MAKA_HAS_SETUP:-}" = 1 ]; then
  [ -f .agents/setup ] || { echo ".agents/setup is missing at $MAKA_REF" >&2; exit 3; }
  [ "$(sha256sum < .agents/setup | cut -d' ' -f1)" = "$MAKA_SETUP_SHA256" ] \\
    || { echo ".agents/setup is not the script that was hashed" >&2; exit 4; }
  chmod +x .agents/setup
fi
# The agent's account runs the repository's scripts: the checkout is its group's, and it can walk to it.
if [ -n "\${MAKA_AGENT_GROUP:-}" ]; then
  chgrp -R -- "$MAKA_AGENT_GROUP" "$MAKA_REPO_DIR"
  chmod -R g+rwX -- "$MAKA_REPO_DIR"
  chmod 755 -- "$(dirname -- "$MAKA_REPO_DIR")"
fi
`;
}
