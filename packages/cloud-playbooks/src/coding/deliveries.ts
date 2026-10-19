import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One changed file, as git would commit it. */
export type ChangedFile =
  | {
      path: string;
      status: 'added' | 'modified';
      mode: '100644' | '100755';
      blobSha: string;
      contentBase64: string;
    }
  | { path: string; status: 'deleted' };

/** `changes.json`: everything needed to commit the change on top of the base commit elsewhere. */
export interface ChangeSet {
  repo: string;
  baseSha: string;
  files: ChangedFile[];
}

export interface PublishedPullRequest {
  url: string;
  number: number;
  branch: string;
}

/** A verified change, ready to become a pull request once the user approves. */
export interface Delivery {
  taskId: string;
  repo: string;
  /** The branch or commit the task started from, as the brief named it. */
  baseRef: string;
  baseSha: string;
  /** Host path of `changes.json`. */
  changesPath: string;
  /** sha256 of `changes.json` when it was recorded. */
  changesSha256: string;
  /** Host path of `verification.json`. */
  verificationPath: string;
  publishedPr?: PublishedPullRequest;
}

/** Shared by the coding runner, which records deliveries, and the pull request tool. */
export interface CodingDeliveries {
  record(delivery: Delivery): Promise<void>;
  get(taskId: string): Promise<Delivery | undefined>;
  markPublished(taskId: string, pr: PublishedPullRequest): Promise<void>;
}

export class MemoryCodingDeliveries implements CodingDeliveries {
  private readonly items = new Map<string, Delivery>();

  async record(delivery: Delivery): Promise<void> {
    this.items.set(delivery.taskId, structuredClone(delivery));
  }

  async get(taskId: string): Promise<Delivery | undefined> {
    const item = this.items.get(taskId);
    return item && structuredClone(item);
  }

  async markPublished(taskId: string, pr: PublishedPullRequest): Promise<void> {
    const item = this.items.get(taskId);
    if (!item) throw new Error(`no delivery for ${taskId}`);
    item.publishedPr = { ...pr };
  }
}

/** Deliveries in one JSON file, rewritten atomically; one process owns it. */
export class JsonFileCodingDeliveries implements CodingDeliveries {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  record(delivery: Delivery): Promise<void> {
    return this.update((all) => {
      all[delivery.taskId] = delivery;
    });
  }

  async get(taskId: string): Promise<Delivery | undefined> {
    await this.chain.catch(() => undefined);
    return (await this.load())[taskId];
  }

  markPublished(taskId: string, pr: PublishedPullRequest): Promise<void> {
    return this.update((all) => {
      const item = all[taskId];
      if (!item) throw new Error(`no delivery for ${taskId}`);
      item.publishedPr = pr;
    });
  }

  private update(change: (all: Record<string, Delivery>) => void): Promise<void> {
    const run = this.chain
      .catch(() => undefined)
      .then(async () => {
        const all = await this.load();
        change(all);
        await mkdir(dirname(this.path), { recursive: true });
        const temp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(all), { flag: 'wx', mode: 0o600 });
          await rename(temp, this.path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      });
    this.chain = run;
    return run;
  }

  private async load(): Promise<Record<string, Delivery>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, Delivery>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}
