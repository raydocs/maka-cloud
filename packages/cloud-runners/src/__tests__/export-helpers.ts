import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunnerEvent, RunSpec } from '@maka-cloud/orchestrator';
import type { Harness } from './harness.js';

export type RunEvent = RunnerEvent;

/** A file in a task's workspace, which the sandbox (here: the same host) holds. */
export async function workspaceFile(
  h: Harness,
  taskId: string,
  rel: string,
  text: string,
): Promise<void> {
  const path = join(h.root, taskId, 'workspace', rel);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text);
}

/** The manifest the fake CLI writes in `custom` mode (`turn` 2: on a resumed turn). */
export async function fakeManifest(
  h: Harness,
  fields: { done?: string[]; artifacts?: string[] },
  turn: 1 | 2 = 1,
): Promise<void> {
  const manifest = {
    summary: 'fake run complete',
    done: fields.done ?? ['the brief'],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
    ...(fields.artifacts ? { artifacts: fields.artifacts } : {}),
  };
  await fs.writeFile(
    join(h.home, 'fake-cli', turn === 1 ? 'manifest.json' : 'manifest2.json'),
    JSON.stringify(manifest),
  );
}

export async function writeBrief(h: Harness, taskId: string, brief: string): Promise<void> {
  await fs.writeFile(join(h.handoff, taskId, 'brief.md'), brief);
}

/** The harness's spec for a task, with `brief` as its brief. */
export async function briefedSpec(h: Harness, taskId: string, brief: string): Promise<RunSpec> {
  const spec = await h.spec(taskId);
  await fs.writeFile(spec.briefPath, brief);
  return spec;
}
