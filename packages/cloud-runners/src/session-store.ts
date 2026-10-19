import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskId } from '@maka-cloud/orchestrator';
import type { RunnerSessionRecord, RunnerSessionStore } from './types.js';

export class MemorySessionStore implements RunnerSessionStore {
  private readonly records = new Map<TaskId, RunnerSessionRecord>();

  async get(taskId: TaskId): Promise<RunnerSessionRecord | undefined> {
    const record = this.records.get(taskId);
    return record && structuredClone(record);
  }

  async put(record: RunnerSessionRecord): Promise<void> {
    this.records.set(record.taskId, structuredClone(record));
  }

  async delete(taskId: TaskId): Promise<void> {
    this.records.delete(taskId);
  }

  async list(): Promise<RunnerSessionRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}

/** One JSON file, rewritten through a temp file and rename. Writes are serialized. */
export class JsonFileSessionStore implements RunnerSessionStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(taskId: TaskId): Promise<RunnerSessionRecord | undefined> {
    return (await this.load())[taskId];
  }

  async put(record: RunnerSessionRecord): Promise<void> {
    await this.mutate((all) => {
      all[record.taskId] = record;
    });
  }

  async delete(taskId: TaskId): Promise<void> {
    await this.mutate((all) => {
      delete all[taskId];
    });
  }

  async list(): Promise<RunnerSessionRecord[]> {
    return Object.values(await this.load());
  }

  private async load(): Promise<Record<TaskId, RunnerSessionRecord>> {
    await this.chain.catch(() => undefined);
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<TaskId, RunnerSessionRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private mutate(change: (all: Record<TaskId, RunnerSessionRecord>) => void): Promise<void> {
    const next = this.chain
      .catch(() => undefined)
      .then(async () => {
        let all: Record<TaskId, RunnerSessionRecord> = {};
        try {
          all = JSON.parse(await readFile(this.path, 'utf8')) as Record<
            TaskId,
            RunnerSessionRecord
          >;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        change(all);
        await mkdir(dirname(this.path), { recursive: true });
        const temp = `${this.path}.tmp`;
        await writeFile(temp, JSON.stringify(all), { mode: 0o600 });
        await rename(temp, this.path);
      });
    this.chain = next;
    return next;
  }
}

/** Every snapshot some record still points at. Retention must never delete these. */
export function referencedSnapshotIds(records: Iterable<RunnerSessionRecord>): Set<string> {
  const ids = new Set<string>();
  for (const record of records) for (const id of record.snapshotIds) ids.add(id);
  return ids;
}
