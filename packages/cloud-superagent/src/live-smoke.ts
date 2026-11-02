import {
  HttpSandbox,
  InstaboxCredentialsError,
  SMALLEST_SANDBOX,
  instaboxApiFromEnv,
  instaboxCreateSourceFromEnv,
} from './sandbox.js';

export const LIVE_SMOKE_CMD = 'echo live-smoke';

export interface LiveSmokeTimings {
  createMs: number;
  execMs: number;
  deleteMs: number;
  totalMs: number;
}

export interface LiveSmokeReport {
  ok: boolean;
  machineId: string | null;
  created: boolean;
  destroyed: boolean;
  execExit: number | null;
  stdout: string;
  timings: LiveSmokeTimings;
  error?: string;
}

export interface LiveSmokeOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Replace a secret in any string we print. Never log the raw key. */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('<redacted>');
}

export async function runLiveSmoke(options: LiveSmokeOptions = {}): Promise<LiveSmokeReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const started = now();
  let apiKey = '';
  const timings: LiveSmokeTimings = { createMs: 0, execMs: 0, deleteMs: 0, totalMs: 0 };
  const report: LiveSmokeReport = {
    ok: false,
    machineId: null,
    created: false,
    destroyed: false,
    execExit: null,
    stdout: '',
    timings,
  };

  const api = instaboxApiFromEnv(env);
  apiKey = api.apiKey;
  const source = instaboxCreateSourceFromEnv(env);
  let client: HttpSandbox | undefined;
  try {
    client = new HttpSandbox({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      fetch: options.fetch ?? fetch,
    });
    const name = `maka-smoke-${started}`;
    const createStarted = now();
    const created = await client.createMachine({
      name,
      ...source,
      desiredState: 'running',
      vcpus: SMALLEST_SANDBOX.vcpus,
      memMiB: SMALLEST_SANDBOX.memMiB,
      metadata: { 'maka.purpose': 'live-smoke' },
    });
    if (created.machineId) {
      report.machineId = created.machineId;
      report.created = true;
    }
    const settled =
      created.state === 'succeeded' ? created : await client.waitForOperation(created.id);
    timings.createMs = now() - createStarted;
    const machineId = settled.machineId ?? created.machineId;
    if (!machineId) throw new Error('instabox create returned no machineId.');
    report.machineId = machineId;
    report.created = true;
    await client.ensureRunning(machineId);

    const execStarted = now();
    const ran = await client.exec(machineId, { cmd: LIVE_SMOKE_CMD });
    timings.execMs = now() - execStarted;
    report.execExit = ran.exitCode;
    report.stdout = ran.stdout.trim();
    if (ran.exitCode !== 0) {
      throw new Error(`exec ${LIVE_SMOKE_CMD} exited ${ran.exitCode}`);
    }
    report.ok = true;
  } catch (error) {
    report.error = redactSecret(
      error instanceof Error ? error.message : 'live-smoke failed',
      apiKey || env.INSTABOX_API_KEY?.trim() || '',
    );
  } finally {
    if (report.machineId) {
      const deleteStarted = now();
      try {
        const deleted = await client!.deleteMachine(report.machineId);
        if (deleted.state !== 'succeeded' && deleted.id) {
          await client!.waitForOperation(deleted.id);
        }
        report.destroyed = true;
      } catch (error) {
        const extra = redactSecret(
          error instanceof Error ? error.message : 'delete failed',
          apiKey || env.INSTABOX_API_KEY?.trim() || '',
        );
        report.destroyed = false;
        report.ok = false;
        report.error = report.error ? `${report.error}; destroy failed: ${extra}` : extra;
      }
      timings.deleteMs = now() - deleteStarted;
    }
    timings.totalMs = now() - started;
  }
  return report;
}

export function formatLiveSmokeReport(report: LiveSmokeReport): string {
  const lines = [
    `ok: ${report.ok}`,
    `machine: ${report.machineId ?? '(none)'}`,
    `created: ${report.created}`,
    `destroyed: ${report.destroyed}`,
    `exec: ${LIVE_SMOKE_CMD} exit=${report.execExit ?? 'n/a'} stdout=${JSON.stringify(report.stdout)}`,
    `timings_ms: create=${report.timings.createMs} exec=${report.timings.execMs} delete=${report.timings.deleteMs} total=${report.timings.totalMs}`,
    `size: ${SMALLEST_SANDBOX.vcpus} vCPU / ${SMALLEST_SANDBOX.memMiB} MiB`,
  ];
  if (report.error) lines.push(`error: ${report.error}`);
  return lines.join('\n');
}

export async function runLiveSmokeCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const key = env.INSTABOX_API_KEY?.trim() ?? '';
  try {
    const report = await runLiveSmoke({ env });
    console.log(redactSecret(formatLiveSmokeReport(report), key));
    return report.ok && report.destroyed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'live-smoke failed';
    console.error(redactSecret(message, key));
    return error instanceof InstaboxCredentialsError ? 2 : 1;
  }
}
