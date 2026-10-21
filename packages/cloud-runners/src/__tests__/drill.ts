import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryTaskStore,
  Orchestrator,
  RunnerRegistry,
  type RunSpec,
  type TaskId,
} from '@maka-cloud/orchestrator';
import { exists, type Harness, until } from './harness.js';
import { sdkSetup } from './sdk-harness.js';

export const fakeFile = (h: Harness, name: string) => join(h.home, 'fake-cli', name);

export async function lines(path: string): Promise<string[]> {
  return (await fs.readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);
}

/**
 * The drill: the process that drives a task dies inside a step that must never run twice, while the
 * step's child lives on in a process group and session of its own. Everything is real but the
 * model: the Agent SDK, the CLI's hooks, the step log, the sandbox's process groups. The scripted
 * CLI (`call Read`, then `call Bash` that starts the child and stays in it) is `tools.json`.
 *
 * The first orchestrator is the process that "died": it is left running over the same log, as a
 * driver that lost its lease would be, and the second takes over the log and the sandbox.
 */
export async function crashInsideNeverStep(t: { after(fn: () => Promise<void>): void }) {
  const h = await sdkSetup(t);
  const go = join(h.home, 'go');
  const late = join(h.home, 'late.log');
  await h.setMode('tools');
  await fs.writeFile(
    fakeFile(h, 'tools.json'),
    JSON.stringify([
      { id: 'read-1', name: 'Read', input: { file_path: '/work/a.txt' } },
      {
        id: 'deploy-1',
        name: 'Bash',
        input: { command: 'deploy --now' },
        spawn: `while [ ! -e ${go} ]; do sleep 0.05; done; echo late >> ${late}`,
        hang: true,
      },
    ]),
  );
  const store = new MemoryTaskStore();
  const handoffRoot = await fs.mkdtemp(join(tmpdir(), 'runners-drill-'));
  t.after(() => fs.rm(handoffRoot, { recursive: true, force: true }));

  const specs: RunSpec[] = [];
  const spied = h.runners.runners.map((runner) =>
    Object.assign(Object.create(runner), {
      start: async (spec: RunSpec) => {
        specs.push(spec);
        return runner.start(spec);
      },
    }),
  );
  const first = await Orchestrator.create({
    store,
    runners: new RunnerRegistry(spied),
    handoffRoot,
  });
  t.after(async () => first.close());
  const info = first.authenticate(first.issueSession().token);
  if (!info) throw new Error('no session');
  const started = await first.delegate(info, { runner: 'claude-agent-sdk', brief: 'deploy it' });
  const taskId: TaskId = started.taskId;

  // The CLI is inside the deploy step, whose intent was recorded before it began, and its child runs.
  await until(
    async () =>
      (await lines(fakeFile(h, 'ran.log'))).includes('deploy-1') &&
      (await exists(fakeFile(h, 'child.pid'))),
    20_000,
  );
  const childPid = Number(await fs.readFile(fakeFile(h, 'child.pid'), 'utf8'));
  t.after(async () => {
    for (const target of [-childPid, childPid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  const restarted = h.makeRunners();
  // The box check needs a second account; it has its own tests (as in sdkSetup).
  restarted.fleet.ensureAgentIsolation = async () => undefined;
  const second = await Orchestrator.create({
    store,
    runners: new RunnerRegistry(restarted.runners),
    handoffRoot,
  });
  t.after(async () => second.close());
  return { h, store, first, second, info, taskId, specs, childPid, go, late };
}
