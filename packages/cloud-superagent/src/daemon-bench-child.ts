import { rm } from 'node:fs/promises';
import { BoxDaemon, type DaemonBox } from './box-daemon.js';
import { FakeSandbox } from './sandbox.js';

/**
 * Child process for `runDaemonBench`. Hosts one `BoxDaemon` with the worker
 * sessions named on the command line (all N workers in shared mode, one worker
 * in per-process mode) and answers IPC messages from the bench parent.
 */

export type BenchChildRequest =
  | { type: 'wake'; workerId: string }
  | { type: 'attach'; workerId: string }
  | { type: 'detach'; workerId: string }
  | { type: 'exit' };

export type BenchChildReply =
  | { type: 'ready'; workers: number }
  | { type: 'woke'; workerId: string; exitCode: number; stdout: string }
  | { type: 'attached'; workerId: string }
  | { type: 'detached'; workerId: string };

const TENANT = 'tnt_bench';

/**
 * One worker turn, scaled down: write a file in the worker's work dir and read
 * it back through the daemon (the path every worker tool call takes). A real
 * turn also waits on a model; that cost is the same in both modes and is left out.
 */
export const BENCH_WORK_CMD = 'echo wake > note.txt && cat note.txt';

function main(): void {
  const workerIds = process.argv.slice(2);
  const sandbox = new FakeSandbox();
  const box: DaemonBox = {
    exec: (tenantId, workerId, request) =>
      sandbox.exec(tenantId, { ...request, cwd: request.cwd ?? `work/${workerId}` }),
  };
  const daemon = new BoxDaemon({ tenantId: TENANT, box });
  for (const id of workerIds) daemon.attach(id);

  const reply = (message: BenchChildReply): void => {
    process.send?.(message);
  };

  process.on('message', (raw: BenchChildRequest) => {
    void (async () => {
      switch (raw.type) {
        case 'wake': {
          const result = await daemon.exec(raw.workerId, { cmd: BENCH_WORK_CMD });
          reply({
            type: 'woke',
            workerId: raw.workerId,
            exitCode: result.exitCode,
            stdout: result.stdout.trim(),
          });
          return;
        }
        case 'attach':
          daemon.attach(raw.workerId);
          reply({ type: 'attached', workerId: raw.workerId });
          return;
        case 'detach':
          daemon.detach(raw.workerId);
          reply({ type: 'detached', workerId: raw.workerId });
          return;
        case 'exit':
          await Promise.all(
            [...sandbox.roots.values()].map((dir) => rm(dir, { recursive: true, force: true })),
          );
          process.exit(0);
      }
    })();
  });

  reply({ type: 'ready', workers: daemon.size });
}

main();
