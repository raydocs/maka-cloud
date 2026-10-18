import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstaboxClient } from '../client.js';
import { InstaboxWorkspaceExecutor } from '../executor.js';
import { FakeInstabox, type FakeInstaboxOptions } from './fake-instabox.js';

export interface Harness {
  fake: FakeInstabox;
  client: InstaboxClient;
  executor: InstaboxWorkspaceExecutor;
  /** Temp root holding `work` (the session cwd) and `outside` (not part of the workspace). */
  root: string;
  work: string;
  outside: string;
  sleeps: number[];
  cleanup(): Promise<void>;
}

export async function setup(options: FakeInstaboxOptions = {}): Promise<Harness> {
  const fake = await new FakeInstabox(options).start();
  const sleeps: number[] = [];
  const client = new InstaboxClient({
    apiKey: fake.apiKey,
    baseUrl: fake.url,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  const executor = new InstaboxWorkspaceExecutor({ client, machineId: fake.machineId });
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'instabox-test-')));
  const work = join(root, 'work');
  const outside = join(root, 'outside');
  await fs.mkdir(work);
  await fs.mkdir(outside);
  return {
    fake,
    client,
    executor,
    root,
    work,
    outside,
    sleeps,
    async cleanup() {
      await fake.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
